## 120.1 Ethereum Architecture Fundamentals

### 1.1 Understanding Ethereum

Ethereum is a decentralized platform that runs smart contracts - applications that execute exactly as programmed. Unlike Bitcoin's UTXO model, Ethereum uses an account-based model with a global state machine.

**Key Components**:
- **Accounts**: Externally Owned Accounts (EOAs) controlled by private keys, and Contract Accounts containing code
- **Transactions**: State transitions signed by EOAs
- **Blocks**: Batches of transactions mined by validators
- **State**: Global mapping of addresses to account states
- **EVM**: The virtual machine that executes smart contract bytecode
- **Gas**: Computation unit that prevents infinite loops and spam

### 1.2 The Ethereum Virtual Machine (EVM)

The EVM is a quasi-Turing-complete stack-based virtual machine that executes smart contract bytecode deterministically across thousands of nodes.

```
┌────────────────────────────────────────────────────────┐
│                    Ethereum Network                    │
│  ┌──────────────────────────────────────────────────┐  │
│  │              Global State Tree                   │  │
│  │  • Account Balances                              │  │
│  │  • Contract Code                                 │  │
│  │  • Contract Storage                              │  │
│  └──────────────────────────────────────────────────┘  │
│                          ▲                             │
│                          │                             │
│  ┌──────────────────────────────────────────────────┐  │
│  │             EVM Execution Layer                  │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐    │  │
│  │  │  Opcode    │ │   Stack    │ │  Memory    │    │  │
│  │  │  Execution │ │   256-bit  │ │  Volatile  │    │  │
│  │  └────────────┘ └────────────┘ └────────────┘    │  │
│  │  ┌────────────┐ ┌────────────┐                   │  │
│  │  │  Storage   │ │    Gas     │                   │  │
│  │  │ Persistent │ │  Metering  │                   │  │
│  │  └────────────┘ └────────────┘                   │  │
│  └──────────────────────────────────────────────────┘  │
│                          ▲                             │
│                          │                             │
│  ┌──────────────────────────────────────────────────┐  │
│  │            Transaction Pool (Mempool)            │  │
│  │  Pending transactions waiting to be mined        │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

### 1.3 Gas and Transaction Costs

Every EVM operation consumes gas. Users specify:
- **Gas Limit**: Maximum gas willing to spend
- **Gas Price** (Legacy): Wei per gas unit
- **Max Fee Per Gas** (EIP-1559): Maximum total fee per gas
- **Max Priority Fee Per Gas** (EIP-1559): Tip to validators

Gas prevents infinite loops and ensures validators are compensated for computation.

**Example Gas Costs** (post-London fork):
```
Operation              Gas Cost
────────────────────────────────
Addition (ADD)         3
Multiplication (MUL)   5
Storage write (SSTORE) 20,000 (new) / 5,000 (update)
Transfer ETH           21,000
Deploy contract        32,000 + code size
```

### 1.4 Account Model

Ethereum uses accounts, not UTXOs:

```go
// Simplified account structure
type Account struct {
    Nonce    uint64    // Transaction counter (prevents replay attacks)
    Balance  *big.Int  // Account balance in Wei (1 ETH = 10^18 Wei)
    CodeHash []byte    // Hash of EVM code (empty for EOAs)
    StorageRoot []byte // Root of storage trie (contracts only)
}
```

**Two Account Types**:
1. **Externally Owned Accounts (EOA)**: Controlled by private keys, can initiate transactions
2. **Contract Accounts**: Controlled by code, activated by transactions or internal calls

---

### Junior → FAANG: Ethereum's Architecture as Your Mental Model for Debugging

Understanding Ethereum's layered architecture is the prerequisite for effective debugging. When a transaction is missing, the mental model tells you where to look: is it in the mempool (submitted but not yet included), in an uncle block (included but orphaned), in a recent block that was reorged away, or genuinely not broadcast? Without the architecture in your head, each of these scenarios looks the same from the application layer: the transaction is "missing."

The post-Merge split between execution layer and consensus layer is the most common source of confusion for engineers who learned Ethereum before September 2022. The execution client (Geth) handles the EVM, state, and transactions. The consensus client (Prysm, Lighthouse, etc.) handles validator duties, attestations, and the beacon chain. They communicate through the Engine API. When your node stops syncing, the first diagnostic step is determining which layer has the problem: check execution client logs separately from consensus client logs.

For interview preparation, be able to explain the full Ethereum state model: the world state is a Merkle Patricia Trie mapping account addresses to account objects (nonce, balance, code hash, storage root). The storage root of a contract account is itself the root of another Merkle Patricia Trie mapping 32-byte storage slots to 32-byte values. Being able to draw this nested Merkle structure and explain how a Merkle proof for a specific storage slot is constructed demonstrates architectural literacy at the level expected for senior engineering roles.

First-job habit: when something unexpected happens in an Ethereum integration (a transaction fails, an event is missing, a balance is wrong), use the Ethereum architecture as a systematic checklist: check the transaction receipt status, check the block number and hash for the transaction, check whether the block is still in the canonical chain by fetching it again and comparing the hash, and check the RPC node's sync status (`eth_syncing`). This systematic approach is far more efficient than guessing.

### Senior @ FAANG: Architecture Decisions that Respect Ethereum's Design Constraints

At staff level, Ethereum's architecture is a set of constraints that your system design must respect rather than fight against. The stateless client roadmap (EIP-4444, Portal Network, Verkle tries) will change which data is available from a typical node: in the future, nodes may not store historical state by default, and archive queries will require dedicated archive infrastructure or Portal Network access. Staff engineers who design systems today with awareness of this future can make choices that avoid tight coupling to archive data patterns.

The EVM's execution model has specific gas cost constraints that directly affect system design. A contract call that reads from many different storage slots costs more gas than one that reads from a few storage slots repeatedly. A system that calls a complex DeFi protocol function in a loop will encounter gas limit constraints. Staff engineers design around these constraints by batching operations, using Multicall3 for read batching, and understanding which operations are gas-expensive before committing to a design.

The Ethereum architecture's account model means that every account has a nonce, and every transaction from an account must be sequentially ordered by nonce. This sequential ordering constraint creates a bottleneck for high-throughput transaction submission from a single account. Solutions include: using multiple accounts with separate key management (each account has its own nonce sequence), using account abstraction (ERC-4337) to enable concurrent operation dispatch from a single smart contract account, or using a Layer 2 chain with higher throughput. The architecture constraint drives the design choice, and the ADR must explain this derivation.

The state growth problem in Ethereum (the state trie grows indefinitely as new accounts and storage slots are created) has real operational implications for teams running full nodes. State sync (the initial sync process that downloads the current state rather than replaying all blocks from genesis) can take hours to days depending on network conditions. Staff engineers design node bootstrapping procedures that account for this: using snap sync, running multiple nodes in rolling upgrade fashion to maintain availability, and monitoring sync status through the `eth_syncing` JSON-RPC method.

EIP-4844 (proto-danksharding, live since Dencun in March 2024) adds a new blob-carrying transaction type that is architecturally distinct from regular transactions and calldata. Blobs have their own fee market, their own gas accounting, and are pruned from nodes after approximately 18 days. This architectural change directly affects Layer 2 operators (who use blobs for data availability), rollup verifiers (who need to access blob data for fraud proofs), and any system that uses calldata for data availability (which should now evaluate switching to blobs for cost savings). Staff engineers audit their systems against EIP-4844 implications before and after each Ethereum upgrade.

Bar-raiser signals: explaining how Verkle trees (planned to replace Merkle Patricia Tries in a future Ethereum upgrade) change the proof size for state witnesses from kilobytes to hundreds of bytes, and why this matters for the stateless client vision, or designing a system that correctly handles Ethereum's two-phase confirmation model (first "safe" then "finalized" block tags) for a use case where partial finality guarantees are sufficient to unblock downstream processing. These architecture-level insights distinguish staff engineers in Ethereum development.

---
