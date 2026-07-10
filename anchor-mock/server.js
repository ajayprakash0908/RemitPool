const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const StellarSdk = require('@stellar/stellar-sdk');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory database for transactions
const transactions = {};

// Active config
let anchorConfig = {
  issuerPublicKey: process.env.USDC_ASSET_ISSUER || '',
  distributorSecret: process.env.MOCK_ANCHOR_SIGNER_SECRET || '',
  distributorPublicKey: '',
  assetCode: process.env.USDC_ASSET_CODE || 'USDC',
  ready: false
};

const server = new StellarSdk.Horizon.Server(process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org');

// Helper to fund account via Friendbot
async function fundWithFriendbot(publicKey) {
  console.log(`Funding account ${publicKey} via Friendbot...`);
  const response = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
  if (!response.ok) {
    throw new Error(`Friendbot failed for ${publicKey}`);
  }
  console.log(`Funded account ${publicKey} successfully.`);
}

// Perform dynamic setup on Testnet if config is missing
async function setupMockAnchorAsset() {
  try {
    let issuerKeypair;
    let distributorKeypair;

    // Check if we need to load or generate keys
    const configPath = path.join(__dirname, 'anchor_keys.json');
    if (fs.existsSync(configPath)) {
      const keys = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      issuerKeypair = StellarSdk.Keypair.fromSecret(keys.issuerSecret);
      distributorKeypair = StellarSdk.Keypair.fromSecret(keys.distributorSecret);
      console.log("Loaded existing anchor keys from anchor_keys.json");
    } else {
      console.log("Generating new Stellar accounts for Mock Anchor...");
      issuerKeypair = StellarSdk.Keypair.random();
      distributorKeypair = StellarSdk.Keypair.random();

      // Fund them via Friendbot
      await fundWithFriendbot(issuerKeypair.publicKey());
      await fundWithFriendbot(distributorKeypair.publicKey());

      // Save keys
      fs.writeFileSync(configPath, JSON.stringify({
        issuerSecret: issuerKeypair.secret(),
        issuerPublicKey: issuerKeypair.publicKey(),
        distributorSecret: distributorKeypair.secret(),
        distributorPublicKey: distributorKeypair.publicKey()
      }, null, 2), 'utf8');
      console.log("Saved new anchor keys to anchor_keys.json");
    }

    anchorConfig.issuerPublicKey = issuerKeypair.publicKey();
    anchorConfig.distributorSecret = distributorKeypair.secret();
    anchorConfig.distributorPublicKey = distributorKeypair.publicKey();

    console.log(`Anchor Issuer: ${anchorConfig.issuerPublicKey}`);
    console.log(`Anchor Distributor: ${anchorConfig.distributorPublicKey}`);

    // Update .env file if it exists, or create a basic one
    const envPath = path.join(__dirname, '../.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
    }

    const updates = {
      'USDC_ASSET_ISSUER': anchorConfig.issuerPublicKey,
      'MOCK_ANCHOR_SIGNER_SECRET': anchorConfig.distributorSecret,
    };

    let updatedContent = envContent;
    for (const [key, val] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(updatedContent)) {
        updatedContent = updatedContent.replace(regex, `${key}=${val}`);
      } else {
        updatedContent += `\n${key}=${val}`;
      }
    }
    fs.writeFileSync(envPath, updatedContent.trim() + '\n', 'utf8');
    console.log("Updated root .env with generated asset keys.");

    // Check if trustline exists
    const distAccount = await server.loadAccount(anchorConfig.distributorPublicKey);
    const hasTrustline = distAccount.balances.some(
      b => b.asset_code === anchorConfig.assetCode && b.asset_issuer === anchorConfig.issuerPublicKey
    );

    if (!hasTrustline) {
      console.log("Creating trustline from Distributor to Issuer...");
      const asset = new StellarSdk.Asset(anchorConfig.assetCode, anchorConfig.issuerPublicKey);
      const tx = new StellarSdk.TransactionBuilder(distAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET
      })
        .addOperation(StellarSdk.Operation.changeTrust({ asset, limit: '1000000000' }))
        .setTimeout(30)
        .build();

      tx.sign(distributorKeypair);
      await server.submitTransaction(tx);
      console.log("Trustline created successfully.");
    }

    // Check balance and mint if necessary
    const updatedDistAccount = await server.loadAccount(anchorConfig.distributorPublicKey);
    const mockBalance = updatedDistAccount.balances.find(
      b => b.asset_code === anchorConfig.assetCode && b.asset_issuer === anchorConfig.issuerPublicKey
    );

    const balanceValue = parseFloat(mockBalance ? mockBalance.balance : '0');
    if (balanceValue < 100000) {
      console.log("Minting mock USDC from Issuer to Distributor...");
      const issuerAccount = await server.loadAccount(anchorConfig.issuerPublicKey);
      const asset = new StellarSdk.Asset(anchorConfig.assetCode, anchorConfig.issuerPublicKey);
      const tx = new StellarSdk.TransactionBuilder(issuerAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET
      })
        .addOperation(StellarSdk.Operation.payment({
          destination: anchorConfig.distributorPublicKey,
          asset,
          amount: '500000'
        }))
        .setTimeout(30)
        .build();

      tx.sign(issuerKeypair);
      await server.submitTransaction(tx);
      console.log("Minted 500,000 mock USDC to Distributor.");
    }

    anchorConfig.ready = true;
    console.log("Mock Anchor Setup Complete & Ready!");

  } catch (error) {
    console.error("Error setting up mock anchor asset:", error);
  }
}

// Execute setup
setupMockAnchorAsset();

// Endpoint to fetch active config (keys, assets, contracts)
app.get('/config', (req, res) => {
  res.json({
    asset_code: anchorConfig.assetCode,
    asset_issuer: anchorConfig.issuerPublicKey,
    distributor_public_key: anchorConfig.distributorPublicKey,
    ready: anchorConfig.ready,
    router_contract_id: process.env.REMIT_ROUTER_CONTRACT_ID || '',
    savings_pool_contract_id: process.env.SAVINGS_POOL_CONTRACT_ID || '',
    network_passphrase: process.env.STELLAR_NETWORK_PASSPHRASE || StellarSdk.Networks.TESTNET
  });
});

// SEP-24 /info endpoint
app.get('/info', (req, res) => {
  res.json({
    deposit: {
      [anchorConfig.assetCode]: {
        enabled: true,
        authentication_required: false,
        min_amount: 1,
        max_amount: 10000
      }
    },
    withdraw: {
      [anchorConfig.assetCode]: {
        enabled: true,
        authentication_required: false,
        min_amount: 1,
        max_amount: 10000
      }
    },
    fee: {
      enabled: false
    }
  });
});

// SEP-24 Interactive Deposit Endpoint
app.get('/transactions/deposit/interactive', (req, res) => {
  const { asset_code, account, amount } = req.query;

  if (!asset_code || !account) {
    return res.status(400).json({ error: "Missing asset_code or account parameter" });
  }

  const transactionId = 'dep_' + Math.random().toString(36).substr(2, 9);
  transactions[transactionId] = {
    id: transactionId,
    kind: 'deposit',
    status: 'incomplete',
    status_eta: 30,
    amount_in: amount || '0',
    amount_out: amount || '0',
    amount_fee: '0',
    asset_code: asset_code,
    account: account,
    started_at: new Date().toISOString(),
    completed_at: null,
    stellar_transaction_id: null
  };

  const interactiveUrl = `http://localhost:${PORT}/deposit.html?transaction_id=${transactionId}&account=${account}&amount=${amount || ''}`;

  res.json({
    type: "interactive_customer_info_needed",
    url: interactiveUrl,
    id: transactionId
  });
});

// SEP-24 Interactive Withdraw Endpoint
app.get('/transactions/withdraw/interactive', (req, res) => {
  const { asset_code, account, amount } = req.query;

  if (!asset_code || !account) {
    return res.status(400).json({ error: "Missing asset_code or account parameter" });
  }

  const transactionId = 'with_' + Math.random().toString(36).substr(2, 9);
  transactions[transactionId] = {
    id: transactionId,
    kind: 'withdrawal',
    status: 'incomplete',
    status_eta: 30,
    amount_in: amount || '0',
    amount_out: amount || '0',
    amount_fee: '0',
    asset_code: asset_code,
    account: account,
    started_at: new Date().toISOString(),
    completed_at: null,
    stellar_transaction_id: null
  };

  const interactiveUrl = `http://localhost:${PORT}/withdraw.html?transaction_id=${transactionId}&account=${account}&amount=${amount || ''}`;

  res.json({
    type: "interactive_customer_info_needed",
    url: interactiveUrl,
    id: transactionId
  });
});

// SEP-24 /transaction endpoint to query details
app.get('/transaction', (req, res) => {
  const { id } = req.query;
  const tx = transactions[id];

  if (!tx) {
    return res.status(404).json({ error: "Transaction not found" });
  }

  res.json({ transaction: tx });
});

// Internal endpoint to complete interactive KYC & trigger deposit/withdrawal operations
app.post('/api/complete-interactive', async (req, res) => {
  const { transaction_id, amount, account, fiat_method, payout_details } = req.body;
  const tx = transactions[transaction_id];

  if (!tx) {
    return res.status(404).json({ error: "Transaction not found" });
  }

  try {
    tx.amount_in = amount;
    tx.amount_out = amount;

    if (tx.kind === 'deposit') {
      tx.status = 'pending_anchor';
      
      // Perform on-chain payment transfer from anchor distributor to user's wallet
      console.log(`Processing anchor deposit: sending ${amount} ${tx.asset_code} to ${account}...`);
      const distAccount = await server.loadAccount(anchorConfig.distributorPublicKey);
      const asset = new StellarSdk.Asset(tx.asset_code, anchorConfig.issuerPublicKey);
      
      const paymentTx = new StellarSdk.TransactionBuilder(distAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: StellarSdk.Networks.TESTNET
      })
        .addOperation(StellarSdk.Operation.payment({
          destination: account,
          asset,
          amount: amount.toString()
        }))
        .setTimeout(30)
        .build();

      paymentTx.sign(StellarSdk.Keypair.fromSecret(anchorConfig.distributorSecret));
      const result = await server.submitTransaction(paymentTx);
      
      tx.status = 'completed';
      tx.completed_at = new Date().toISOString();
      tx.stellar_transaction_id = result.hash;
      console.log(`On-chain deposit complete! Hash: ${result.hash}`);
      
      res.json({ success: true, status: tx.status, hash: result.hash });
    } else {
      // Withdrawal: Anchor transitions status to pending_user_transfer_start
      // User must submit a payment of USDC to the anchor's distribution address.
      tx.status = 'pending_user_transfer_start';
      tx.withdraw_anchor_account = anchorConfig.distributorPublicKey;
      tx.withdraw_memo = transaction_id.substr(0, 10); // Simple short memo
      tx.withdraw_memo_type = 'text';
      
      console.log(`Anchor withdrawal transaction ${transaction_id} is pending user transfer.`);
      res.json({
        success: true,
        status: tx.status,
        withdraw_anchor_account: tx.withdraw_anchor_account,
        withdraw_memo: tx.withdraw_memo,
        withdraw_memo_type: tx.withdraw_memo_type
      });
    }
  } catch (error) {
    console.error("Error completing interactive transaction:", error);
    tx.status = 'failed';
    res.status(500).json({ error: "Failed to settle anchor transaction", details: error.message });
  }
});

// Internal endpoint for user to claim they sent the funds for withdrawal
app.post('/api/confirm-withdrawal-sent', async (req, res) => {
  const { transaction_id, stellar_transaction_id } = req.body;
  const tx = transactions[transaction_id];

  if (!tx) {
    return res.status(404).json({ error: "Transaction not found" });
  }

  try {
    tx.stellar_transaction_id = stellar_transaction_id;
    tx.status = 'pending_anchor';
    
    // Simulate anchor verifying the payment and processing fiat bank payout
    setTimeout(() => {
      tx.status = 'completed';
      tx.completed_at = new Date().toISOString();
      console.log(`Anchor withdrawal payout complete for tx: ${transaction_id}`);
    }, 5000);

    res.json({ success: true, status: tx.status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Feedback and Analytics JSON Database configuration
const feedbackFilePath = path.join(__dirname, 'feedback.json');
const analyticsFilePath = path.join(__dirname, 'analytics.json');

// Helper to read JSON file safely
function readJsonFile(filePath, defaultData = []) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`Error reading file ${filePath}:`, err);
  }
  return defaultData;
}

// Helper to write JSON file safely
function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Error writing file ${filePath}:`, err);
  }
}

// POST feedback
app.post('/api/feedback', (req, res) => {
  const { rating, comment, address } = req.body;
  if (!rating) {
    return res.status(400).json({ error: "Rating is required" });
  }
  const feedback = readJsonFile(feedbackFilePath);
  const newFeedback = {
    id: 'fb_' + Math.random().toString(36).substr(2, 9),
    rating: parseInt(rating),
    comment: comment || '',
    address: address || 'anonymous',
    timestamp: new Date().toISOString()
  };
  feedback.push(newFeedback);
  writeJsonFile(feedbackFilePath, feedback);
  res.json({ success: true, feedback: newFeedback });
});

// GET feedback
app.get('/api/feedback', (req, res) => {
  const feedback = readJsonFile(feedbackFilePath);
  res.json(feedback);
});

// POST analytics event
app.post('/api/analytics', (req, res) => {
  const { event_name, address, metadata } = req.body;
  if (!event_name) {
    return res.status(400).json({ error: "Event name is required" });
  }
  const analytics = readJsonFile(analyticsFilePath);
  const newEvent = {
    id: 'evt_' + Math.random().toString(36).substr(2, 9),
    event_name,
    address: address || 'anonymous',
    metadata: metadata || {},
    timestamp: new Date().toISOString()
  };
  analytics.push(newEvent);
  writeJsonFile(analyticsFilePath, analytics);
  res.json({ success: true, event: newEvent });
});

// GET metrics summary for admin dashboard view
app.get('/api/metrics', (req, res) => {
  const feedback = readJsonFile(feedbackFilePath);
  const analytics = readJsonFile(analyticsFilePath);
  
  // Unique wallets
  const uniqueWallets = new Set();
  analytics.forEach(e => {
    if (e.address && e.address !== 'anonymous') {
      uniqueWallets.add(e.address);
    }
  });
  feedback.forEach(f => {
    if (f.address && f.address !== 'anonymous') {
      uniqueWallets.add(f.address);
    }
  });

  // Count actions
  let walletConnectedCount = 0;
  let sendInitiatedCount = 0;
  let sendCompletedCount = 0;
  let savingsDepositCount = 0;
  let withdrawalCount = 0;
  let errorCount = 0;

  analytics.forEach(e => {
    switch (e.event_name) {
      case 'wallet_connected':
        walletConnectedCount++;
        break;
      case 'send_initiated':
        sendInitiatedCount++;
        break;
      case 'send_completed':
        sendCompletedCount++;
        break;
      case 'savings_deposit':
        savingsDepositCount++;
        break;
      case 'withdrawal':
        withdrawalCount++;
        break;
      case 'error':
        errorCount++;
        break;
    }
  });

  // Calculate error rate
  const totalCompletedTxs = sendCompletedCount + savingsDepositCount + withdrawalCount;
  const totalAttemptedTxs = totalCompletedTxs + errorCount;
  const errorRate = totalAttemptedTxs > 0 ? ((errorCount / totalAttemptedTxs) * 100).toFixed(1) + '%' : '0.0%';

  // Feedback summary
  const totalFeedback = feedback.length;
  const avgRating = totalFeedback > 0 
    ? (feedback.reduce((sum, f) => sum + f.rating, 0) / totalFeedback).toFixed(1)
    : '0.0';

  res.json({
    unique_wallets: uniqueWallets.size,
    total_completed_transactions: totalCompletedTxs,
    error_rate: errorRate,
    average_feedback_rating: avgRating,
    total_feedback_count: totalFeedback,
    counts: {
      wallet_connected: walletConnectedCount,
      send_initiated: sendInitiatedCount,
      send_completed: sendCompletedCount,
      savings_deposit: savingsDepositCount,
      withdrawal: withdrawalCount,
      error_occurred: errorCount
    },
    raw_feedback: feedback.slice(-10).reverse(), // Last 10 feedback items
    raw_events: analytics.slice(-20).reverse() // Last 20 events
  });
});

app.listen(PORT, () => {
  console.log(`Mock SEP-24 Anchor Server listening on http://localhost:${PORT}`);
});
