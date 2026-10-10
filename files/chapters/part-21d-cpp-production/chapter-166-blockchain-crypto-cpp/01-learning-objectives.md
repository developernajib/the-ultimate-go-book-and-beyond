## Learning Objectives

By the end of this chapter, you will be able to operate at senior or staff engineer level on a blockchain core team, an exchange matching engine team, or a zero-knowledge prover team. The objectives below are grouped by job family. Each one maps to a section in the chapter.

### Cryptography

You will be able to:

- Choose between SHA-256, SHA-3, BLAKE2, and BLAKE3 based on throughput, ASIC resistance, and length-extension properties, and justify the choice in a design review.
- Implement a constant-time AEAD wrapper around BoringSSL or libsodium, with no data-dependent branches and proper handling of nonce reuse.
- Explain why Argon2id is preferred over PBKDF2 for password-based key derivation in modern wallets, and tune memory and time parameters for a 100ms target.
- Use libsecp256k1 correctly for ECDSA signing, batch verification, Schnorr (BIP340), and ECDH, including the precomputed multiplication tables and scratch space allocation.
- Aggregate Ed25519 public keys for Solana stake-weighted voting, and verify BLS12-381 aggregate signatures for Ethereum 2.0 attestations.
- Implement BIP340 Schnorr from scratch and explain why MuSig2 requires two rounds of nonce commitment to prevent the Wagner attack.

### Blockchain Core Engineering

You will be able to:

- Navigate the Bitcoin Core source tree, identify which files implement the consensus engine, the mempool, the wallet, and the P2P layer, and explain the libbitcoinkernel extraction.
- Read a Bitcoin Script transaction, manually evaluate the witness, identify whether it is P2PKH, P2WSH, or Taproot, and verify the BIP341 sighash computation.
- Build and verify a binary Merkle tree for a Bitcoin block, an account-state Merkle Patricia Trie for Ethereum, and a sparse Merkle tree for an L2 rollup state.
- Compare UTXO and account-based state models on storage size, parallelism, and replay properties, and explain why Solana's account model uses rent.
- Read evmone's source, explain its baseline interpreter versus advanced JIT, and write a custom EVM precompile.

### Validator and Execution Layer

You will be able to:

- Describe the Solana Sealevel parallel execution model and write a transaction that maximizes parallelism by declaring non-overlapping account writes.
- Explain Firedancer's tile architecture, the QUIC TPU, the gossip tile, the verify tile, and why each runs on a pinned core.
- Trace a Bitcoin block from peer-to-peer reception through header validation, parallel script verification, UTXO update, and chainstate flush.

### MEV and Trading

You will be able to:

- Build an MEV searcher that monitors the mempool, simulates transactions against a forked state, and submits a bundle to a builder.
- Implement a price-time priority matching engine in C++ with a lock-free order book, deterministic replay log, and warm-standby sequencer failover.
- Normalize WebSocket market data feeds from Coinbase, Binance, and Kraken into a single internal representation and reconstruct the depth book from incremental updates.

### Zero-Knowledge Systems

You will be able to:

- Compare Groth16, PlonK, and Halo2 on proving time, proof size, verification cost, and trusted setup requirements.
- Design a GPU prover pipeline for an MSM-heavy SNARK, identify the FFT and NTT bottlenecks, and choose between CUDA C++ and OpenCL backends.
- Read a Polygon zkEVM prover trace and identify the witness generation stage, the proof aggregation stage, and the on-chain verifier call.

### Security and Operations

You will be able to:

- Write postmortems at the level of Bitcoin BIP-66, the Ethereum DAO hack, and the September 2021 Solana outage, and identify the C++ pattern that would have prevented each.
- Audit a wallet codebase for BIP-32 derivation correctness, AEAD nonce reuse, and timing leaks in the unlock path.
- Apply io_uring or epoll-based async IO patterns to a state database (LevelDB, RocksDB, or MDBX) to remove block validation IO bottlenecks.

### Career Outcomes

After completing this chapter, you should be able to pass a senior engineer interview at any of: Chaincode Labs, Spiral, Brink, Anza, Jump Crypto Firedancer, Helius, Polygon Labs, Scroll, Matter Labs, RISC Zero, Succinct, Coinbase, Kraken, Binance, Bullish, FalconX, Wintermute, Jane Street crypto, or Citadel Securities crypto.

The compensation range for these roles in 2026 is L5-equivalent at \$400k to \$700k total, L6-equivalent at \$700k to \$1.2M, with significant variance based on token grants and trading P&L sharing.

---
