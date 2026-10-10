## 119.1 Blockchain Architecture

### 1.1 What Is a Blockchain?

A blockchain is a distributed, immutable ledger - a chain of blocks where each block contains data (typically transactions) and is cryptographically linked to the previous block. This creates an append-only data structure where altering any historical data becomes computationally infeasible.

**Core Components**:
- **Block**: Container for data with metadata (timestamp, nonce, hash)
- **Chain**: Linked sequence of blocks validated by the network
- **Consensus**: Agreement mechanism ensuring all nodes see the same state
- **Network**: Peer-to-peer nodes maintaining copies of the blockchain

```
┌──────────────────────────────────────────────────────────┐
│                    Blockchain Structure                  │
└──────────────────────────────────────────────────────────┘

Block 0 (Genesis)          Block 1                 Block 2
┌──────────────┐         ┌──────────────┐        ┌──────────────┐
│ PrevHash: 0  │    ┌───►│ PrevHash: A  │   ┌───►│ PrevHash: B  │
│ Timestamp    │    │    │ Timestamp    │   │    │ Timestamp    │
│ Nonce: 12534 │    │    │ Nonce: 98123 │   │    │ Nonce: 45982 │
│ Transactions │    │    │ Transactions │   │    │ Transactions │
│ Hash: A      │────┘    │ Hash: B      │───┘    │ Hash: C      │
└──────────────┘         └──────────────┘        └──────────────┘
```

### 1.2 Why Blockchain Matters

**Immutability**: Once data is in a block and the block is mined, changing it requires re-mining that block and all subsequent blocks - practically impossible for established chains.

**Decentralization**: No single entity controls the network. Consensus among distributed nodes ensures integrity.

**Transparency**: All participants can verify the entire chain history.

**Use Cases Go Developers Build**:
- Cryptocurrency systems (Bitcoin, Ethereum nodes)
- Supply chain tracking (Hyperledger Fabric)
- Decentralized identity (DID systems)
- NFT platforms (Go backends for minting/trading)
- DeFi protocols (Go services interacting with smart contracts)

### 1.3 Merkle Trees

Merkle trees enable efficient verification of data integrity. Instead of hashing all transactions together, we build a binary tree where leaf nodes are transaction hashes and parent nodes hash their children.

```
                    Root Hash (Merkle Root)
                           │
            ┌──────────────┴──────────────┐
            │                             │
        Hash(AB)                      Hash(CD)
            │                             │
      ┌─────┴─────┐               ┌─────┴─────┐
      │           │               │           │
   Hash(A)     Hash(B)        Hash(C)     Hash(D)
      │           │               │           │
   Tx A        Tx B            Tx C        Tx D
```

**Benefits**:
- **Space Efficiency**: Store only the root hash in block headers
- **Fast Verification**: Prove a transaction exists with O(log n) hashes
- **Tamper Detection**: Any change cascades up to root hash

---

### Junior → FAANG: Understanding Blockchain Architecture as a Distributed Systems Problem

Blockchain architecture is a specialized instance of distributed systems design, and junior engineers who have studied CAP theorem, eventual consistency, and leader election will find the concepts map directly. The key translation is that in a public blockchain, the "leader" (the block producer) is selected probabilistically or through economic stake, not through a central coordinator, and the consistency model is eventual with a well-defined finality horizon.

A prerequisite gap that trips up many juniors is confusing the network layer (p2p gossip of transactions and blocks) with the consensus layer (the protocol by which nodes agree on canonical chain state). These are separable concerns in most implementations. Geth uses devp2p for block gossip but runs the Engine API for consensus handoff in a post-Merge configuration. Understanding this split is essential before you can reason about where a network partition causes failures.

For interview preparation, practice drawing the full lifecycle of a transaction: user constructs and signs the transaction in a wallet, broadcasts it via JSON-RPC to a node, the node validates and adds it to the mempool, a block producer selects it and includes it in a block, the block propagates to peers via gossip, and other nodes validate and add it to their local chain. Being able to narrate and whiteboard this end-to-end demonstrates architectural literacy.

First-job habits: read the architecture documentation for whichever client your team runs (Geth, Besu, Nethermind, Erigon), not just the API reference. Understanding how the client separates the execution layer from the consensus layer, and how these layers communicate, will make you dramatically more effective when debugging production issues.

### Senior @ FAANG: Architectural Ownership of Blockchain System Design

At staff level, blockchain architecture is a set of binding constraints that every dependent system must respect. The most consequential architectural property is the finality model: does the chain offer deterministic finality (BFT-based chains like Cosmos zones or Ethereum post-Merge with sufficient attestations) or probabilistic finality (still relevant for some UTXO chains and during short forks on Ethereum before sufficient attestations accumulate)? Every business logic system that credits assets or triggers off-chain actions based on on-chain events must bake this model into its state machine, not treat it as an implementation detail.

ADRs for blockchain-dependent systems must explicitly address reorg handling. A reorg of depth one on Ethereum mainnet happens multiple times per day. A reorg of depth three is rare but not unheard of. Any system that processes transactions without a configurable confirmation-depth threshold has an implicit and probably unsafe assumption. Staff engineers write the decision record that specifies this threshold, explains the business risk trade-off (latency versus safety), and documents the rollback procedure when a reorg invalidates a previously confirmed action.

The account model versus UTXO model choice has pervasive architectural implications. Account model chains (Ethereum) support stateful smart contracts natively but require careful nonce management for high-throughput transaction submission. UTXO model chains (Bitcoin) support parallel validation and simpler state proofs but require UTXO set management and coin selection logic in any backend that constructs transactions. A platform that spans both models needs a clear abstraction boundary that does not leak these differences into application code.

State trie architecture on EVM chains is a recurring performance concern at scale. The Merkle Patricia Trie used by Ethereum has well-known access pattern inefficiencies: random reads hit multiple trie nodes, and state growth is unbounded without pruning. Staff engineers evaluate client implementations (Erigon's flat database layout versus Geth's in-memory trie cache) against their specific workload profile and document the trade-off in a capacity planning ADR.

Sharding and layer-2 architecture are now first-class concerns in Ethereum platform design. Danksharding (EIP-4844 and beyond) changes blob availability guarantees in ways that affect data availability assumptions for rollup-based systems. Principal engineers track these protocol changes before they reach mainnet and prepare their dependent systems in advance, not after the upgrade surprises them.

Bar-raiser signals in architecture interviews: explaining why EIP-4844 blobs have a separate fee market from calldata, describing how an optimistic rollup's fraud proof window creates a 7-day withdrawal delay and what the business implications are, or designing a multi-chain asset bridging system that correctly handles the case where the source chain reorgs after the bridge contract emits a lock event. These questions test architectural thinking, not just terminology recall.

L7 platform thinking extends to the interface between blockchain architecture and the rest of the enterprise stack. How does a blockchain event propagate through Kafka into downstream data warehouses? What is the exactly-once delivery guarantee, and where does it break? Designing this pipeline with correct semantics requires understanding both blockchain finality and streaming system delivery guarantees simultaneously.

---
