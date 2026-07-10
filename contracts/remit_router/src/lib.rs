#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, log};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Token,
    SavingsPool,
}

// Client interface for savings pool contract cross-contract calls
#[soroban_sdk::contractclient(name = "SavingsPoolClient")]
pub trait SavingsPoolInterface {
    fn deposit(env: Env, funding_account: Address, owner: Address, amount: i128);
}

const WEEK_IN_LEDGERS: u32 = 120960;
const BUMP_LIMIT: u32 = 518400;

fn get_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Token).unwrap()
}

fn get_savings_pool(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::SavingsPool).unwrap()
}

fn extend_instance_ttl(env: &Env) {
    env.storage().instance().extend_ttl(WEEK_IN_LEDGERS, BUMP_LIMIT);
}

#[contract]
pub struct RemitRouterContract;

#[contractimpl]
impl RemitRouterContract {
    pub fn initialize(env: Env, token: Address, savings_pool: Address) {
        if env.storage().instance().has(&DataKey::Token) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::SavingsPool, &savings_pool);
        extend_instance_ttl(&env);
    }

    pub fn send_remittance(
        env: Env,
        sender: Address,
        recipient: Address,
        amount: i128,
        save_percent: u32,
    ) {
        sender.require_auth();
        extend_instance_ttl(&env);

        if sender == recipient {
            panic!("sender and recipient must be different");
        }

        if amount <= 0 {
            panic!("amount must be positive");
        }
        if save_percent > 100 {
            panic!("save percent must be between 0 and 100");
        }

        let token_addr = get_token(&env);
        let savings_pool_addr = get_savings_pool(&env);

        // Pull total amount from sender to router first
        let token_client = soroban_sdk::token::Client::new(&env, &token_addr);
        token_client.transfer(&sender, &env.current_contract_address(), &amount);

        // Calculate direct and savings amounts
        let save_amount = (amount * save_percent as i128) / 100i128;
        let direct_amount = amount - save_amount;

        // Route direct payment to recipient
        if direct_amount > 0 {
            token_client.transfer(&env.current_contract_address(), &recipient, &direct_amount);
        }

        // Route savings portion to savings pool
        if save_amount > 0 {
            // Transfer the tokens directly from the router to the savings pool contract
            token_client.transfer(&env.current_contract_address(), &savings_pool_addr, &save_amount);

            // Call deposit on the savings pool contract, passing the pool contract itself as the funding account
            let pool_client = SavingsPoolClient::new(&env, &savings_pool_addr);
            pool_client.deposit(&savings_pool_addr, &recipient, &save_amount);
        }

        // Emit remittance sent event
        env.events().publish(
            (
                Symbol::new(&env, "remittance_sent"),
                sender.clone(),
                recipient.clone(),
            ),
            (amount, save_percent, direct_amount, save_amount),
        );

        log!(
            &env,
            "Remitted: total={}, save_percent={}, direct={}, savings={}",
            amount,
            save_percent,
            direct_amount,
            save_amount
        );
    }

    pub fn get_token_address(env: Env) -> Address {
        get_token(&env)
    }

    pub fn get_savings_pool_address(env: Env) -> Address {
        get_savings_pool(&env)
    }
}

mod test;
