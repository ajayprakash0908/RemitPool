#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::{Address as _, Ledger}, token, Address, Env};

#[test]
fn test_savings_pool_flow() {
    let env = Env::default();
    env.mock_all_auths();

    // Set initial ledger time
    env.ledger().set_timestamp(1000);

    // Register token contract
    let token_admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract(token_admin.clone());
    let token_client = token::StellarAssetClient::new(&env, &token_addr);
    let token_token_client = token::Client::new(&env, &token_addr);

    // Register savings pool contract
    let pool_id = env.register_contract(None, SavingsPoolContract);
    let pool_client = SavingsPoolContractClient::new(&env, &pool_id);

    // Initialize pool with a high rate: 0.0001% per second (100,000 / 1e9)
    // Scaled by 1e9: 100_000 is 1e-4 per second (which is 0.01% per second)
    // Let's use 1_000_000 (0.1% per second) to make it super visible in tests.
    let rate_per_second: i128 = 1_000_000; 
    pool_client.initialize(&token_addr, &rate_per_second);

    // Create users
    let user_a = Address::generate(&env);
    let user_b = Address::generate(&env);

    // Mint tokens to users
    token_client.mint(&user_a, &1000);
    token_client.mint(&user_b, &1000);

    assert_eq!(token_token_client.balance(&user_a), 1000);
    assert_eq!(token_token_client.balance(&user_b), 1000);

    // 1. User A deposits 500 tokens
    pool_client.deposit(&user_a, &user_a, &500);

    assert_eq!(token_token_client.balance(&user_a), 500);
    assert_eq!(token_token_client.balance(&pool_id), 500);
    assert_eq!(pool_client.get_shares(&user_a), 500);
    assert_eq!(pool_client.total_shares(), 500);
    assert_eq!(pool_client.total_pool_value(), 500);
    assert_eq!(pool_client.get_balance(&user_a), 500);

    // 2. Accrue yield by bumping time by 100 seconds
    // Interest should be: total_value * rate * elapsed / 1_000_000_000
    // = 500 * 1_000_000 * 100 / 1_000_000_000 = 50 tokens
    env.ledger().set_timestamp(1100);

    // Read balance (calculates lazy accrual)
    assert_eq!(pool_client.get_balance(&user_a), 550);

    // Trigger explicit accrue
    pool_client.accrue();
    assert_eq!(pool_client.total_pool_value(), 550);

    // 3. User B deposits 550 tokens at this new valuation
    // Since total_value is 550 and total_shares is 500, User B should get:
    // shares = (550 * 500) / 550 = 500 shares.
    pool_client.deposit(&user_b, &user_b, &550);

    assert_eq!(token_token_client.balance(&user_b), 450);
    assert_eq!(token_token_client.balance(&pool_id), 1050); // 500 + 550 in tokens
    assert_eq!(pool_client.get_shares(&user_b), 500);
    assert_eq!(pool_client.total_shares(), 1000);
    assert_eq!(pool_client.total_pool_value(), 1100); // 550 + 550

    // 4. Accrue yield again by bumping time by 100 seconds
    // Interest should be: 1100 * 1_000_000 * 100 / 1_000_000_000 = 110 tokens
    env.ledger().set_timestamp(1200);

    assert_eq!(pool_client.get_balance(&user_a), 605); // A has 50% shares -> 550 + 55 = 605
    assert_eq!(pool_client.get_balance(&user_b), 605); // B has 50% shares -> 550 + 55 = 605

    // Let's fund the pool with some reserve tokens to cover the accrued interest
    // In our mock/test, the pool contract needs to have the actual token balance to cover withdrawals.
    // Let's mint 1000 reserve tokens directly to the pool contract
    token_client.mint(&pool_id, &1000);

    // 5. User A withdraws all 500 shares
    let withdrawn_a = pool_client.withdraw(&user_a, &500);
    assert_eq!(withdrawn_a, 605);
    assert_eq!(token_token_client.balance(&user_a), 1105); // 500 + 605
    assert_eq!(pool_client.get_shares(&user_a), 0);
    assert_eq!(pool_client.total_shares(), 500);

    // 6. User B withdraws 250 shares (half of their shares)
    // Total pool value is now 1210 - 605 = 605. Total shares is 500.
    // 250 shares should withdraw: (250 * 605) / 500 = 302
    let withdrawn_b = pool_client.withdraw(&user_b, &250);
    assert_eq!(withdrawn_b, 302); // 302.5 truncated to 302
    assert_eq!(token_token_client.balance(&user_b), 752); // 450 + 302
    assert_eq!(pool_client.get_shares(&user_b), 250);
}

#[test]
#[should_panic(expected = "insufficient shares")]
fn test_unauthorized_withdraw_limits() {
    let env = Env::default();
    env.mock_all_auths();

    let token_admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract(token_admin.clone());
    let token_client = token::StellarAssetClient::new(&env, &token_addr);

    let pool_id = env.register_contract(None, SavingsPoolContract);
    let pool_client = SavingsPoolContractClient::new(&env, &pool_id);
    pool_client.initialize(&token_addr, &1_000_000);

    let user = Address::generate(&env);
    token_client.mint(&user, &100);

    pool_client.deposit(&user, &user, &100);
    pool_client.withdraw(&user, &101); // should panic
}

#[test]
#[should_panic(expected = "deposit amount is too small to mint shares")]
fn test_deposit_too_small_shares() {
    let env = Env::default();
    env.mock_all_auths();

    // Set initial ledger time
    env.ledger().set_timestamp(1000);

    let token_admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract(token_admin.clone());
    let token_client = token::StellarAssetClient::new(&env, &token_addr);

    let pool_id = env.register_contract(None, SavingsPoolContract);
    let pool_client = SavingsPoolContractClient::new(&env, &pool_id);
    // Initialize pool with a very high interest rate (1_000_000 = 0.1% per sec)
    pool_client.initialize(&token_addr, &1_000_000);

    let user_a = Address::generate(&env);
    let user_b = Address::generate(&env);

    token_client.mint(&user_a, &10);
    token_client.mint(&user_b, &10);

    // User A deposits 10 tokens -> gets 10 shares
    pool_client.deposit(&user_a, &user_a, &10);

    // Bump ledger timestamp by 900 seconds
    // Interest: elapsed = 900, rate = 1_000_000. Interest = 10 * 1_000_000 * 900 / 1e9 = 9 tokens.
    // Total pool value is now 19 tokens, total shares is 10 shares.
    env.ledger().set_timestamp(1900);
    pool_client.accrue();

    // User B tries to deposit 1 token
    // shares_to_mint = 1 * 10 / 19 = 10 / 19 = 0 shares.
    // This must panic due to rounding!
    pool_client.deposit(&user_b, &user_b, &1);
}



#[test]
#[should_panic(expected = "no shares in the pool")]
fn test_withdraw_no_shares() {
    let env = Env::default();
    env.mock_all_auths();

    let token_admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract(token_admin.clone());

    let pool_id = env.register_contract(None, SavingsPoolContract);
    let pool_client = SavingsPoolContractClient::new(&env, &pool_id);
    pool_client.initialize(&token_addr, &0i128);

    let user = Address::generate(&env);
    pool_client.withdraw(&user, &1); // should panic because pool has 0 shares
}
