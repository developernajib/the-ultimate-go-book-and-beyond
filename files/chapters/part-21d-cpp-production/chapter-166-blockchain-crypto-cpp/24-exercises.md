## Exercises

Six labs at increasing difficulty. Each is a complete, self-contained project. Plan a half day for the first two and a full day for the rest. By the end you will have built measurable, runnable artifacts that go on a portfolio.

### Lab 1: Constant-Time AEAD Wallet Keystore

**Goal.** Build a CLI tool that creates, encrypts, and decrypts a keystore file holding a secp256k1 private key, using XChaCha20-Poly1305 and Argon2id.

**Requirements.**

- Generate a fresh 32-byte private key from `/dev/urandom`.
- Prompt for a password without echo.
- Derive a 32-byte AEAD key with Argon2id at SENSITIVE settings (target 3 seconds, 1 GB memory).
- Generate a random 24-byte nonce.
- Encrypt the private key plus a 16-byte AAD containing the keystore version and creation timestamp.
- Serialize to JSON: salt, nonce, ciphertext (base64), kdf parameters, AEAD algorithm name.
- Decrypt path: read the file, prompt for password, derive key, decrypt, print public key (compressed) only.
- Use `sodium_memzero` on every secret on exit.

**Stretch goals.**

- Add a `--passphrase` flag that reads from stdin for scripting.
- Add BIP-39 mnemonic generation as an alternative to raw key bytes.
- Benchmark Argon2id parameters and document the time-memory trade-off.

**Reference libraries.** libsodium, libsecp256k1, nlohmann::json or simdjson.

### Lab 2: Bitcoin Block Verifier

**Goal.** Given a serialized Bitcoin block (hex-encoded), validate it: header POW, merkle root, every transaction's basic sanity (no duplicate inputs, sum of outputs less than sum of inputs).

**Requirements.**

- Parse Bitcoin's binary block format (BIP-141 with witness data).
- Verify the proof of work: `double_sha256(header) < target`.
- Recompute the merkle root from txids and compare against the header.
- For each transaction, verify it has at least one input and one output, no duplicate inputs.
- For coinbase, verify the input vout is `0xffffffff` and the scriptSig length is between 2 and 100 bytes.
- Output a one-line JSON report per transaction: `{ txid, vsize, fee_satoshis, n_inputs, n_outputs, ok }`.

**Skip.** Signature validation (covered in Lab 4). UTXO lookup. Fee constraints.

**Reference data.** Download a recent block at `https://blockstream.info/api/block-height/<H>/raw`.

### Lab 3: Lock-Free Order Book

**Goal.** Build a single-threaded matching engine for one symbol that handles 1M orders per second on a single core.

**Requirements.**

- Order types: limit and market, with GTC and IOC time-in-force.
- Order book backed by a flat array of price levels indexed by tick, with an intrusive linked list per level.
- Order ID lookup by hash table for cancels.
- Inputs: a vector of pre-loaded orders with explicit timestamps.
- Outputs: a vector of fill events.
- Order pool: pre-allocated `std::pmr::monotonic_buffer_resource`.

**Test cases.**

- Crossing limit orders produce expected fills.
- Cancels remove orders from the book and update best bid/ask.
- IOC orders match against the top of book and cancel any remainder.
- 1M orders processed in under 1 second on a recent x86 core.

**Stretch goals.**

- Add a deterministic replay log: reading the log on a fresh engine reproduces the same fills.
- Add POST_ONLY orders: reject if they would cross the spread.

### Lab 4: Schnorr Batch Verifier (Taproot)

**Goal.** Given a list of Taproot signatures, public keys, and messages, verify them using libsecp256k1's batch API and compare wall-clock time against sequential verification.

**Requirements.**

- Generate 10,000 random keypairs and sign 10,000 random 32-byte messages with BIP340 Schnorr.
- Verify all 10,000 sequentially. Record wall-clock time.
- Verify all 10,000 in batch using `secp256k1_schnorrsig_verify_batch`. Record wall-clock time.
- Print the speedup ratio.
- Inject a single bad signature at index 4321. Confirm batch verify reports failure but does not identify which signature failed, fall back to sequential to find the bad one.

**Stretch goals.**

- Vary batch sizes (10, 100, 1000, 10000) and plot the speedup curve.
- Compare with Ed25519 batch verify (libsodium) on the same dataset.

### Lab 5: Mempool Listener and Arb Detector

**Goal.** Connect to a local Geth or Reth node's WebSocket pending-transactions stream, parse incoming transactions, and detect potential Uniswap V2-style arbitrage opportunities between two pools.

**Requirements.**

- Connect to `ws://localhost:8546` and subscribe to `newPendingTransactions`.
- For each pending transaction, fetch the full transaction and decode the input data.
- If the transaction calls `swapExactTokensForTokens` or `swapTokensForExactTokens` on Uniswap V2 router, compute the predicted post-swap state of the affected pool.
- Check whether the predicted state creates a profitable arb against another known pool (e.g., SushiSwap on the same pair).
- Print a one-line summary per detected opportunity: `{ tx_hash, victim_pool, arb_profit_estimate_wei }`.

**Skip.** Actually submitting an arb bundle. Real-time simulation.

**Reference libraries.** simdjson for JSON parsing, secp256k1 for signature recovery, web3cpp or hand-rolled RLP for transaction decoding.

**Stretch goals.**

- Maintain a local cache of pool reserves updated from the canonical chain.
- Add a profitability gate: only print opportunities above \$50 profit.

### Lab 6: Mini zkSNARK Verifier

**Goal.** Implement a Groth16 verifier in C++ from scratch. Verify a precomputed proof against a precomputed verification key for a hello-world circuit (e.g., `x * y = z` with x and y as private inputs, z as a public input).

**Requirements.**

- Use a pairing-friendly curve. BN254 is recommended via the `bn256` reference C++ implementation or `mcl`.
- Parse the verification key in JSON format produced by snarkjs:

```json
{
  "alpha": [...],
  "beta": [...],
  "gamma": [...],
  "delta": [...],
  "ic": [[...], [...], ...]
}
```

- Parse the proof in JSON format: `{ a, b, c }`.
- Compute the verification equation: `e(A, B) == e(alpha, beta) * e(L, gamma) * e(C, delta)` where `L = ic[0] + sum(public_inputs[i] * ic[i+1])`.
- Output `valid` or `invalid`.

**Skip.** Building the circuit. Generating the proof. Use snarkjs to produce both, then verify in your C++.

**Reference circuit.** A 2-input multiplier from the snarkjs README. Generate setup and proof using snarkjs, then verify with your C++ code.

**Stretch goals.**

- Add support for batched verification of multiple proofs against the same verification key.
- Profile the verifier and identify the dominant cost (it should be the three pairings, ~3 ms each).

---

Each lab teaches a real skill that maps to a job category. Lab 1 maps to wallet engineering. Lab 2 to Bitcoin Core. Lab 3 to exchange engines. Lab 4 to validator performance. Lab 5 to MEV. Lab 6 to zk infrastructure. Pick the lab closest to the role you want and build it well enough to put on GitHub.

---
