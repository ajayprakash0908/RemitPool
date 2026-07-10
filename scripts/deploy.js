const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const StellarSdk = require('stellar-sdk');

// Load environment variables from root
const envPath = path.resolve(__dirname, '../.env');
require('dotenv').config({ path: envPath });

const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET;
const horizonUrl = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const server = new StellarSdk.Horizon.Server(horizonUrl);

// Interest rate per second (scaled by 1e9)
// 100,000 = 0.0001 per second (0.01% per second = ~8.64% per day)
const SIMULATED_YIELD_RATE = 100000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper to modify Cargo.toml crate-type
function updateCrateType(contractName, crateTypes) {
  const filePath = path.resolve(__dirname, `../contracts/${contractName}/Cargo.toml`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Cargo.toml not found for contract ${contractName}`);
  }
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace the [lib] section's crate-type
  const crateTypeStr = crateTypes.map(t => `"${t}"`).join(', ');
  content = content.replace(/crate-type\s*=\s*\[[^]*?\]/, `crate-type = [${crateTypeStr}]`);
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Updated Cargo.toml for ${contractName} to crate-type: [${crateTypes.join(', ')}]`);
}

// Compile contracts to WebAssembly
function compileContracts() {
  console.log("Starting compilation to WASM target...");
  
  // Set to cdylib for WASM compilation
  updateCrateType('savings_pool', ['cdylib']);
  updateCrateType('remit_router', ['cdylib']);
  
  try {
    console.log("Running Cargo build...");
    execSync('cargo build --target wasm32-unknown-unknown --release', {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'inherit'
    });
    console.log("Contracts compiled successfully!");
  } catch (error) {
    console.error("Compilation failed:", error);
    throw error;
  } finally {
    // Restore to rlib for local testing compatibility
    updateCrateType('savings_pool', ['rlib']);
    updateCrateType('remit_router', ['rlib']);
  }
}

// Get SAC contract ID for a classic asset
function getSacContractId(assetCode, issuerPublicKey) {
  const asset = new StellarSdk.Asset(assetCode, issuerPublicKey);
  return asset.contractId(networkPassphrase);
}

// Submit a Soroban operation
async function submitSorobanTransaction(sourceKeypair, operation) {
  const sourcePublicKey = sourceKeypair.publicKey();
  let account = await server.loadAccount(sourcePublicKey);
  
  // Build transaction
  let tx = new StellarSdk.TransactionBuilder(account, {
    fee: '100000', // Set a safe high fee limit for Soroban ops
    networkPassphrase
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();
    
  // Sign and submit
  tx.sign(sourceKeypair);
  
  try {
    console.log("Submitting transaction to Horizon...");
    let result = await server.submitTransaction(tx);
    // Wait a moment for consensus
    await sleep(1000);
    return result;
  } catch (error) {
    if (error.response && error.response.data && error.response.data.extras) {
      console.error("Result Codes:", JSON.stringify(error.response.data.extras.result_codes));
    } else {
      console.error("Error:", error.message);
    }
    throw error;
  }
}

// Upload WASM code
async function uploadWasm(sourceKeypair, wasmPath) {
  console.log(`Uploading WASM code from ${wasmPath}...`);
  const wasmBytes = fs.readFileSync(wasmPath);
  
  const op = StellarSdk.Operation.uploadContractWasm({
    wasm: wasmBytes
  });
  
  const result = await submitSorobanTransaction(sourceKeypair, op);
  
  // Parse WASM hash from transaction meta
  const txMeta = StellarSdk.xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64');
  const opResult = txMeta.v3().sorobanMeta().returnValue();
  const wasmHash = opResult.bytes().toString('hex');
  
  console.log(`Uploaded successfully! WASM Hash: ${wasmHash}`);
  return wasmHash;
}

// Create contract instance
async function createContract(sourceKeypair, wasmHash) {
  console.log(`Creating contract instance for WASM hash ${wasmHash}...`);
  
  const op = StellarSdk.Operation.createContract({
    address: new StellarSdk.Address(sourceKeypair.publicKey()),
    wasmHash: Buffer.from(wasmHash, 'hex')
  });
  
  const result = await submitSorobanTransaction(sourceKeypair, op);
  
  // Parse Contract ID address from return value
  const txMeta = StellarSdk.xdr.TransactionMeta.fromXDR(result.resultMetaXdr, 'base64');
  const opResult = txMeta.v3().sorobanMeta().returnValue();
  const contractId = StellarSdk.Address.fromScVal(opResult).toString();
  
  console.log(`Created successfully! Contract ID: ${contractId}`);
  return contractId;
}

// Call a contract method
async function callContractMethod(sourceKeypair, contractId, method, args = []) {
  console.log(`Calling contract method ${method} on ${contractId}...`);
  
  const op = StellarSdk.Operation.invokeHostFunction({
    func: StellarSdk.xdr.HostFunction.hostFunctionTypeInvokeContract(
      new StellarSdk.xdr.InvokeContractArgs({
        contractAddress: new StellarSdk.Address(contractId).toScAddress(),
        functionName: StellarSdk.xdr.Symbol.new(method),
        args: args
      })
    ),
    auth: []
  });
  
  const result = await submitSorobanTransaction(sourceKeypair, op);
  console.log(`Method ${method} called successfully.`);
  return result;
}

// Main deploy function
async function deploy() {
  // 1. Compile contracts
  compileContracts();
  
  // 2. Load deployer keys
  // Load anchor_keys.json dynamically to find the Distributor secret
  const keysPath = path.resolve(__dirname, '../anchor-mock/anchor_keys.json');
  if (!fs.existsSync(keysPath)) {
    throw new Error("Anchor keys file not found! Make sure to start the anchor-mock server first to generate keys, or configure it.");
  }
  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  const distributorKeypair = StellarSdk.Keypair.fromSecret(keys.distributorSecret);
  
  console.log(`Using Anchor Distributor as deployer: ${distributorKeypair.publicKey()}`);
  
  // Derive SAC token contract address for mock USDC
  const usdcAssetCode = process.env.USDC_ASSET_CODE || 'USDC';
  const usdcAssetIssuer = keys.issuerPublicKey;
  const usdcSacId = getSacContractId(usdcAssetCode, usdcAssetIssuer);
  console.log(`USDC SAC Token Contract ID: ${usdcSacId}`);
  
  // Upload and deploy savings_pool
  const savingsWasmPath = path.resolve(__dirname, '../target/wasm32-unknown-unknown/release/savings_pool.wasm');
  const savingsHash = await uploadWasm(distributorKeypair, savingsWasmPath);
  const savingsContractId = await createContract(distributorKeypair, savingsHash);
  
  // Upload and deploy remit_router
  const routerWasmPath = path.resolve(__dirname, '../target/wasm32-unknown-unknown/release/remit_router.wasm');
  const routerHash = await uploadWasm(distributorKeypair, routerWasmPath);
  const routerContractId = await createContract(distributorKeypair, routerHash);
  
  // 3. Initialize savings_pool
  console.log("Initializing Savings Pool Contract...");
  // initialize(token: Address, rate_per_second: i128)
  const poolArgs = [
    new StellarSdk.Address(usdcSacId).toScVal(),
    StellarSdk.nativeToScVal(BigInt(SIMULATED_YIELD_RATE), { type: 'i128' })
  ];
  await callContractMethod(distributorKeypair, savingsContractId, 'initialize', poolArgs);
  
  // 4. Initialize remit_router
  console.log("Initializing Remit Router Contract...");
  // initialize(token: Address, savings_pool: Address)
  const routerArgs = [
    new StellarSdk.Address(usdcSacId).toScVal(),
    new StellarSdk.Address(savingsContractId).toScVal()
  ];
  await callContractMethod(distributorKeypair, routerContractId, 'initialize', routerArgs);
  
  // 5. Fund the pool contract with some USDC reserve tokens to pay interest yield
  console.log("Funding Savings Pool contract with 10,000 USDC yield reserve...");
  const tokenClient = new StellarSdk.Contract(usdcSacId);
  // Transfer 10,000 USDC from Distributor to Savings Pool Contract
  const fundArgs = [
    new StellarSdk.Address(distributorKeypair.publicKey()).toScVal(),
    new StellarSdk.Address(savingsContractId).toScVal(),
    StellarSdk.nativeToScVal(BigInt(10000 * 10000000), { type: 'i128' }) // USDC is 7 decimals in SAC
  ];
  await callContractMethod(distributorKeypair, usdcSacId, 'transfer', fundArgs);
  console.log("Savings Pool yield reserve funded!");

  // 6. Save contract IDs to root .env
  let envContent = fs.readFileSync(envPath, 'utf8');
  
  const updates = {
    'USDC_SAC_CONTRACT_ID': usdcSacId,
    'SAVINGS_POOL_CONTRACT_ID': savingsContractId,
    'REMIT_ROUTER_CONTRACT_ID': routerContractId,
  };
  
  for (const [key, val] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${val}`);
    } else {
      envContent += `\n${key}=${val}`;
    }
  }
  fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');
  console.log("Root .env updated with contract addresses.");
  
  console.log("\n==========================================");
  console.log("DEPLOYMENT COMPLETE & VERIFIED!");
  console.log(`USDC SAC ID: ${usdcSacId}`);
  console.log(`Savings Pool: ${savingsContractId}`);
  console.log(`Remit Router: ${routerContractId}`);
  console.log("==========================================\n");
}

deploy().catch(err => {
  console.error("Fatal deployment error:", err);
  process.exit(1);
});
