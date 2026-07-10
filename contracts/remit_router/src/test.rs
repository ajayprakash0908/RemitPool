#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::{Address as _, Events}, token, Address, Env, IntoVal};

// Register savings pool for testing cross-contract call
struct SavingsPoolContractMock;

#[soroban_sdk::contract]
pub struct MockSavingsPool;

#[soroban_sdk::contractimpl]
impl MockSavingsPool {
    pub fn initialize(env: Env, token: Address, rate_per_second: i128) {
        // Register actual SavingsPoolContract code here or do it via regular register_contract
    }
}

#[test]
fn test_remittance_router_flow() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    // 1. Setup token
    let token_admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract(token_admin.clone());
    let token_client = token::StellarAssetClient::new(&env, &token_addr);
    let token_token_client = token::Client::new(&env, &token_addr);

    // 2. Setup savings pool (using the actual savings pool contract!)
    // We import the compiled or source module of savings pool
    let pool_id = env.register_contract(None, savings_pool::SavingsPoolContract);
    let pool_client = savings_pool::SavingsPoolContractClient::new(&env, &pool_id);
    pool_client.initialize(&token_addr, &0i128); // 0 interest rate for simplicity in routing test

    // 3. Setup remit router
    let router_id = env.register_contract(None, RemitRouterContract);
    let router_client = RemitRouterContractClient::new(&env, &router_id);
    router_client.initialize(&token_addr, &pool_id);

    // Create accounts
    let sender = Address::generate(&env);
    let recipient = Address::generate(&env);

    // Mint tokens to sender
    token_client.mint(&sender, &1000);
    assert_eq!(token_token_client.balance(&sender), 1000);

    // 4. Send remittance with 30% savings percentage
    router_client.send_remittance(&sender, &recipient, &1000, &30);

    // 5. Assertions
    // Sender should have 0 tokens
    assert_eq!(token_token_client.balance(&sender), 0);
    // Recipient should have 700 tokens directly
    assert_eq!(token_token_client.balance(&recipient), 700);
    // Savings pool should have 300 tokens
    assert_eq!(token_token_client.balance(&pool_id), 300);
    // Recipient should have 300 shares in the savings pool
    assert_eq!(pool_client.get_shares(&recipient), 300);
    assert_eq!(pool_client.get_balance(&recipient), 300);

    // 6. Verify emitted events
    let events = env.events().all();
    // Verify remittance_sent event was published
    // The events list includes token transfers and pool deposits. We check for the router's event.
    let mut found_remit_event = false;
    for event in events.iter() {
        if event.0 == router_id {
            found_remit_event = true;
            let topic0: Symbol = event.1.get(0).unwrap().into_val(&env);
            let topic1: Address = event.1.get(1).unwrap().into_val(&env);
            let topic2: Address = event.1.get(2).unwrap().into_val(&env);
            assert_eq!(topic0, Symbol::new(&env, "remittance_sent"));
            assert_eq!(topic1, sender);
            assert_eq!(topic2, recipient);
            // value is (amount, save_percent, direct_amount, save_amount)
            // i128, u32, i128, i128
            let value: (i128, u32, i128, i128) = event.2.clone().into_val(&env);
            assert_eq!(
                value,
                (1000i128, 30u32, 700i128, 300i128)
            );
        }
    }
    assert!(found_remit_event, "remittance_sent event not found");
}

#[test]
#[should_panic(expected = "sender and recipient must be different")]
fn test_remit_router_self_payment() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let token_admin = Address::generate(&env);
    let token_addr = env.register_stellar_asset_contract(token_admin.clone());

    let pool_id = env.register_contract(None, savings_pool::SavingsPoolContract);
    let pool_client = savings_pool::SavingsPoolContractClient::new(&env, &pool_id);
    pool_client.initialize(&token_addr, &0i128);

    let router_id = env.register_contract(None, RemitRouterContract);
    let router_client = RemitRouterContractClient::new(&env, &router_id);
    router_client.initialize(&token_addr, &pool_id);

    let sender = Address::generate(&env);
    router_client.send_remittance(&sender, &sender, &100, &30); // should panic
}
