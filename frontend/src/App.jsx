import React, { useState, useEffect, useRef } from 'react';
import * as StellarSdk from '@stellar/stellar-sdk';
import freighter from '@stellar/freighter-api';
import { 
  Wallet, 
  ArrowRightLeft, 
  Coins, 
  TrendingUp, 
  ArrowUpRight, 
  ArrowDownLeft, 
  RefreshCw, 
  DollarSign, 
  Percent, 
  Clock, 
  User, 
  X, 
  AlertTriangle, 
  Info,
  CheckCircle,
  HelpCircle,
  Star,
  Activity,
  FileText
} from 'lucide-react';
import './App.css';

// Initialize Sentry placeholder if DSN is set
const SENTRY_DSN = import.meta.env.VITE_SENTRY_DSN || '';
if (SENTRY_DSN) {
  import('@sentry/react').then((Sentry) => {
    Sentry.init({
      dsn: SENTRY_DSN,
      tracesSampleRate: 1.0,
    });
    console.log("Sentry error tracking initialized.");
  }).catch(err => console.error("Sentry failed to load:", err));
}

// Standalone Performance-Optimized Live Yield Counter Component
// Isolates 60 FPS animation updates to prevent main App re-renders
const LiveYieldCounter = React.memo(({ dashboardSavingsValue, dashboardFetchTime, yieldRateSec }) => {
  const [liveSavingsVal, setLiveSavingsVal] = useState(0);

  useEffect(() => {
    let animFrameId;
    function tick() {
      if (parseFloat(dashboardSavingsValue) > 0 && dashboardFetchTime > 0) {
        const elapsed = (Date.now() / 1000) - dashboardFetchTime;
        const ratePerSec = yieldRateSec;
        const initialVal = parseFloat(dashboardSavingsValue);
        const increment = initialVal * (ratePerSec / 1000000000) * elapsed;
        setLiveSavingsVal(initialVal + increment);
      } else {
        setLiveSavingsVal(0);
      }
      animFrameId = requestAnimationFrame(tick);
    }
    animFrameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameId);
  }, [dashboardSavingsValue, dashboardFetchTime, yieldRateSec]);

  // Formatter
  const formatLiveBalance = (val) => {
    if (isNaN(val) || val <= 0) return { integer: "0", decimals: ".0000000" };
    const parts = val.toFixed(7).split('.');
    return {
      integer: parts[0],
      decimals: '.' + parts[1]
    };
  };

  const liveBal = formatLiveBalance(liveSavingsVal);

  return (
    <div className="balance-value-live">
      {liveBal.integer}
      <span className="decimals">{liveBal.decimals}</span>
      <span className="currency">USDC</span>
    </div>
  );
});

// Network & RPC Settings (Loaded dynamically from anchor-mock)
let networkPassphrase = StellarSdk.Networks.TESTNET;
let rpcServer = new StellarSdk.rpc.Server('https://soroban-testnet.stellar.org');
let horizonServer = new StellarSdk.Horizon.Server('https://horizon-testnet.stellar.org');

function App() {
  // App Config
  const [config, setConfig] = useState(null);
  const [loadingConfig, setLoadingConfig] = useState(true);

  // Wallet State
  const [walletType, setWalletType] = useState('none'); // 'none' | 'freighter' | 'mock'
  const [publicKey, setPublicKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [usdcBalance, setUsdcBalance] = useState('0.0000000');
  const [xlmBalance, setXlmBalance] = useState('0.0000000');
  const [hasTrustline, setHasTrustline] = useState(false);
  const [loadingBalances, setLoadingBalances] = useState(false);

  // Recipient Dashboard Query
  const [recipientQuery, setRecipientQuery] = useState('');
  const [dashboardAddress, setDashboardAddress] = useState('');
  const [dashboardUsdc, setDashboardUsdc] = useState('0.0000000');
  const [dashboardShares, setDashboardShares] = useState('0');
  const [dashboardSavingsValue, setDashboardSavingsValue] = useState('0.0000000');
  const [dashboardFetchTime, setDashboardFetchTime] = useState(0);
  const [loadingDashboard, setLoadingDashboard] = useState(false);
  const [rpcError, setRpcError] = useState(null);

  // Onboarding walkthrough
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);

  // Feedback State
  const [showFeedbackModal, setShowFeedbackModal] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState(5);
  const [feedbackComment, setFeedbackComment] = useState('');
  const [submittingFeedback, setSubmittingFeedback] = useState(false);

  // Admin Metrics State
  const [showAdminMetrics, setShowAdminMetrics] = useState(false);
  const [metricsData, setMetricsData] = useState(null);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  
  // Remittance Split Form
  const [sendRecipient, setSendRecipient] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [splitPercent, setSplitPercent] = useState(20);
  const [submittingRemit, setSubmittingRemit] = useState(false);

  // Savings Withdrawal Form
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [submittingWithdraw, setSubmittingWithdraw] = useState(false);

  // Interactive Flow Modals (SEP-24)
  const [interactiveUrl, setInteractiveUrl] = useState('');
  const [interactiveTitle, setInteractiveTitle] = useState('');

  // Transactions History
  const [history, setHistory] = useState([]);

  // Toast / Status Notifications
  const [toasts, setToasts] = useState([]);

  // Wallet Kit instance
  const kitRef = useRef(null);

  // Global yield rate
  const [yieldRateSec, setYieldRateSec] = useState(100000); // base config fallback

  // Track event helper
  const trackEvent = async (eventName, metadata = {}) => {
    try {
      console.log(`[Analytics Event] ${eventName}:`, metadata);
      await fetch('http://localhost:3001/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_name: eventName,
          address: publicKey || 'anonymous',
          metadata
        })
      });
    } catch (err) {
      console.error("Failed to post analytics event:", err);
    }
  };

  // Show status toasts helper
  const showToast = (message, type = 'info') => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  };

  // Fetch mock anchor configuration on load
  useEffect(() => {
    async function fetchConfig() {
      try {
        console.log("Fetching mock anchor configuration...");
        const res = await fetch('http://localhost:3001/config');
        if (!res.ok) throw new Error("Failed to contact mock anchor server");
        const data = await res.json();
        
        setConfig(data);
        networkPassphrase = data.network_passphrase;
        
        console.log("Loaded Mock Anchor config:", data);
        
        setLoadingConfig(false);
      } catch (err) {
        console.error("Config fetch error:", err);
        showToast("Could not connect to anchor-mock server. Ensure it is running.", "error");
        setLoadingConfig(false);
      }
    }
    fetchConfig();
  }, []);

  // Reload saved mock wallet on start if present
  useEffect(() => {
    const savedSecret = localStorage.getItem('remitpool_mock_secret');
    const savedPublic = localStorage.getItem('remitpool_mock_public');
    if (savedSecret && savedPublic) {
      setSecretKey(savedSecret);
      setPublicKey(savedPublic);
      setWalletType('mock');
    }
  }, []);

  // Load balances when wallet changes
  useEffect(() => {
    if (publicKey) {
      setDashboardAddress(publicKey);
      setRecipientQuery(publicKey);
      loadWalletBalances(publicKey);
    } else {
      setUsdcBalance('0.0000000');
      setXlmBalance('0.0000000');
      setHasTrustline(false);
    }
  }, [publicKey, walletType, config]);

  // Load Recipient/Dashboard stats when dashboardAddress changes
  useEffect(() => {
    if (dashboardAddress && config) {
      loadDashboardStats(dashboardAddress);
      
      // Setup polling interval every 10 seconds to sync with ledger (Level 4 performance polish)
      const interval = setInterval(() => {
        loadDashboardStats(dashboardAddress);
      }, 10000);
      return () => clearInterval(interval);
    }
  }, [dashboardAddress, config]);

  // Trigger onboarding check on load
  useEffect(() => {
    const seenOnboarding = localStorage.getItem('remitpool_onboarding_seen');
    if (!seenOnboarding) {
      setShowOnboarding(true);
    }
  }, []);

  // Load classic wallet balance from Horizon
  const loadWalletBalances = async (pubKey) => {
    if (!config) return;
    setLoadingBalances(true);
    try {
      console.log(`Loading balances for ${pubKey}...`);
      const account = await horizonServer.loadAccount(pubKey);
      
      // Get XLM balance
      const nativeBal = account.balances.find((b) => b.asset_type === 'native');
      setXlmBalance(nativeBal ? parseFloat(nativeBal.balance).toFixed(7) : '0.0000000');
      
      // Get mock USDC balance and trustline state
      const usdcAsset = account.balances.find(
        (b) => b.asset_code === config.asset_code && b.asset_issuer === config.asset_issuer
      );
      
      if (usdcAsset) {
        setUsdcBalance(parseFloat(usdcAsset.balance).toFixed(7));
        setHasTrustline(true);
      } else {
        setUsdcBalance('0.0000000');
        setHasTrustline(false);
      }
    } catch (err) {
      console.error("Horizon balance fetch error:", err);
      // Account not created yet
      setXlmBalance('0.0000000');
      setUsdcBalance('0.0000000');
      setHasTrustline(false);
      if (walletType === 'mock') {
        showToast("Test wallet is not funded yet. Click Fund Wallet to create it.", "warning");
      } else {
        showToast("Account does not exist on Testnet. Send some testnet funds first.", "error");
      }
    } finally {
      setLoadingBalances(false);
    }
  };

  // Helper to execute read-only contract simulation
  const simulateContractCall = async (contractId, method, args) => {
    const contract = new StellarSdk.Contract(contractId);
    const op = contract.call(method, ...args);
    
    // Use a dummy address for read-only simulations
    const dummyAddress = "GACM2HA3NCXVVFQFMA6AO6EYM3AYY3E3DREM2LBDLHORQ7UHEKNUQD2N"; 
    const sourceAccount = new StellarSdk.Account(dummyAddress, "0");
    
    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: '100',
      networkPassphrase: networkPassphrase
    })
      .addOperation(op)
      .setTimeout(30)
      .build();
      
    const sim = await rpcServer.simulateTransaction(tx);
    if (sim.error) {
      throw new Error(`Simulation failed: ${sim.error}`);
    }
    if (!sim.result || !sim.result.retval) {
      return 0n;
    }
    return StellarSdk.scValToNative(sim.result.retval);
  };

  // Load savings pool dashboard stats for any address
  const loadDashboardStats = async (ownerAddress) => {
    if (!config || !config.savings_pool_contract_id) return;
    setLoadingDashboard(true);
    setRpcError(null);
    try {
      console.log(`Loading savings dashboard stats for ${ownerAddress}...`);
      
      // 1. Get user shares
      const shares = await simulateContractCall(
        config.savings_pool_contract_id,
        "get_shares",
        [new StellarSdk.Address(ownerAddress).toScVal()]
      );
      
      // 2. Get user balance (contains accrued interest in contract)
      const balance = await simulateContractCall(
        config.savings_pool_contract_id,
        "get_balance",
        [new StellarSdk.Address(ownerAddress).toScVal()]
      );

      // Convert from stroop/decimal representation (USDC is 7 decimals)
      const usdcValStr = (Number(balance) / 10000000).toFixed(7);
      
      setDashboardShares(shares.toString());
      setDashboardSavingsValue(usdcValStr);
      
      // Record time of successful fetch
      setDashboardFetchTime(Date.now() / 1000);
      
      // Fetch recipient's Horizon USDC balance
      try {
        const account = await horizonServer.loadAccount(ownerAddress);
        const usdcAsset = account.balances.find(
          (b) => b.asset_code === config.asset_code && b.asset_issuer === config.asset_issuer
        );
        setDashboardUsdc(usdcAsset ? parseFloat(usdcAsset.balance).toFixed(7) : '0.0000000');
      } catch {
        setDashboardUsdc('0.0000000');
      }
    } catch (err) {
      console.error("Savings pool simulation error:", err);
      setRpcError("RPC query failed. Check connection or verify that contracts are deployed on Testnet.");
      trackEvent('error', { context: 'loadDashboardStats', message: err.message });
    } finally {
      setLoadingDashboard(false);
    }
  };

  // Helper to submit transaction to network
  const executeContractTransaction = async (operation, sourceSecret = null) => {
    if (!config) return;
    
    trackEvent('transaction_initiated', { method: operation.name || 'contract_call' });
    
    // Load account sequence number from RPC
    const accountResult = await rpcServer.getAccount(publicKey);
    
    let tx = new StellarSdk.TransactionBuilder(accountResult, {
      fee: '100', // placeholder
      networkPassphrase: networkPassphrase
    })
      .addOperation(operation)
      .setTimeout(60)
      .build();
      
    // 1. Simulate and prepare transaction
    tx = await rpcServer.prepareTransaction(tx);
    
    // 2. Sign transaction
    if (walletType === 'mock' && sourceSecret) {
      const kp = StellarSdk.Keypair.fromSecret(sourceSecret);
      tx.sign(kp);
    } else {
      // Sign with Freighter directly
      const signedXdr = await freighter.signTransaction(tx.toXDR(), {
        network: networkPassphrase === StellarSdk.Networks.PUBLIC ? 'PUBLIC' : 'TESTNET',
        networkPassphrase: networkPassphrase
      });
      tx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
    }
    
    // 3. Submit transaction
    let response = await rpcServer.sendTransaction(tx);
    if (response.status === 'ERROR') {
      trackEvent('error', { context: 'executeContractTransaction_submit', errorResult: response.errorResult });
      throw new Error(`Transaction send failed: ${JSON.stringify(response.errorResult)}`);
    }
    
    // 4. Poll transaction status
    const txHash = response.hash;
    while (true) {
      const txStatus = await rpcServer.getTransaction(txHash);
      if (txStatus.status === 'SUCCESS') {
        return txHash;
      } else if (txStatus.status === 'FAILED') {
        trackEvent('error', { context: 'executeContractTransaction_inclusion', txHash });
        throw new Error("On-chain transaction execution failed.");
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  // Connect Freighter wallet
  const connectFreighter = async () => {
    try {
      setWalletType('freighter');
      
      const connected = await freighter.isConnected();
      if (!connected) {
        showToast("Freighter extension not detected.", "error");
        trackEvent('error', { context: 'connectFreighter', message: 'Freighter not detected' });
        return;
      }
      
      // Request access (retrieves the active public key)
      const addressObj = await freighter.getAddress();
      if (!addressObj || !addressObj.address) {
        throw new Error("No address returned from Freighter");
      }
      
      setPublicKey(addressObj.address);
      setSecretKey('');
      localStorage.removeItem('remitpool_mock_secret');
      localStorage.removeItem('remitpool_mock_public');
      showToast("Freighter wallet connected successfully!", "success");
      trackEvent('wallet_connected', { wallet_type: 'freighter', address: addressObj.address });
    } catch (err) {
      console.error("Freighter connection error:", err);
      showToast(`Freighter connection failed: ${err.message}`, "error");
      setWalletType('none');
      setPublicKey('');
      trackEvent('error', { context: 'connectFreighter', message: err.message });
    }
  };

  // Generate a mock/local wallet for sandbox reviews
  const createMockWallet = async () => {
    const kp = StellarSdk.Keypair.random();
    const pub = kp.publicKey();
    const sec = kp.secret();
    
    setPublicKey(pub);
    setSecretKey(sec);
    setWalletType('mock');
    
    localStorage.setItem('remitpool_mock_secret', sec);
    localStorage.setItem('remitpool_mock_public', pub);
    
    showToast("Mock Wallet generated locally!", "success");
    trackEvent('wallet_connected', { wallet_type: 'mock', address: pub });
    
    // Automatically attempt Friendbot funding
    await fundMockWallet(pub);
  };

  // Fund local wallet with Friendbot and establish USDC trustline
  const fundMockWallet = async (addressToFund) => {
    const target = addressToFund || publicKey;
    if (!target) return;
    
    setLoadingBalances(true);
    try {
      showToast("Requesting XLM from Friendbot...", "info");
      const res = await fetch(`https://friendbot.stellar.org?addr=${target}`);
      if (!res.ok) throw new Error("Friendbot request failed");
      showToast("Friendbot funded account. Establishing USDC trustline...", "info");
      
      // Execute changeTrust operation on-chain
      const accountResult = await rpcServer.getAccount(target);
      const usdcAsset = new StellarSdk.Asset(config.asset_code, config.asset_issuer);
      
      const op = StellarSdk.Operation.changeTrust({
        asset: usdcAsset,
        limit: '100000000'
      });
      
      let tx = new StellarSdk.TransactionBuilder(accountResult, {
        fee: '100',
        networkPassphrase: networkPassphrase
      })
        .addOperation(op)
        .setTimeout(30)
        .build();
        
      tx = await rpcServer.prepareTransaction(tx);
      const kp = StellarSdk.Keypair.fromSecret(secretKey);
      tx.sign(kp);
      
      const response = await rpcServer.sendTransaction(tx);
      let status = response.status;
      while (status === 'PENDING') {
        await new Promise(r => setTimeout(r, 2000));
        const txStatus = await rpcServer.getTransaction(response.hash);
        status = txStatus.status;
        if (status === 'SUCCESS') break;
      }
      
      showToast("USDC Trustline established! Ready for interactive deposits.", "success");
      trackEvent('trustline_created', { wallet_type: 'mock', address: target });
      loadWalletBalances(target);
    } catch (err) {
      console.error("Mock funding failed:", err);
      showToast(`Funding failed: ${err.message}`, "error");
      trackEvent('error', { context: 'fundMockWallet', message: err.message });
    } finally {
      setLoadingBalances(false);
    }
  };

  // Establish trustline manually for Freighter
  const createTrustlineFreighter = async () => {
    if (!publicKey || !config) return;
    setLoadingBalances(true);
    try {
      const usdcAsset = new StellarSdk.Asset(config.asset_code, config.asset_issuer);
      const op = StellarSdk.Operation.changeTrust({
        asset: usdcAsset,
        limit: '100000000'
      });
      
      showToast("Please approve the trustline transaction in Freighter...", "info");
      const hash = await executeContractTransaction(op);
      showToast("USDC Trustline established!", "success");
      trackEvent('trustline_created', { wallet_type: 'freighter', address: publicKey, hash });
      
      // Update balances
      loadWalletBalances(publicKey);
    } catch (err) {
      console.error("Trustline transaction failed:", err);
      showToast(`Trustline error: ${err.message}`, "error");
      trackEvent('error', { context: 'createTrustlineFreighter', message: err.message });
    } finally {
      setLoadingBalances(false);
    }
  };

  // Disconnect active wallet
  const disconnectWallet = () => {
    setWalletType('none');
    setPublicKey('');
    setSecretKey('');
    localStorage.removeItem('remitpool_mock_secret');
    localStorage.removeItem('remitpool_mock_public');
    showToast("Wallet disconnected.", "info");
    trackEvent('wallet_disconnected');
  };

  // Trigger SEP-24 Interactive Deposit flow in Modal Iframe
  const triggerDeposit = async () => {
    if (!publicKey || !config) return;
    try {
      showToast("Initializing interactive on-ramp flow...", "info");
      
      const res = await fetch('http://localhost:3001/sep24/transactions/deposit/interactive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: publicKey,
          asset_code: config.asset_code
        })
      });
      
      if (!res.ok) throw new Error("Anchor rejected interactive deposit");
      const data = await res.json();
      
      setInteractiveUrl(data.url);
      setInteractiveTitle("Anchor Deposit On-Ramp");
    } catch (err) {
      console.error("Interactive deposit init failed:", err);
      showToast(err.message, "error");
    }
  };

  // Trigger SEP-24 Interactive Withdrawal flow in Modal Iframe
  const triggerWithdraw = async () => {
    if (!publicKey || !config) return;
    try {
      showToast("Initializing interactive off-ramp flow...", "info");
      
      const res = await fetch('http://localhost:3001/sep24/transactions/withdraw/interactive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account: publicKey,
          asset_code: config.asset_code
        })
      });
      
      if (!res.ok) throw new Error("Anchor rejected interactive withdraw");
      const data = await res.json();
      
      setInteractiveUrl(data.url);
      setInteractiveTitle("Anchor Off-Ramp Withdrawal");
    } catch (err) {
      console.error("Interactive withdraw init failed:", err);
      showToast(err.message, "error");
    }
  };

  // Listen to message events from the SEP-24 iframe popup
  useEffect(() => {
    const handleMessage = (e) => {
      // Make sure the origin matches our mock anchor server
      if (e.origin === 'http://localhost:3001') {
        const msg = e.data;
        if (msg.type === 'interactive_completed') {
          console.log("Interactive flow completed message received from iframe!");
          showToast(`Transaction completed: ${msg.status}`, "success");
          setInteractiveUrl('');
          setInteractiveTitle('');
          
          // Add to transaction log
          const newTx = {
            id: msg.transaction_id || `anchor-${Date.now()}`,
            type: msg.kind === 'deposit' ? 'deposit' : 'withdrawal',
            amount: parseFloat(msg.amount || 0).toFixed(2),
            recipient: publicKey,
            timestamp: new Date().toLocaleTimeString(),
            hash: msg.stellar_transaction_id || ''
          };
          setHistory(prev => [newTx, ...prev]);
          
          // Reload balances after transaction settles
          setTimeout(() => {
            loadWalletBalances(publicKey);
          }, 3000);
        }
      }
    };
    
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [publicKey]);

  // Submit remittance split routing on-chain
  const handleRemit = async (e) => {
    e.preventDefault();
    if (!config || !config.router_contract_id || !sendRecipient || !sendAmount) return;
    
    // Recipient address verification
    try {
      new StellarSdk.Address(sendRecipient);
    } catch {
      showToast("Invalid Recipient address format. Must start with 'G' or 'C'.", "error");
      return;
    }

    if (publicKey === sendRecipient) {
      showToast("Sender and recipient must be different addresses.", "error");
      return;
    }
    
    setSubmittingRemit(true);
    showToast("Simulating split routing transaction...", "info");
    
    trackEvent('send_initiated', {
      amount: sendAmount,
      recipient: sendRecipient,
      split_percent: splitPercent
    });
    
    try {
      const contract = new StellarSdk.Contract(config.router_contract_id);
      
      // Amount in stroops (7 decimals for USDC)
      const amountStroops = BigInt(Math.floor(parseFloat(sendAmount) * 10000000));
      
      // Args: send_remittance(sender: Address, recipient: Address, amount: i128, save_percent: u32)
      const op = contract.call(
        "send_remittance",
        new StellarSdk.Address(publicKey).toScVal(),
        new StellarSdk.Address(sendRecipient).toScVal(),
        StellarSdk.nativeToScVal(amountStroops, { type: "i128" }),
        StellarSdk.nativeToScVal(splitPercent, { type: "u32" })
      );
      
      showToast("Submitting Soroban split routing transaction...", "info");
      const hash = await executeContractTransaction(op, secretKey);
      
      showToast(`Remittance Split sent successfully!`, "success");
      trackEvent('send_completed', {
        hash,
        amount: sendAmount,
        recipient: sendRecipient,
        split_percent: splitPercent
      });
      
      // Add transaction to history
      const newTx = {
        id: hash.substring(0, 12),
        type: 'remit',
        amount: parseFloat(sendAmount).toFixed(2),
        recipient: sendRecipient,
        timestamp: new Date().toLocaleTimeString(),
        hash: hash
      };
      setHistory(prev => [newTx, ...prev]);
      
      // Clear form
      setSendAmount('');
      setSendRecipient('');
      
      // Refresh balance
      loadWalletBalances(publicKey);
    } catch (err) {
      console.error("Remittance contract error:", err);
      showToast(`Remittance failed: ${err.message}`, "error");
      trackEvent('error', { context: 'handleRemit', message: err.message });
    } finally {
      setSubmittingRemit(false);
    }
  };

  // Withdraw savings balance + interest yield from SavingsPool
  const handleWithdrawSavings = async (e) => {
    e.preventDefault();
    if (!config || !config.savings_pool_contract_id || !withdrawAmount) return;
    
    setSubmittingWithdraw(true);
    showToast("Preparing savings pool withdrawal...", "info");
    
    trackEvent('withdrawal_initiated', {
      amount: withdrawAmount
    });
    
    try {
      // Find shares corresponding to USDC amount
      // Formula: shares = usdc_amount * total_shares / total_pool_value
      const totalSharesVal = await simulateContractCall(config.savings_pool_contract_id, "total_shares", []);
      const totalPoolVal = await simulateContractCall(config.savings_pool_contract_id, "total_pool_value", []);
      
      const withdrawStroops = BigInt(Math.floor(parseFloat(withdrawAmount) * 10000000));
      
      let sharesToWithdraw = 0n;
      if (totalPoolVal === 0n || totalSharesVal === 0n) {
        sharesToWithdraw = withdrawStroops;
      } else {
        sharesToWithdraw = (withdrawStroops * totalSharesVal) / totalPoolVal;
      }
      
      // Prevent rounding up errors in shares
      const maxShares = BigInt(dashboardShares);
      if (sharesToWithdraw > maxShares) {
        sharesToWithdraw = maxShares;
      }
      
      const contract = new StellarSdk.Contract(config.savings_pool_contract_id);
      // Args: withdraw(owner: Address, shares: i128)
      const op = contract.call(
        "withdraw",
        new StellarSdk.Address(publicKey).toScVal(),
        StellarSdk.nativeToScVal(sharesToWithdraw, { type: "i128" })
      );
      
      showToast("Submitting savings pool withdrawal to Testnet...", "info");
      const hash = await executeContractTransaction(op, secretKey);
      
      showToast(`Withdrew ${withdrawAmount} USDC from savings pool!`, "success");
      trackEvent('withdrawal', {
        hash,
        amount: withdrawAmount
      });
      
      // Add transaction to history
      const newTx = {
        id: hash.substring(0, 12),
        type: 'withdraw',
        amount: parseFloat(withdrawAmount).toFixed(2),
        recipient: publicKey,
        timestamp: new Date().toLocaleTimeString(),
        hash: hash
      };
      setHistory(prev => [newTx, ...prev]);
      
      setWithdrawAmount('');
      loadWalletBalances(publicKey);
      loadDashboardStats(dashboardAddress);
    } catch (err) {
      console.error("Savings withdrawal failed:", err);
      showToast(`Withdrawal failed: ${err.message}`, "error");
      trackEvent('error', { context: 'handleWithdrawSavings', message: err.message });
    } finally {
      setSubmittingWithdraw(false);
    }
  };

  const handleSearchRecipient = (e) => {
    e.preventDefault();
    if (!recipientQuery) return;
    try {
      new StellarSdk.Address(recipientQuery);
      setDashboardAddress(recipientQuery);
    } catch {
      showToast("Invalid query address.", "error");
    }
  };

  const toggleAdminMetrics = async () => {
    if (!showAdminMetrics) {
      setLoadingMetrics(true);
      try {
        const res = await fetch('http://localhost:3001/api/metrics');
        if (res.ok) {
          const data = await res.json();
          setMetricsData(data);
        }
      } catch (err) {
        console.error("Failed to load metrics:", err);
      } finally {
        setLoadingMetrics(false);
      }
    }
    setShowAdminMetrics(!showAdminMetrics);
  };

  const handleFeedbackSubmit = async (e) => {
    e.preventDefault();
    setSubmittingFeedback(true);
    try {
      const res = await fetch('http://localhost:3001/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating: feedbackRating,
          comment: feedbackComment,
          address: publicKey || 'anonymous'
        })
      });
      if (res.ok) {
        showToast("Thank you for your feedback!", "success");
        trackEvent('feedback_submitted', { rating: feedbackRating });
        setFeedbackComment('');
        setShowFeedbackModal(false);
      } else {
        throw new Error("Failed to save feedback");
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, "error");
    } finally {
      setSubmittingFeedback(false);
    }
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="logo-section">
          <div className="logo-icon">
            <Coins size={22} />
          </div>
          <span className="logo-text">RemitPool</span>
        </div>
        
        <div className="header-actions">
          {/* Header Action Controls */}
          <button 
            className="admin-metrics-btn" 
            style={{ minHeight: '44px' }} 
            onClick={() => setShowOnboarding(true)}
          >
            <HelpCircle size={16} />
            Quick Tour
          </button>
          
          <button 
            className="admin-metrics-btn" 
            style={{ minHeight: '44px' }} 
            onClick={toggleAdminMetrics}
          >
            <Activity size={16} />
            Admin Dashboard
          </button>

          {walletType === 'none' ? (
            <>
              <button className="btn-wallet" style={{ minHeight: '44px' }} onClick={connectFreighter}>
                <Wallet size={16} />
                Connect Freighter
              </button>
              <button className="btn-wallet mock" style={{ minHeight: '44px' }} onClick={createMockWallet}>
                <User size={16} />
                Create Mock Wallet
              </button>
            </>
          ) : (
            <>
              <div className={`btn-wallet connected ${walletType === 'mock' ? 'mock' : ''}`} style={{ minHeight: '44px' }}>
                <Wallet size={16} />
                <span style={{ fontFamily: 'monospace' }}>
                  {publicKey.substring(0, 6)}...{publicKey.substring(50)}
                </span>
                <span style={{ fontSize: '11px', opacity: 0.7, marginLeft: '6px' }}>
                  ({walletType === 'mock' ? 'Mock Wallet' : 'Freighter'})
                </span>
              </div>
              <button className="btn-wallet" style={{ minHeight: '44px' }} onClick={disconnectWallet}>
                Disconnect
              </button>
            </>
          )}
        </div>
      </header>

      {loadingConfig ? (
        <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '50vh' }}>
          <RefreshCw className="spinner" size={48} style={{ color: 'var(--primary)', marginBottom: '16px' }} />
          <p style={{ color: 'var(--text-muted)' }}>Initializing connection and reading ledger config...</p>
        </div>
      ) : (
        <>
          {/* Unfunded Wallet Warning */}
          {walletType === 'mock' && parseFloat(xlmBalance) === 0 && (
            <div className="banner warning">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <AlertTriangle size={20} />
                <span>
                  This locally generated mock wallet has no balance on Stellar Testnet yet. Fund it to create the account.
                </span>
              </div>
              <button className="btn-secondary" style={{ padding: '6px 12px', fontSize: '12px', minHeight: '44px' }} onClick={() => fundMockWallet(publicKey)}>
                Fund Wallet
              </button>
            </div>
          )}

          {/* Connected but no trustline warning */}
          {walletType !== 'none' && !hasTrustline && parseFloat(xlmBalance) > 0 && (
            <div className="banner warning">
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <AlertTriangle size={20} />
                <span>
                  Your wallet does not have a trustline for mock USDC. You must establish a trustline to deposit or receive funds.
                </span>
              </div>
              <button 
                className="btn-secondary" 
                style={{ padding: '6px 12px', fontSize: '12px', minHeight: '44px' }} 
                onClick={walletType === 'mock' ? () => fundMockWallet(publicKey) : createTrustlineFreighter}
              >
                Create USDC Trustline
              </button>
            </div>
          )}

          <div className="dashboard-grid">
            {/* SENDER FLOW / RAMP SECTION */}
            <div className="glass-card">
              <h2 className="card-title">
                <ArrowRightLeft size={22} />
                Cross-Border Remit Flow
              </h2>

              {walletType === 'none' ? (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
                  <Wallet size={48} style={{ opacity: 0.3, marginBottom: '16px' }} />
                  <p>Please connect your wallet or generate a mock developer wallet above to begin remittance operations.</p>
                </div>
              ) : (
                <>
                  {/* SEP-24 Interactive On/Off Ramp */}
                  <div className="form-group" style={{ marginBottom: '24px' }}>
                    <label className="form-label">Interactive On/Off Ramp (SEP-24)</label>
                    <div className="ramp-section">
                      <button className="btn-secondary" style={{ minHeight: '44px' }} onClick={triggerDeposit} disabled={!hasTrustline}>
                        <ArrowDownLeft size={16} style={{ color: 'var(--success)' }} />
                        Interactive Deposit
                      </button>
                      <button className="btn-secondary" style={{ minHeight: '44px' }} onClick={triggerWithdraw} disabled={parseFloat(usdcBalance) <= 0}>
                        <ArrowUpRight size={16} style={{ color: 'var(--danger)' }} />
                        Interactive Withdraw
                      </button>
                    </div>
                  </div>

                  <hr style={{ border: 'none', borderTop: '1px solid rgba(255, 255, 255, 0.05)', margin: '24px 0' }} />

                  {/* Smart Contract Split Payment */}
                  <form onSubmit={handleRemit}>
                    <div className="form-group">
                      <label className="form-label" htmlFor="recipient">Recipient Wallet Address</label>
                      <div className="input-wrapper">
                        <User className="input-icon" size={18} />
                        <input
                          id="recipient"
                          className="form-input"
                          type="text"
                          placeholder="G... or C..."
                          value={sendRecipient}
                          onChange={(e) => setSendRecipient(e.target.value)}
                          required
                        />
                      </div>
                    </div>

                    <div className="form-group">
                      <label className="form-label" htmlFor="amount">USDC Send Amount</label>
                      <div className="input-wrapper">
                        <DollarSign className="input-icon" size={18} />
                        <input
                          id="amount"
                          className="form-input"
                          type="number"
                          step="0.00001"
                          min="0.00001"
                          max={usdcBalance}
                          placeholder="Amount in USDC"
                          value={sendAmount}
                          onChange={(e) => setSendAmount(e.target.value)}
                          required
                        />
                      </div>
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginTop: '6px', textAlign: 'right' }}>
                        Balance: {usdcBalance} USDC
                      </span>
                    </div>

                    {/* Savings Slider */}
                    <div className="slider-container">
                      <div className="slider-header">
                        <span className="form-label" style={{ margin: 0 }}>Auto-Savings Split</span>
                        <span className="slider-value">{splitPercent}%</span>
                      </div>
                      <input
                        type="range"
                        className="custom-range"
                        min="0"
                        max="100"
                        value={splitPercent}
                        onChange={(e) => setSplitPercent(parseInt(e.target.value))}
                      />
                      <div className="slider-labels">
                        <span>0% (No savings)</span>
                        <span>50%</span>
                        <span>100% (All savings)</span>
                      </div>
                    </div>

                    {/* Split Details Cards */}
                    {sendAmount && parseFloat(sendAmount) > 0 && (
                      <div className="split-preview">
                        <div className="split-card direct">
                          <div className="split-label">Direct to Recipient Wallet ({100 - splitPercent}%)</div>
                          <div className="split-amount">
                            {(parseFloat(sendAmount) * (1 - splitPercent / 100)).toFixed(4)} USDC
                          </div>
                        </div>
                        <div className="split-card savings">
                          <div className="split-label">Yield Savings Pool ({splitPercent}%)</div>
                          <div className="split-amount">
                            {(parseFloat(sendAmount) * (splitPercent / 100)).toFixed(4)} USDC
                          </div>
                        </div>
                      </div>
                    )}

                    <button className="btn-primary" type="submit" style={{ minHeight: '44px' }} disabled={submittingRemit || !hasTrustline || parseFloat(sendAmount) <= 0 || parseFloat(sendAmount) > parseFloat(usdcBalance)}>
                      {submittingRemit ? (
                        <>
                          <RefreshCw className="spinner" size={18} />
                          Processing Remittance Split...
                        </>
                      ) : (
                        <>
                          <ArrowRightLeft size={18} />
                          Send Split Remittance
                        </>
                      )}
                    </button>
                  </form>
                </>
              )}
            </div>

            {/* RECIPIENT DASHBOARD */}
            <div className="glass-card">
              <h2 className="card-title">
                <TrendingUp size={22} />
                Recipient Savings Dashboard
              </h2>

              <form onSubmit={handleSearchRecipient} style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
                <input
                  className="form-input"
                  style={{ paddingLeft: '16px', minHeight: '44px' }}
                  type="text"
                  placeholder="Query recipient savings dashboard..."
                  value={recipientQuery}
                  onChange={(e) => setRecipientQuery(e.target.value)}
                />
                <button className="btn-secondary" style={{ minHeight: '44px' }} type="submit">
                  Search
                </button>
              </form>

              {loadingDashboard ? (
                /* Pulse Skeleton Loaders for recipient queries */
                <div style={{ padding: '10px 0' }}>
                  <div className="skeleton-box skeleton-title" style={{ width: '50%', height: '24px' }}></div>
                  <div className="skeleton-box skeleton-text" style={{ height: '90px', margin: '20px 0' }}></div>
                  <div className="skeleton-box skeleton-text" style={{ height: '56px', marginBottom: '16px' }}></div>
                  <div className="skeleton-box skeleton-text" style={{ height: '44px' }}></div>
                </div>
              ) : rpcError ? (
                /* Actionable RPC Error Banner */
                <div className="empty-state-box">
                  <AlertTriangle size={36} style={{ color: 'var(--warning)', marginBottom: '12px' }} />
                  <p className="empty-state-text" style={{ color: 'var(--text-primary)', marginBottom: '16px' }}>{rpcError}</p>
                  <button className="btn-secondary" style={{ minHeight: '44px', padding: '10px 20px' }} onClick={() => loadDashboardStats(dashboardAddress)}>
                    Retry RPC Connection
                  </button>
                </div>
              ) : dashboardAddress ? (
                <>
                  {/* High Precision Live Counter Box */}
                  <div className="balance-container">
                    <div className="balance-title">Savings Pool Yield Balance</div>
                    <LiveYieldCounter 
                      dashboardSavingsValue={dashboardSavingsValue} 
                      dashboardFetchTime={dashboardFetchTime} 
                      yieldRateSec={yieldRateSec} 
                    />

                    <div className="yield-stats">
                      <div className="yield-stat-item">
                        Shares: <strong>{parseFloat(dashboardShares).toFixed(0)}</strong>
                      </div>
                      <div className="yield-stat-item">
                        Yield Rate: <strong>~36.0% / Hour</strong>
                      </div>
                    </div>
                  </div>

                  <div className="split-preview" style={{ marginBottom: '28px' }}>
                    <div className="split-card">
                      <div className="split-label">Wallet Balance</div>
                      <div className="split-amount" style={{ color: 'white' }}>
                        {parseFloat(dashboardUsdc).toFixed(4)} USDC
                      </div>
                    </div>
                    <div className="split-card">
                      <div className="split-label">Total Savings + Wallet</div>
                      <div className="split-amount" style={{ color: 'var(--success)' }}>
                        {(parseFloat(dashboardUsdc) + parseFloat(dashboardSavingsValue)).toFixed(4)} USDC
                      </div>
                    </div>
                  </div>

                  {/* Withdrawal Form */}
                  {publicKey === dashboardAddress && parseFloat(dashboardShares) > 0 ? (
                    <form onSubmit={handleWithdrawSavings} style={{ borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '24px' }}>
                      <div className="form-group">
                        <label className="form-label" htmlFor="withdraw">Withdraw USDC from Savings Pool</label>
                        <div className="input-wrapper">
                          <DollarSign className="input-icon" size={18} />
                          <input
                            id="withdraw"
                            className="form-input"
                            type="number"
                            step="0.00001"
                            min="0.00001"
                            max={dashboardSavingsValue}
                            placeholder="USDC to pull"
                            value={withdrawAmount}
                            onChange={(e) => setWithdrawAmount(e.target.value)}
                            required
                          />
                        </div>
                        <span style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginTop: '6px', textAlign: 'right' }}>
                          Max withdrawable: {parseFloat(dashboardSavingsValue).toFixed(7)} USDC
                        </span>
                      </div>

                      <button className="btn-primary" type="submit" style={{ minHeight: '44px' }} disabled={submittingWithdraw || parseFloat(withdrawAmount) <= 0 || parseFloat(withdrawAmount) > parseFloat(dashboardSavingsValue)}>
                        {submittingWithdraw ? (
                          <>
                            <RefreshCw className="spinner" size={18} />
                            Executing Yield Withdrawal...
                          </>
                        ) : (
                          <>
                            <ArrowUpRight size={18} />
                            Withdraw Savings + Yield
                          </>
                        )}
                      </button>
                    </form>
                  ) : publicKey === dashboardAddress && parseFloat(dashboardShares) === 0 ? (
                    /* Empty savings state inside query panel */
                    <div className="empty-state-box" style={{ padding: '24px' }}>
                      <Coins size={28} style={{ opacity: 0.3, marginBottom: '8px' }} />
                      <p className="empty-state-text" style={{ fontSize: '13px' }}>Your savings pool balance is empty. Deposit or receive a remittance split to start earning yield.</p>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="empty-state-box">
                  <HelpCircle size={36} style={{ opacity: 0.3, marginBottom: '12px' }} />
                  <p className="empty-state-text">Search a recipient's public key to view their real-time savings accounting and accrued interest yield.</p>
                </div>
              )}
            </div>

            {/* TRANSACTION LOGS */}
            <div className="glass-card log-card">
              <h2 className="card-title">
                <Clock size={22} />
                Transaction History & Audit Logs
              </h2>

              {history.length === 0 ? (
                /* Clean Empty State for Audit logs */
                <div className="empty-state-box">
                  <FileText size={36} style={{ opacity: 0.3, marginBottom: '12px' }} />
                  <p className="empty-state-text">No transaction logs recorded in this session yet.</p>
                </div>
              ) : (
                <div className="log-table-container">
                  <table className="log-table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Type</th>
                        <th>Amount</th>
                        <th>Recipient/Details</th>
                        <th>Time</th>
                        <th>Hash</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((tx) => (
                        <tr key={tx.id}>
                          <td>{tx.id}</td>
                          <td>
                            <span className={`badge ${tx.type}`}>
                              {tx.type}
                            </span>
                          </td>
                          <td style={{ fontWeight: '600' }}>
                            {tx.amount} USDC
                          </td>
                          <td>
                            <span style={{ fontFamily: 'monospace', fontSize: '13px' }}>
                              {tx.recipient.substring(0, 6)}...{tx.recipient.substring(50)}
                            </span>
                          </td>
                          <td>{tx.timestamp}</td>
                          <td>
                            {tx.hash ? (
                              <a 
                                className="tx-hash-link" 
                                href={`https://stellar.expert/explorer/testnet/tx/${tx.hash}`}
                                target="_blank" 
                                rel="noopener noreferrer"
                              >
                                {tx.hash.substring(0, 8)}...
                              </a>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Pending</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Onboarding walkthrough Modal Overlay */}
      {showOnboarding && (
        <div className="onboarding-overlay">
          <div className="onboarding-card">
            <div className="onboarding-header">
              <div className="onboarding-icon-wrap">
                {onboardingStep === 0 && <Coins size={32} />}
                {onboardingStep === 1 && <Wallet size={32} />}
                {onboardingStep === 2 && <ArrowRightLeft size={32} />}
                {onboardingStep === 3 && <TrendingUp size={32} />}
              </div>
            </div>
            
            {onboardingStep === 0 && (
              <>
                <h3 className="onboarding-title">Welcome to RemitPool</h3>
                <p className="onboarding-text">
                  RemitPool is a premium cross-border remittance portal that helps users send funds while automatically allocating a micro-savings buffer to recipient wallets.
                </p>
              </>
            )}

            {onboardingStep === 1 && (
              <>
                <h3 className="onboarding-title">Integrated Fiat On-Ramp</h3>
                <p className="onboarding-text">
                  Securely convert national currency into mock USDC using our interactive SEP-24 Anchor integration. Developers can utilize Friendbot help to fund accounts instantly!
                </p>
              </>
            )}

            {onboardingStep === 2 && (
              <>
                <h3 className="onboarding-title">Auto-Savings Splitter</h3>
                <p className="onboarding-text">
                  Adjust the split percentage when sending remittances. The savings portion bypasses the recipient's main wallet and is deposited directly to their interest-earning pool.
                </p>
              </>
            )}

            {onboardingStep === 3 && (
              <>
                <h3 className="onboarding-title">Interest Accumulator</h3>
                <p className="onboarding-text">
                  Savings Pool balances accumulate yield continuously on-chain. Recipient users can search their public key to query and withdraw their accrued USDC and interest at any time!
                </p>
              </>
            )}

            <div className="onboarding-dots">
              {[0, 1, 2, 3].map((step) => (
                <div key={step} className={`onboarding-dot ${onboardingStep === step ? 'active' : ''}`} />
              ))}
            </div>

            <div className="onboarding-actions">
              <button 
                className="btn-secondary" 
                style={{ minHeight: '44px', border: 'none', background: 'none', color: 'var(--text-muted)' }} 
                onClick={() => {
                  localStorage.setItem('remitpool_onboarding_seen', 'true');
                  setShowOnboarding(false);
                }}
              >
                Skip Tour
              </button>
              
              <div style={{ display: 'flex', gap: '12px' }}>
                {onboardingStep > 0 && (
                  <button 
                    className="btn-secondary" 
                    style={{ minHeight: '44px' }} 
                    onClick={() => setOnboardingStep(prev => prev - 1)}
                  >
                    Back
                  </button>
                )}
                
                <button 
                  className="btn-primary" 
                  style={{ minHeight: '44px' }} 
                  onClick={() => {
                    if (onboardingStep < 3) {
                      setOnboardingStep(prev => prev + 1);
                    } else {
                      localStorage.setItem('remitpool_onboarding_seen', 'true');
                      setShowOnboarding(false);
                    }
                  }}
                >
                  {onboardingStep === 3 ? "Get Started" : "Next"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating Feedback Button */}
      <button className="feedback-floating-btn" onClick={() => setShowFeedbackModal(true)}>
        <Star size={24} />
      </button>

      {/* Feedback ratings modal overlay */}
      {showFeedbackModal && (
        <div className="onboarding-overlay">
          <form onSubmit={handleFeedbackSubmit} className="onboarding-card" style={{ textAlign: 'left' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 className="onboarding-title" style={{ margin: 0 }}>Provide Product Feedback</h3>
              <button type="button" className="btn-close" style={{ minHeight: '44px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }} onClick={() => setShowFeedbackModal(false)}>
                <X size={20} />
              </button>
            </div>

            <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '24px' }}>
              Rate your experience with RemitPool and share what features or styling improvements you would like to see in future releases.
            </p>

            <div className="form-group" style={{ textAlign: 'center' }}>
              <label className="form-label" style={{ marginBottom: '12px' }}>Product Rating</label>
              <div className="star-rating">
                {[1, 2, 3, 4, 5].map((rating) => (
                  <button
                    key={rating}
                    type="button"
                    className={`star-btn ${feedbackRating >= rating ? 'active' : ''}`}
                    onClick={() => setFeedbackRating(rating)}
                  >
                    <Star size={28} fill={feedbackRating >= rating ? '#fbbf24' : 'none'} />
                  </button>
                ))}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="comment">Comments or Feature Suggestions</label>
              <textarea
                id="comment"
                className="form-input"
                style={{ width: '100%', minHeight: '100px', resize: 'vertical', padding: '12px', background: 'rgba(0,0,0,0.2)', color: 'white', border: '1px solid var(--border-glass)', borderRadius: '12px', boxSizing: 'border-box' }}
                placeholder="How was the SEP-24 ramp flow? How can we make checking yield simpler?"
                value={feedbackComment}
                onChange={(e) => setFeedbackComment(e.target.value)}
              />
            </div>

            <button className="btn-primary" type="submit" style={{ width: '100%', minHeight: '44px', marginTop: '16px' }} disabled={submittingFeedback}>
              {submittingFeedback ? <RefreshCw className="spinner" size={18} /> : "Submit Feedback"}
            </button>
          </form>
        </div>
      )}

      {/* Admin metrics dashboard view modal */}
      {showAdminMetrics && (
        <div className="onboarding-overlay">
          <div className="onboarding-card" style={{ maxWidth: '800px', textAlign: 'left' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <h3 className="onboarding-title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Activity size={24} style={{ color: 'var(--primary)' }} />
                RemitPool Admin Analytics
              </h3>
              <button className="btn-close" style={{ minHeight: '44px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }} onClick={() => setShowAdminMetrics(false)}>
                <X size={20} />
              </button>
            </div>

            {loadingMetrics ? (
              <div style={{ padding: '60px 0', textAlign: 'center' }}>
                <RefreshCw className="spinner" size={36} />
                <p style={{ marginTop: '12px', color: 'var(--text-muted)' }}>Aggregating system-wide audit metrics...</p>
              </div>
            ) : metricsData ? (
              <div className="admin-dashboard">
                <div className="metrics-summary-grid">
                  <div className="metric-stat-card">
                    <div className="metric-stat-val">{metricsData.unique_wallets}</div>
                    <div className="metric-stat-label">Unique Wallets</div>
                  </div>
                  <div className="metric-stat-card">
                    <div className="metric-stat-val">{metricsData.total_completed_transactions}</div>
                    <div className="metric-stat-label">Total Tx</div>
                  </div>
                  <div className="metric-stat-card">
                    <div className="metric-stat-val">{metricsData.error_rate}</div>
                    <div className="metric-stat-label">Error Rate</div>
                  </div>
                  <div className="metric-stat-card">
                    <div className="metric-stat-val">{metricsData.average_feedback_rating}★</div>
                    <div className="metric-stat-label">Avg Rating</div>
                  </div>
                </div>

                <div className="metrics-detailed-panel">
                  {/* Feedback summary */}
                  <div className="metrics-sub-card">
                    <h4 className="metrics-sub-title">User Feedback Logs ({metricsData.total_feedback_count})</h4>
                    <div className="feedback-list">
                      {metricsData.raw_feedback.length === 0 ? (
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No feedback submitted yet.</p>
                      ) : (
                        metricsData.raw_feedback.map((fb) => (
                          <div key={fb.id} className="feedback-item">
                            <div className="feedback-item-header">
                              <span>Wallet: {fb.address.substring(0, 6)}...</span>
                              <span style={{ color: '#fbbf24', fontWeight: 'bold' }}>{fb.rating}★</span>
                            </div>
                            <div className="feedback-comment">"{fb.comment || 'No comment text'}"</div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* System Event Logs */}
                  <div className="metrics-sub-card">
                    <h4 className="metrics-sub-title">Recent System events</h4>
                    <div className="events-list">
                      {metricsData.raw_events.length === 0 ? (
                        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No analytics events recorded yet.</p>
                      ) : (
                        metricsData.raw_events.map((evt) => (
                          <div key={evt.id} className={`event-log-item ${evt.event_name === 'error' ? 'error' : ''}`}>
                            <span style={{ fontWeight: '600' }}>{evt.event_name}</span>
                            <span style={{ color: 'var(--text-muted)' }}>
                              {new Date(evt.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <p style={{ color: 'var(--text-muted)' }}>Failed to compile administrative metrics.</p>
            )}
          </div>
        </div>
      )}

      {/* Interactive Modal overlay */}
      {interactiveUrl && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-header">
              <h3>{interactiveTitle}</h3>
              <button className="btn-close" onClick={() => { setInteractiveUrl(''); setInteractiveTitle(''); }}>
                <X size={18} />
              </button>
            </div>
            <div className="iframe-container">
              <iframe 
                src={interactiveUrl} 
                className="ramp-iframe"
                title={interactiveTitle}
              />
            </div>
          </div>
        </div>
      )}

      {/* Toast Notifications */}
      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.type}`}>
            {toast.type === 'success' && <CheckCircle size={16} />}
            {toast.type === 'error' && <AlertTriangle size={16} />}
            {toast.type === 'info' && <Info size={16} />}
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
