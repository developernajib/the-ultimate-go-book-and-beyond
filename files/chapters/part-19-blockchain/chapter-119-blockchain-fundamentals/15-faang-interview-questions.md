## 119.14 FAANG Interview Questions

**Q1: How does Proof-of-Work deter Sybil attacks, and why is Proof-of-Stake considered a viable alternative?**
A: PoW binds voting power to real-world compute cost, so creating many identities gains no advantage without proportional hardware and energy. PoS replaces compute with economic stake, so misbehavior is deterred by slashing staked capital. Both achieve Sybil resistance, but PoS removes the energy externality while introducing long-range attack and validator-cartelization risks that PoW does not have.

**Q2: Why does Bitcoin use a UTXO model while Ethereum uses accounts, and what tradeoffs follow?**
A: UTXOs enable parallel validation, simple double-spend checks, and stateless verification, which suits pure payment workloads. Accounts simplify stateful contract logic and balance tracking at the cost of sequential nonce enforcement and harder parallelization. Ethereum's choice reflects smart-contract expressiveness as the primary goal, not payment throughput.

**Q3: How do Merkle trees enable light clients, and what are their limits?**
A: A Merkle root commits to all transactions, so a light client can verify inclusion with a logarithmic proof rather than downloading every block body. The limit is that Merkle proofs verify inclusion but not validity rules or global state, so light clients still rely on honest majority assumptions or fraud-proof systems.

**Q4: When designing a Go node client, why pass `*big.Int` for balances instead of `uint64`?**
A: Wei values scale to 10^18 per ETH, which overflows `uint64`. Arbitrary-precision arithmetic is required for correct addition, subtraction, and comparison across balances, fees, and transfer amounts. Using `float64` introduces rounding that silently corrupts ledgers, which is why `*big.Int` is the canonical representation.

**Q5: How would you structure a Go service that submits transactions concurrently from one account without nonce collisions?**
A: Centralize nonce assignment in a mutex-guarded or channel-backed nonce manager that reads `PendingNonceAt` once at startup, then atomically allocates increasing nonces to each outgoing transaction. On failure, gapped nonces are reclaimed by either resubmitting with the same nonce and a higher fee or canceling via a zero-value self-send at the gapped nonce.

