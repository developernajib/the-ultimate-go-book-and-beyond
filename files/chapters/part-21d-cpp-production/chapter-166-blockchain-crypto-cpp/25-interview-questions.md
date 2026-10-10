## Interview Questions

Fifteen questions calibrated for senior and staff engineer interviews at the major crypto employers. Each comes with an expected answer outline. The interviewer is looking for depth and the ability to navigate trade-offs.

### 1. Why does Bitcoin Core use libsecp256k1 instead of OpenSSL?

OpenSSL had several issues at the time of the migration (2015):

- **Constant-time was not guaranteed**. A signing routine that branches on key bits is vulnerable to cache-timing attacks.
- **Endomorphism support was missing**. The 2x speedup from secp256k1's GLV decomposition was not accessible.
- **Non-determinism in the codebase**. OpenSSL had configuration-dependent behavior that risked consensus drift.
- **Validation surface**. OpenSSL had a long history of CVEs in code paths Bitcoin did not need.

libsecp256k1 was written from scratch with constant-time guarantees, exhaustive testing, and pure C99 (no C++, no STL). It is now used by Bitcoin Core, Lightning implementations, most Bitcoin libraries in other languages via FFI, and Ethereum signing libraries.

### 2. Walk me through what happens when a Bitcoin block arrives at a node.

1. **P2P receive** (`net_processing.cpp`): the block message is parsed.
2. **Header check**: POW is validated, the block is linked into the block tree.
3. **Stateless block check** (`CheckBlock`): merkle root, transaction format, no duplicates.
4. **Stateful validation** (`ConnectBlock`): signatures via the parallel verify pool, double-spend check against UTXO, fee constraints.
5. **UTXO update**: spent outputs removed from cache, new outputs added.
6. **Chainstate flush** (periodic): write the cache to LevelDB.
7. **Tip update**: update `pindexBestHeader` and notify subscribers (wallets, RPC clients).

The senior detail: each of these phases acquires `cs_main` for different durations. Long phases must release the lock to avoid stalling other RPCs.

### 3. Why is Schnorr (BIP340) better than ECDSA for Bitcoin?

- **Linearity** enables MuSig2 multi-signature aggregation indistinguishable from single-sig.
- **64 bytes** vs. up to 72 for DER ECDSA.
- **Provable security** under standard assumptions in the random oracle model.
- **Batch verification** for whole-block speedup.
- **No malleability**: the signature is unique for a given key and message.
- **x-only public keys** save one byte per pubkey.

The cost: Schnorr is incompatible with existing ECDSA hardware wallets, which is why Taproot adoption was gradual.

### 4. Compare Solana's Sealevel with Aptos's Block-STM.

Sealevel is **declarative parallelism**: every transaction states which accounts it will read or write, and the scheduler partitions transactions into non-conflicting batches. The cost is that programs must precisely declare their accesses, mismatches are runtime errors.

Block-STM is **optimistic concurrency control**: transactions execute speculatively in parallel, and conflicts are detected after the fact and re-executed. The cost is wasted work on conflicts.

Sealevel is faster when conflict rate is low and programs are well-disciplined. Block-STM is more programmer-friendly because it handles conflicts transparently.

### 5. What is the Wagner attack on naive Schnorr aggregation, and how does MuSig2 fix it?

In a naive 1-round Schnorr aggregation, signers publish nonces, then a coordinator sums the nonces and challenges. A malicious signer can wait for other signers to publish nonces, then choose its own nonce adaptively to construct a valid forgery. Wagner's k-list algorithm makes this attack practical for k+1 simultaneous signing sessions.

MuSig2 adds a second round of nonce commitment: each signer publishes two nonces, and the final nonce is a linear combination of all signers' two nonces. The combination coefficients are chosen by hashing all participants' nonces, which prevents adaptive manipulation.

### 6. Why does Ethereum 2.0 use BLS12-381 and not secp256k1?

BLS12-381 has a **bilinear pairing**, which enables aggregate signatures. Ethereum 2.0 has up to 1 million validators, and each block aggregates roughly 30,000 attestations. Without aggregation, this is infeasible to verify or store.

secp256k1 has no pairing-friendly structure, so signatures cannot be aggregated cheaply.

The cost of BLS12-381 is roughly 4x slower scalar multiplication than secp256k1, and pairings are 100x slower than scalar multiplication. The aggregation savings dominate.

### 7. Walk me through how an MEV searcher constructs a sandwich attack.

1. Watch the public mempool for a large incoming swap on a DEX.
2. Simulate the swap against the current state to determine the price impact.
3. Construct a front-run transaction that buys the same token before the user's swap.
4. Construct a back-run transaction that sells after the user's swap.
5. Bundle the front-run and back-run with the user's transaction in a flashbots bundle.
6. Submit to a builder with a high priority fee and a fixed bundle order.

The defense for users is to use private mempools (Flashbots Protect, MEV Blocker) and tight slippage tolerances.

### 8. Design a price-time priority matching engine for 1M orders per second.

Key decisions:

- **Single-threaded per symbol**, multi-process for sharding.
- **Order book**: flat array indexed by price tick, intrusive doubly-linked list per level.
- **Order pool**: bump allocator for orders, no per-order malloc.
- **Sequencer**: external durable log, replicated via Raft.
- **Inputs**: lock-free SPSC queue from network thread to matching thread.
- **Outputs**: lock-free SPSC queue from matching thread to risk and market data threads.
- **Determinism**: every input has a sequence number, no wall-clock time used internally, no random numbers.
- **Latency**: target p50 50us, p99 200us. Use kernel-bypass NICs (Solarflare or Mellanox) and isolated CPU cores.

### 9. Compare Groth16, PlonK, and STARKs.

| Property | Groth16 | PlonK | STARK |
|---|---|---|---|
| Setup | Per-circuit trusted | Universal trusted | Transparent |
| Proof size | 192 B | ~500 B | 50-500 KB |
| Verifier time | 3 pairings | ~10 pairings | logarithmic FRI checks |
| Prover time | Lowest | Medium | Highest (but parallelizes well) |
| Post-quantum | No | No | Yes (hash-based) |
| Recursion-friendly | No | Yes (with PCG) | Yes |

For L1 verifier on Ethereum, Groth16 is cheapest. For modern rollups, PlonK or Halo2 dominate. For privacy-first chains and zkVMs, STARKs and Plonky2 are gaining ground.

### 10. What are the determinism rules for a Cosmos ABCI application?

- No floating-point operations in state transitions.
- No iteration over `std::unordered_map` or any hash-based container.
- No system time, no random numbers, no environment variables.
- No multi-threaded execution unless the scheduler is itself deterministic.
- No memory allocator behavior assumed (different allocators may produce different addresses).
- No undefined behavior (UB can produce different results across compilers).

A non-determinism bug stalls the chain because validators disagree on the `app_hash`.

### 11. How would you implement constant-time scalar comparison for a MAC tag?

```cpp
bool ct_equal(std::span<const std::uint8_t> a, std::span<const std::uint8_t> b) noexcept {
    if (a.size() != b.size()) return false;
    std::uint8_t diff = 0;
    for (std::size_t i = 0; i < a.size(); ++i) {
        diff |= a[i] ^ b[i];
    }
    return diff == 0;
}
```

The key property: every byte is examined regardless of where the first mismatch occurs. The compiler might optimize this if not careful. Use `volatile` accessors or `sodium_memcmp` for guaranteed constant-time behavior.

### 12. Why did the Wormhole bridge get hacked?

A Solana program flaw: the program received a guardian-signature input account but did not verify that the input account was the canonical secp256k1 sysvar. An attacker passed a fake account with self-signed data, which the program accepted.

The lesson is: validate every account argument's pubkey, not just its contents. In Solana, `assert!(account.key == &solana_program::sysvar::instructions::ID)` is mandatory before reading the sysvar.

### 13. Explain the three rounds of the Polygon zkEVM proving pipeline.

1. **Trace generation**: execute the batch on a constraint-friendly EVM (`zkProver Executor`), record per-opcode trace.
2. **Witness generation**: populate the constraint columns from the trace. Output is 50-100 GB for a typical batch.
3. **Polynomial commitment and opening**: run Plonky2 (FRI-based STARK), aggregate sub-proofs, wrap in a Groth16 proof for L1 verification.

The dominant cost is MSM (or NTT/FRI for Plonky2). GPU acceleration is essential.

### 14. What is a re-entrancy bug and how would you prevent it in C++?

Re-entrancy occurs when a callback re-invokes a function on an object whose state is mid-mutation. The DAO hack is the canonical example: the withdraw function called the user's fallback before updating the balance.

Prevention patterns:

- **Checks-effects-interactions** ordering: validate inputs, update state, then call out.
- **Re-entrancy guards**: a flag set at entry and cleared at exit, reject re-entry while set.
- **RAII state locks**: a scoped object that ensures consistent state before allowing external calls.
- **Pure functional state updates**: produce a new state, compare to old, commit atomically.

In C++ this is the same class of bug as iterator invalidation when calling user callbacks during iteration.

### 15. How do you bound a critical resource in a C++ blockchain service?

Every queue, buffer, cache, and connection pool must have an explicit bound. Examples:

- **Bounded SPSC queue**: `boost::lockfree::spsc_queue<T, capacity<N>>`.
- **Bounded LRU cache**: a fixed-size hashmap plus intrusive list, evicting on insert.
- **Connection pool**: explicit max-connections, reject new connects when at capacity.
- **Memory pool**: pre-allocated arena, fail allocation when exhausted rather than growing.

The Solana September 2021 outage was caused by an unbounded forwarding queue. Every senior interview at a validator team probes for this awareness.

---
