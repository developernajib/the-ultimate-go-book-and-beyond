## 121.1 Smart Contract Fundamentals

### 1.1 What Are Smart Contracts?

Smart contracts are self-executing programs deployed on a blockchain. Unlike traditional applications where code runs on centralized servers, smart contracts execute in a decentralized manner across thousands of nodes. Once deployed, they're immutable - the code cannot be changed.

**Key Characteristics**:
- **Deterministic**: Same inputs always produce same outputs
- **Immutable**: Code cannot be modified after deployment
- **Transparent**: Anyone can view the code and execution
- **Autonomous**: Execute automatically when conditions are met
- **Decentralized**: No single point of control or failure

### 1.2 The EVM (Ethereum Virtual Machine)

Smart contracts run on the EVM - a quasi-Turing-complete virtual machine that executes bytecode. Understanding the EVM helps you write efficient Go integration code:

```
┌─────────────────────────────────────────┐
│          Smart Contract Code            │
│         (Solidity, Vyper, etc)          │
└────────────────┬────────────────────────┘
                 │ Compilation
                 ▼
┌─────────────────────────────────────────┐
│          EVM Bytecode                   │
│  (What actually runs on blockchain)     │
└────────────────┬────────────────────────┘
                 │ Deployment
                 ▼
┌─────────────────────────────────────────┐
│     Blockchain State Storage            │
│  • Contract Code (immutable)            │
│  • Contract State (mutable)             │
│  • Contract Balance                     │
└─────────────────────────────────────────┘
```

### 1.3 Solidity Basics for Go Developers

Solidity is the most popular smart contract language. Here's a quick primer for Go developers:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Similar to a Go struct with methods
contract SimpleToken {
    // State variables (stored on blockchain)
    string public name = "MyToken";
    mapping(address => uint256) public balances;

    // Events (like Go channels for notification)
    event Transfer(address indexed from, address indexed to, uint256 amount);

    // Constructor (runs once on deployment)
    constructor(uint256 initialSupply) {
        balances[msg.sender] = initialSupply;
    }

    // Public function (callable externally)
    function transfer(address to, uint256 amount) public returns (bool) {
        require(balances[msg.sender] >= amount, "insufficient balance");
        balances[msg.sender] -= amount;
        balances[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    // View function (doesn't modify state, no gas cost when called externally)
    function balanceOf(address account) public view returns (uint256) {
        return balances[account];
    }
}
```

**Solidity to Go Mental Model**:

| Solidity Concept | Go Equivalent | Key Difference |
|-----------------|---------------|----------------|
| `contract` | `struct` with methods | Contract state stored on blockchain |
| `mapping` | `map[K]V` | Persistent storage, not RAM |
| `address` | 20-byte array | Represents Ethereum account |
| `uint256` | `*big.Int` | 256-bit integer, no overflow since 0.8 |
| `require()` | `if err != nil { return err }` | Reverts transaction on failure |
| `event` | Pub/sub pattern | Emits logs on blockchain |
| `modifier` | Decorator pattern | Reusable access control |

### 1.4 Contract Lifecycle

Understanding the contract lifecycle is crucial for Go integration:

```
┌───────────────────────────────────────────────────────────────┐
│ 1. Development Phase                                          │
│    • Write Solidity code                                      │
│    • Compile to bytecode and ABI                              │
│    • Test on local network                                    │
└────────────────┬──────────────────────────────────────────────┘
                 │
                 ▼
┌───────────────────────────────────────────────────────────────┐
│ 2. Deployment Phase (From Go)                                 │
│    • Estimate gas                                             │
│    • Send deployment transaction with bytecode                │
│    • Wait for transaction confirmation                        │
│    • Obtain contract address                                  │
└────────────────┬──────────────────────────────────────────────┘
                 │
                 ▼
┌───────────────────────────────────────────────────────────────┐
│ 3. Interaction Phase (From Go)                                │
│    • Call view functions (read-only, free)                    │
│    • Send transactions (state-changing, costs gas)            │
│    • Listen for events                                        │
└────────────────┬──────────────────────────────────────────────┘
                 │
                 ▼
┌───────────────────────────────────────────────────────────────┐
│ 4. Maintenance Phase                                          │
│    • Monitor contract activity                                │
│    • Handle upgrades (if proxy pattern used)                  │
│    • Respond to events and errors                             │
└───────────────────────────────────────────────────────────────┘
```

### 1.5 State Variables and Functions

Smart contracts have two types of data storage:

**Storage (Persistent)**:
- Stored permanently on blockchain
- Expensive to write (costs gas)
- Survives between function calls
- State variables live here

**Memory (Temporary)**:
- Exists only during function execution
- Cheaper than storage
- Similar to Go's stack/heap memory
- Function parameters and local variables

```solidity
contract DataLocation {
    // Storage: permanent, expensive
    uint256 public storageValue;

    function example() public {
        // Memory: temporary, cheaper
        uint256 memoryValue = 100;

        // Writing to storage costs gas
        storageValue = memoryValue; // Expensive

        // Reading from storage is cheaper
        uint256 temp = storageValue; // Cheaper
    }
}
```

### 1.6 Modifiers and Access Control

Modifiers are reusable checks - similar to middleware in Go:

```solidity
contract Ownable {
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    // Modifier (like Go middleware)
    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _; // Execute function body
    }

    // Function using modifier
    function restrictedAction() public onlyOwner {
        // Only owner can call this
    }
}
```

### 1.7 Events and Logs

Events are the blockchain's way of emitting logs - crucial for off-chain applications:

```solidity
contract EventExample {
    // indexed parameters are searchable
    event Transfer(
        address indexed from,
        address indexed to,
        uint256 amount,
        bytes32 indexed txId
    );

    function transfer(address to, uint256 amount, bytes32 txId) public {
        // Transfer logic...
        emit Transfer(msg.sender, to, amount, txId);
    }
}
```

In Go, you'll subscribe to these events to react to contract state changes.

---

### Junior → FAANG: Smart Contract Fundamentals Every Backend Engineer Needs

Smart contract fundamentals for backend Go engineers focus on the interaction model rather than the Solidity development model. You need to understand what a contract does (deterministic state machine executing on the EVM) and how your Go code interacts with it (via ABI-encoded function calls and event log parsing), not necessarily how to write the contract yourself.

The EVM opcode gas costs are a prerequisite for understanding why certain contract interactions are expensive. SSTORE (writing to storage) costs 20,000 gas for a new slot and 5,000 gas for an update. SLOAD (reading from storage) costs 2,100 gas (cold) or 100 gas (warm, after the first access in a transaction). An ECDSA signature verification (`ecrecover`) costs 3,000 gas. Cross-contract calls have a base cost of 700 gas plus the gas consumed by the callee. Understanding these costs helps you estimate gas limits and identify unexpectedly expensive operations.

The concept of contract storage layout is critical for understanding and debugging contract interactions. Solidity maps state variables to storage slots in a defined way: simple types use sequential slots starting at slot 0, mappings use the keccak256 hash of the key and slot number, and dynamic arrays use the slot for the array length and keccak256 of the slot for the data. If you need to read raw contract storage (for state verification, forensics, or integration with contracts that do not have a view function for every piece of state), you must understand this layout.

Interview entry point: explain what happens when a smart contract function call from Go reverts. The transaction is included in the block (gas is consumed and the nonce is incremented) but the state changes are rolled back (no storage modifications persist). The transaction receipt has a status of 0 (failure). The reason for the revert can be decoded if the contract follows the standard pattern of reverting with a reason string or a custom error type. Understanding how to decode revert reasons in Go is a practical skill that comes up frequently in debugging.

### Senior @ FAANG: Smart Contract Fundamentals as Integration Risk Framework

At staff level, smart contract fundamentals provide the framework for assessing integration risk. Every integration with a smart contract has a risk profile that is determined by: the value at risk (how much ETH or token value can be affected by a bug), the reversibility of harm (can incorrect state be corrected through a subsequent transaction, or is the damage permanent), the attack surface (what inputs can be provided by untrusted parties, and what is the worst outcome of a malicious input), and the monitoring capability (how quickly can anomalous behavior be detected and responded to).

Reentrancy is the foundational smart contract vulnerability, and backend engineers integrating with contracts must understand it even though it is primarily a contract-level concern. A reentrancy attack occurs when a contract calls an external contract that calls back into the first contract before the first call completes, potentially exploiting inconsistent state. Backend engineers who understand reentrancy can identify integration patterns that are vulnerable to reentrancy-amplified attacks: for example, any integration that credits user balances before checking that a previous operation completed successfully.

The view and pure function modifiers in Solidity declare that a function does not modify state (view) or does not even read state (pure). Backend code should use `eth_call` for these functions rather than sending transactions, which wastes gas and adds latency. However, view functions can still revert (by calling require() or reverting explicitly), and this revert is surfaced as an error from `eth_call`. Staff engineers review integration code to ensure that view functions are always called via `eth_call` and that revert handling is implemented for each call.

Contract event emission is a design choice that affects the auditability and monitorability of the entire system. Well-designed contracts emit events for every significant state change, with enough indexed parameters to support efficient log filtering. Poorly designed contracts rely on the caller to maintain state or emit insufficient events. When integrating with a poorly-designed contract, the backend must compensate by using alternative data sources (state polling, transaction trace analysis) which are more expensive and less reliable than event listening. Staff engineers document these compensating controls in the integration ADR and advocate for improved contract design in future versions.

Bar-raiser signals: explaining how the `staticcall` opcode differs from `call` (staticcall prevents state modifications, which is what `eth_call` uses under the hood), or designing an integration testing harness that forks Ethereum mainnet (using Anvil or Hardhat's mainnet fork feature) and runs Go integration tests against real deployed contracts in a controlled environment. The mainnet fork testing approach is a practical technique that reveals production integration issues before deployment.

---
