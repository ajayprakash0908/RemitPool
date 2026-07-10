const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const StellarSdk = require('@stellar/stellar-sdk');

// Load environment variables from root
const envPath = path.resolve(__dirname, '../.env');
require('dotenv').config({ path: envPath });

const networkPassphrase = process.env.STELLAR_NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET;
const rpcUrl = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const rpc = new StellarSdk.rpc.Server(rpcUrl);

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
  
  const crateTypeStr = crateTypes.map(t => `"${t}"`).join(', ');
  content = content.replace(/crate-type\s*=\s*\[[^]*?\]/, `crate-type = [${crateTypeStr}]`);
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Updated Cargo.toml for ${contractName} to crate-type: [${crateTypes.join(', ')}]`);
}

// Compile contracts to WebAssembly
function compileContracts() {
  console.log("Starting compilation to WASM target...");
  
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
    updateCrateType('savings_pool', ['rlib']);
    updateCrateType('remit_router', ['rlib']);
  }
}

// Get SAC contract ID for a classic asset
function getSacContractId(assetCode, issuerPublicKey) {
  const asset = new StellarSdk.Asset(assetCode, issuerPublicKey);
  return asset.contractId(networkPassphrase);
}

// Submit a Soroban transaction through RPC
async function submitSorobanTransaction(sourceKeypair, operation) {
  const sourcePublicKey = sourceKeypair.publicKey();
  
  // Load account info from RPC
  console.log(`Loading account ${sourcePublicKey} from RPC...`);
  const accountResult = await rpc.getAccount(sourcePublicKey);
  
  // Build transaction with default base fee
  let tx = new StellarSdk.TransactionBuilder(accountResult, {
    fee: '100', // placeholder, will be overridden by prepareTransaction
    networkPassphrase
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();
    
  // 1. Simulate transaction to find footprint and fee
  console.log("Simulating transaction on Soroban RPC...");
  const sim = await rpc.simulateTransaction(tx);
  if (sim.error) {
    console.error("Simulation error response:", JSON.stringify(sim, null, 2));
    throw new Error(`Simulation failed: ${sim.error}`);
  }
  
  // 2. Prepare transaction (appends simulated resources and fees)
  console.log("Preparing transaction...");
  tx = await rpc.prepareTransaction(tx, sim);
  
  // 3. Sign transaction
  tx.sign(sourceKeypair);
  
  // 4. Send transaction
  console.log("Sending transaction to network...");
  let response = await rpc.sendTransaction(tx);
  if (response.status === 'ERROR') {
    throw new Error(`Send failed: ${JSON.stringify(response.errorResult)}`);
  }
  
  const txHash = response.hash;
  console.log(`Transaction submitted. Hash: ${txHash}. Waiting for inclusion...`);
  
  // 5. Poll for transaction result
  console.log("Polling transaction status...");
  while (true) {
    const txStatus = await rpc.getTransaction(txHash);
    const status = txStatus.status;
    
    if (status === 'SUCCESS') {
      console.log("Transaction successfully confirmed on-chain.");
      return txStatus;
    } else if (status === 'FAILED') {
      console.error("Transaction failed result:", JSON.stringify(txStatus, null, 2));
      throw new Error(`Transaction failed on-chain.`);
    }
    
    console.log(`Transaction status: ${status}. Retrying in 2 seconds...`);
    await sleep(2000);
  }
}

function getSorobanReturnValue(resultMeta) {
  const arm = resultMeta.arm();
  let sorobanMeta;
  if (arm === 'v3') {
    sorobanMeta = resultMeta.v3().sorobanMeta();
  } else if (arm === 'v4') {
    sorobanMeta = resultMeta.v4().sorobanMeta();
  } else if (arm === 'v2') {
    sorobanMeta = resultMeta.v2().sorobanMeta();
  } else if (arm === 'v1') {
    sorobanMeta = resultMeta.v1().sorobanMeta();
  } else {
    throw new Error(`Unsupported TransactionMeta arm: ${arm}`);
  }
  return sorobanMeta.returnValue();
}

// Upload WASM code
async function uploadWasm(sourceKeypair, wasmPath) {
  console.log(`Uploading WASM code from ${wasmPath}...`);
  const wasmBytes = fs.readFileSync(wasmPath);
  
  const op = StellarSdk.Operation.uploadContractWasm({
    wasm: wasmBytes
  });
  
  const txStatus = await submitSorobanTransaction(sourceKeypair, op);
  
  // Parse WASM hash from transaction meta
  const opResult = getSorobanReturnValue(txStatus.resultMetaXdr);
  const wasmHash = opResult.bytes().toString('hex');
  
  console.log(`Uploaded successfully! WASM Hash: ${wasmHash}`);
  return wasmHash;
}

// Create contract instance
async function createContract(sourceKeypair, wasmHash) {
  console.log(`Creating contract instance for WASM hash ${wasmHash}...`);
  
  const op = StellarSdk.Operation.createCustomContract({
    address: new StellarSdk.Address(sourceKeypair.publicKey()),
    wasmHash: Buffer.from(wasmHash, 'hex')
  });
  
  const txStatus = await submitSorobanTransaction(sourceKeypair, op);
  
  // Parse Contract ID address from return value
  const opResult = getSorobanReturnValue(txStatus.resultMetaXdr);
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
        functionName: method,
        args: args
      })
    ),
    auth: []
  });
  
  const txStatus = await submitSorobanTransaction(sourceKeypair, op);
  console.log(`Method ${method} called successfully.`);
  return txStatus;
}

// Main deploy function
async function deploy() {
  // 1. Compile contracts
  compileContracts();
  
  // 2. Load deployer keys
  const keysPath = path.resolve(__dirname, '../anchor-mock/anchor_keys.json');
  if (!fs.existsSync(keysPath)) {
    throw new Error("Anchor keys file not found! Start anchor-mock first.");
  }
  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  const distributorKeypair = StellarSdk.Keypair.fromSecret(keys.distributorSecret);
  
  console.log(`Using Anchor Distributor as deployer: ${distributorKeypair.publicKey()}`);
  
  // Derive SAC token contract address for mock USDC
  const usdcAssetCode = process.env.USDC_ASSET_CODE || 'USDC';
  const usdcAssetIssuer = keys.issuerPublicKey;
  const usdcSacId = getSacContractId(usdcAssetCode, usdcAssetIssuer);
  console.log(`USDC SAC Token Contract ID: ${usdcSacId}`);
  
  // Deploy SAC for mock USDC if not already done
  try {
    console.log(`Attempting to deploy Stellar Asset Contract (SAC) for mock USDC...`);
    const asset = new StellarSdk.Asset(usdcAssetCode, usdcAssetIssuer);
    const op = StellarSdk.Operation.createStellarAssetContract({ asset });
    await submitSorobanTransaction(distributorKeypair, op);
    console.log(`SAC deployed successfully.`);
  } catch (error) {
    console.log(`SAC deployment skipped (probably already deployed):`, error.message);
  }
  
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
  // Transfer 10,000 USDC from Distributor to Savings Pool Contract
  // Note: USDC has 7 decimals on Stellar
  const fundArgs = [
    new StellarSdk.Address(distributorKeypair.publicKey()).toScVal(),
    new StellarSdk.Address(savingsContractId).toScVal(),
    StellarSdk.nativeToScVal(BigInt(10000 * 10000000), { type: 'i128' }) 
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
