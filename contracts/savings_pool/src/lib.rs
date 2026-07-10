#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol, log, Map};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Token,
    RatePerSec,
    TotalShares,
    TotalValue,
    LastAccrued,
    UserShares(Address),
}

const WEEK_IN_LEDGERS: u32 = 120960; // ~7 days assuming 5s per ledger
const BUMP_LIMIT: u32 = 518400; // ~30 days

fn get_token(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Token).unwrap()
}

fn get_rate_per_sec(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::RatePerSec).unwrap_or(0)
}

fn get_total_shares(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::TotalShares).unwrap_or(0)
}

fn get_total_value(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::TotalValue).unwrap_or(0)
}

fn get_last_accrued(env: &Env) -> u64 {
    env.storage().instance().get(&DataKey::LastAccrued).unwrap_or(0)
}

fn get_user_shares(env: &Env, user: &Address) -> i128 {
    let key = DataKey::UserShares(user.clone());
    if env.storage().persistent().has(&key) {
        env.storage().persistent().extend_ttl(&key, WEEK_IN_LEDGERS, BUMP_LIMIT);
        env.storage().persistent().get(&key).unwrap_or(0)
    } else {
        0
    }
}

fn set_user_shares(env: &Env, user: &Address, shares: i128) {
    let key = DataKey::UserShares(user.clone());
    env.storage().persistent().set(&key, &shares);
    env.storage().persistent().extend_ttl(&key, WEEK_IN_LEDGERS, BUMP_LIMIT);
}

fn extend_instance_ttl(env: &Env) {
    env.storage().instance().extend_ttl(WEEK_IN_LEDGERS, BUMP_LIMIT);
}

#[contract]
pub struct SavingsPoolContract;

#[contractimpl]
impl SavingsPoolContract {
    pub fn initialize(env: Env, token: Address, rate_per_second: i128) {
        if env.storage().instance().has(&DataKey::Token) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::RatePerSec, &rate_per_second);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
        env.storage().instance().set(&DataKey::TotalValue, &0i128);
        env.storage().instance().set(&DataKey::LastAccrued, &env.ledger().timestamp());
        extend_instance_ttl(&env);
    }

    pub fn accrue(env: Env) {
        extend_instance_ttl(&env);
        let last_accrued = get_last_accrued(&env);
        let now = env.ledger().timestamp();
        if now <= last_accrued {
            return;
        }

        let total_value = get_total_value(&env);
        if total_value <= 0 {
            env.storage().instance().set(&DataKey::LastAccrued, &now);
            return;
        }

        let elapsed = (now - last_accrued) as i128;
        let rate = get_rate_per_sec(&env);
        
        // Simulating compound/linear interest: interest = total_value * rate * elapsed / 1_000_000_000
        // rate_per_second is scaled by 1e9 (e.g. 100 = 100/1e9 = 1e-7 = 0.00001% per sec)
        let interest = (total_value * rate * elapsed) / 1_000_000_000i128;
        if interest > 0 {
            let new_value = total_value + interest;
            env.storage().instance().set(&DataKey::TotalValue, &new_value);
            log!(&env, "Accrued interest: {}, new total value: {}", interest, new_value);
        }
        env.storage().instance().set(&DataKey::LastAccrued, &now);
    }

    pub fn deposit(env: Env, funding_account: Address, owner: Address, amount: i128) {
        if funding_account != env.current_contract_address() {
            funding_account.require_auth();
        }
        if amount <= 0 {
            panic!("amount must be positive");
        }

        Self::accrue(env.clone());

        let total_shares = get_total_shares(&env);
        let total_value = get_total_value(&env);

        // Share Accounting Math:
        // shares_to_mint = amount * total_shares / total_value
        // If total_shares or total_value is zero, we assume a 1:1 ratio of shares to tokens.
        let shares_to_mint = if total_shares == 0 || total_value == 0 {
            amount
        } else {
            (amount * total_shares) / total_value
        };

        // Guard against rounding errors where depositor receives 0 shares for a positive deposit amount
        if shares_to_mint <= 0 {
            panic!("deposit amount is too small to mint shares");
        }

        let user_shares = get_user_shares(&env, &owner);
        set_user_shares(&env, &owner, user_shares + shares_to_mint);

        let new_total_shares = total_shares + shares_to_mint;
        let new_total_value = total_value + amount;

        env.storage().instance().set(&DataKey::TotalShares, &new_total_shares);
        env.storage().instance().set(&DataKey::TotalValue, &new_total_value);

        // Perform the transfer from funding_account to the pool
        if funding_account != env.current_contract_address() {
            let token_addr = get_token(&env);
            let token_client = soroban_sdk::token::Client::new(&env, &token_addr);
            token_client.transfer(&funding_account, &env.current_contract_address(), &amount);
        }

        // Emit pool deposit event
        env.events().publish(
            (Symbol::new(&env, "pool_deposit"), owner.clone()),
            (amount, shares_to_mint, new_total_value),
        );
    }

    pub fn withdraw(env: Env, owner: Address, shares: i128) -> i128 {
        owner.require_auth();
        if shares <= 0 {
            panic!("shares must be positive");
        }

        Self::accrue(env.clone());

        let total_shares = get_total_shares(&env);
        let total_value = get_total_value(&env);
        let user_shares = get_user_shares(&env, &owner);

        if total_shares <= 0 {
            panic!("no shares in the pool");
        }

        if shares > user_shares {
            panic!("insufficient shares");
        }

        // Share Accounting Math:
        // withdraw_amount = shares * total_value / total_shares
        let withdraw_amount = (shares * total_value) / total_shares;

        // Guard against rounding errors where withdrawable amount resolves to 0
        if withdraw_amount <= 0 {
            panic!("withdrawal amount is too small to receive tokens");
        }

        set_user_shares(&env, &owner, user_shares - shares);

        let new_total_shares = total_shares - shares;
        let new_total_value = total_value - withdraw_amount;

        env.storage().instance().set(&DataKey::TotalShares, &new_total_shares);
        env.storage().instance().set(&DataKey::TotalValue, &new_total_value);

        // Perform the transfer from the pool back to owner
        let token_addr = get_token(&env);
        let token_client = soroban_sdk::token::Client::new(&env, &token_addr);
        token_client.transfer(&env.current_contract_address(), &owner, &withdraw_amount);

        // Emit pool withdrawal event
        env.events().publish(
            (Symbol::new(&env, "pool_withdrawal"), owner.clone()),
            (withdraw_amount, shares, new_total_value),
        );

        withdraw_amount
    }

    pub fn get_balance(env: Env, owner: Address) -> i128 {
        // Return withdrawable balance, including accrued interest
        // But do not update the actual state variables, just do a read-only calculation
        let last_accrued = get_last_accrued(&env);
        let now = env.ledger().timestamp();
        let mut total_value = get_total_value(&env);
        let total_shares = get_total_shares(&env);
        let user_shares = get_user_shares(&env, &owner);

        if total_shares == 0 || user_shares == 0 {
            return 0;
        }

        if now > last_accrued && total_value > 0 {
            let elapsed = (now - last_accrued) as i128;
            let rate = get_rate_per_sec(&env);
            let interest = (total_value * rate * elapsed) / 1_000_000_000i128;
            total_value += interest;
        }

        (user_shares * total_value) / total_shares
    }

    pub fn get_shares(env: Env, owner: Address) -> i128 {
        get_user_shares(&env, &owner)
    }

    pub fn total_shares(env: Env) -> i128 {
        get_total_shares(&env)
    }

    pub fn total_pool_value(env: Env) -> i128 {
        get_total_value(&env)
    }
}

mod test;
