## Security Incident Postmortems

Every senior crypto engineer should know the major security incidents in detail. The patterns that caused them recur, and a code review that misses one of these patterns is a code review that ships a multimillion-dollar vulnerability. This section walks through six incidents, each from a different category of failure, and identifies the C++ pattern that would have prevented each.

### Bitcoin BIP-66 Forking Bug (July 2015)

**What happened.** BIP-66 mandated strict DER-encoded ECDSA signatures starting at block 363,724. Some miners and SPV wallets had not upgraded. A miner produced a block with a non-strict signature. Older nodes accepted it. New nodes rejected it. The chain forked for several hours, with miners on both sides producing blocks. The fork was resolved when 51 percent of miners switched to the upgraded rules.

**Root cause.** The transition to strict DER was a soft fork, but several large miners ran SPV mining: they would mine on top of a block hash before validating the block's contents. When an older miner produced a block that the new rules would reject, SPV miners built on top of it without checking, creating a block on the now-invalid chain.

**The C++ lesson.** A consensus rule activation must be tested with full deployment, not just simulated. A miner that does not validate before mining is a hazard to the entire network. After BIP-66, Bitcoin Core added stronger warnings about SPV mining and the BIP-9 / BIP-8 activation mechanisms with more extensive testing.

### Ethereum DAO Hack (June 2016)

**What happened.** The DAO contract had a re-entrancy bug. The withdrawal function sent ETH to the caller before updating the caller's balance. The caller's fallback function called `withdraw` again, draining the contract recursively. Total stolen: 3.6M ETH (roughly \$50M at the time, \$11B at 2025 prices).

**Root cause.** The Solidity pattern `call.value(amount)()` allowed external code execution before state was updated. The DAO followed the textbook pattern of the time, which the textbook was wrong about.

**The C++ lesson.** Re-entrancy is the same class of bug as **iterator invalidation in C++**. If you call a callback that might modify the container you are iterating, your iterator is invalid. The defense is the same: update state first, call out second. Modern Solidity patterns use the "checks-effects-interactions" rule. C++ engineers see this every time they write `for (auto it = vec.begin(); it != vec.end(); ++it) { call_user_callback(it); }` and have to think hard about whether the callback can modify `vec`.

### Solana Validator OOM (September 2021)

**What happened.** On September 14, 2021, Solana mainnet halted for 17 hours. A flood of transactions targeting an IDO event grew to 400,000 per second. Validator memory usage exploded as transactions piled up in the forwarding queue. Validators ran out of memory, crashed, restarted, and crashed again.

**Root cause.** The transaction forwarding queue had no upper bound. Under sustained load above the network's processing capacity, the queue grew without limit. Each validator's RAM usage grew linearly with time until OOM-killed.

**The C++ lesson.** Every queue must have a bounded capacity. Use `boost::lockfree::spsc_queue` with a size template parameter, or `std::queue` with explicit size checks. A queue without a bound is a queue with an implicit bound at OOM, which is the worst possible failure mode.

The fix: Solana added `--rpc-pubsub-max-active-subscriptions`, transaction forwarding rate limits, and stake-weighted QoS that prioritizes transactions from large validators.

### Wormhole Bridge Hack (February 2022, \$326M)

**What happened.** The Wormhole bridge's Solana program had a flaw in its signature verification. The program received a guardian signature set and was supposed to verify the signatures against the canonical secp256k1 sysvar. The flaw: the program did not check that the input account was the actual sysvar. An attacker passed a fake account containing self-signed data, and the program accepted it.

**Root cause.** Trusting account contents without verifying account identity. The Solana program had `solana_program::sysvar::instructions::ID` to check against, but the check was missing.

**The C++ lesson.** **Validate every input.** In Solana program development, this means verifying the pubkey of every account argument. In C++ generally, this means treating every external input as adversarial. A pointer received from an external interface must be validated against expected ranges before dereferencing.

### Nomad Bridge Hack (August 2022, \$190M)

**What happened.** A routine upgrade set the trusted Merkle root to `bytes32(0)`. Every Merkle proof against the zero root succeeded trivially because the zero root accepts the empty proof for the zero leaf. Hundreds of attackers piled in to copy the original exploiter's transaction with their own addresses, draining the bridge in 90 minutes.

**Root cause.** A configuration value that gates cryptographic verification was initialized to a value that disables the check.

**The C++ lesson.** **Default values must be safe.** A cryptographic verifier should default to "reject everything", not "accept nothing meaningful". Use sentinel types that require explicit initialization:

```cpp
class TrustedRoot {
public:
    static TrustedRoot make(const Hash256& h) {
        if (h == Hash256{}) throw std::invalid_argument("zero root not allowed");
        return TrustedRoot{h};
    }

    [[nodiscard]] const Hash256& value() const noexcept { return value_; }

private:
    explicit TrustedRoot(const Hash256& h) : value_(h) {}
    Hash256 value_;
};
```

A `TrustedRoot` cannot be default-constructed, cannot hold zero, and is checked at construction time.

### Ronin Bridge Hack (March 2022, \$625M)

**What happened.** Sky Mavis's Ronin bridge had 9 validators with a 5-of-9 threshold. An attacker compromised 4 validator nodes via spear-phishing. To get the 5th key, the attacker exploited a backdoor: Sky Mavis had previously authorized a third-party DAO to use one of its validator keys, and never revoked the authorization. The attacker compromised the DAO's signing infrastructure and forged the 5th signature.

**Root cause.** Operational security failure: spear-phishing of operators, plus a forgotten authorization that was not revoked.

**The C++ lesson.** This is not directly a C++ bug, but it illustrates that **threshold signatures are only as strong as the operational security of the threshold members**. A C++ engineer building threshold-signature infrastructure must support fast key rotation, time-bounded authorization, and revocable delegations. The classic anti-pattern is a "permanent" delegation API with no expiry.

### Curve Finance Read-Only Re-entrancy (April 2023)

**What happened.** A re-entrancy attack via the read-only `get_virtual_price` function. The function did not have a re-entrancy guard, but it read state that was inconsistent during a withdraw operation. Other protocols that integrated `get_virtual_price` as an oracle were tricked into accepting wrong prices.

**Root cause.** Re-entrancy guards are typically applied to state-mutating functions. View functions are assumed safe. But during a withdrawal callback, the contract's state is in an intermediate state, and any view function called during that callback returns wrong data.

**The C++ lesson.** Re-entrancy via callbacks affects view operations too. A `const` method in C++ can return inconsistent data if the object's state is mid-mutation when the callback fires. The defense is to ensure that callbacks only fire when the object is in a consistent state. RAII helps: a scoped lock that ensures consistency before any external call:

```cpp
class WithdrawTransaction {
public:
    WithdrawTransaction(Pool& p) : pool_(p), lock_(p.consistency_lock_) {}

    void execute(User& user, Amount amount) {
        // mutate balances first
        pool_.balances[user.id] -= amount;
        pool_.total -= amount;
        // only now release the lock and call out
        lock_.unlock();
        user.receive(amount);
    }

private:
    Pool& pool_;
    std::unique_lock<std::mutex> lock_;
};
```

### Cross-Cutting Patterns

Looking across all six incidents, the recurring patterns:

- **Trust boundaries are often unstated**. The DAO assumed callers were honest. Wormhole assumed input accounts were canonical. Both lost.
- **Default-deny vs. default-allow**. Nomad defaulted to allow. The fix is always default-deny.
- **Unbounded resources kill systems**. Solana's queue was unbounded. The fix is always to bound.
- **Soft forks are hard**. BIP-66's miner upgrade lag took years to fully resolve. Modern soft forks use opt-in signaling and longer activation windows.
- **View functions can be wrong**. Curve's read-only re-entrancy is the same pattern as TOCTTOU (time-of-check to time-of-use) in classic systems software.

### Senior Track Notes

- **Postmortems are public artifacts**. Bitcoin Core, Ethereum Foundation, Solana Labs, Wormhole, Nomad, and Curve have all published detailed writeups. Read them. Memorize them. Bring them up in technical interviews.
- **Bug bounties are operational**. The largest crypto bounties (Optimism's \$2M, Aave's \$250k, Uniswap's \$250k) attract serious researchers. A senior engineer should know how to write a bug bounty report and how to triage incoming ones.
- **Formal verification adoption is growing**. The Move Prover, Certora's Solana verifier, and Halmos for Solidity are real tools that catch real bugs before deployment. C++ engineers building consensus logic should also use TLA+ or similar for the protocol-level invariants.
- **Continuous fuzzing is mandatory**. Bitcoin Core, Geth, Reth, and the major prover libraries all run continuous fuzzing on OSS-Fuzz. A new feature without a fuzz harness is not ready to merge.

The next section moves into AI-driven trading and how machine learning intersects with C++ trading infrastructure.

---
