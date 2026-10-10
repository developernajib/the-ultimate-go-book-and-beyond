## EVM and Execution Clients

The Ethereum Virtual Machine is the most widely deployed bytecode interpreter in blockchain. It runs on every Ethereum mainnet node, every Layer 2 execution client (Optimism, Arbitrum, Base, zkSync, Scroll), every EVM-compatible chain (BNB Chain, Polygon PoS, Avalanche C-Chain, Fantom, Mantle), and inside zkEVM provers. A senior C++ engineer in this space needs to know how the EVM is specified, how `evmone` implements it efficiently, and how execution clients differ.

### The EVM in 200 Words

The EVM is a stack machine with:

- A 1024-deep stack of 256-bit words.
- A volatile, byte-addressed memory of 2^32 bytes (in practice limited by gas).
- A persistent storage of 256-bit slots, per contract.
- A read-only call data buffer.
- A return data buffer.
- A program counter into the bytecode.
- A gas counter that decreases per opcode.

There are roughly 145 opcodes, organized into stack manipulation (`PUSH1` through `PUSH32`, `DUP1` to `DUP16`, `SWAP1` to `SWAP16`, `POP`), arithmetic (`ADD`, `MUL`, `EXP`, `SDIV`, `MOD`), bitwise (`AND`, `OR`, `XOR`, `BYTE`, `SHL`, `SHR`), comparison (`LT`, `GT`, `EQ`), state access (`SLOAD`, `SSTORE`, `BALANCE`, `EXTCODECOPY`), control flow (`JUMP`, `JUMPI`, `JUMPDEST`, `RETURN`, `REVERT`, `STOP`), and external interaction (`CALL`, `STATICCALL`, `DELEGATECALL`, `CREATE`, `CREATE2`).

Every opcode has a gas cost. The cost reflects the work the validator must do. `ADD` is 3 gas. `SSTORE` is 20,000 gas (when writing a non-zero to a zero slot). A contract execution that runs out of gas reverts all state changes.

### evmone: The High-Performance C++ EVM

`evmone` is the high-performance EVM written in C++23 by the Ipsilon team (formerly the Ewasm team). It is the EVM behind Silkworm (Erigon's C++ rewrite) and is used as a differential testing oracle by every other client.

`evmone` ships two interpreters:

- **Baseline interpreter**: a switch-dispatched interpreter, optimized for short-lived calls.
- **Advanced interpreter**: a basic-block-based interpreter that pre-computes per-block gas costs and stack height changes.

#### Baseline Interpreter

The baseline interpreter is a textbook computed-goto loop. The C++ source uses a `switch` on the opcode, and the compiler turns it into a jump table.

```cpp
// Sketch of evmone-style baseline dispatch
evmc_status_code execute(const evmc_message& msg, const std::uint8_t* code, std::size_t code_size,
                         ExecutionState& state) {
    const std::uint8_t* pc = code;
    while (pc < code + code_size) {
        const auto op = *pc;
        switch (op) {
            case OP_PUSH1: {
                if (pc + 1 >= code + code_size) return EVMC_INVALID_INSTRUCTION;
                state.stack.push(uint256{pc[1]});
                pc += 2;
                break;
            }
            case OP_ADD: {
                if (state.stack.size() < 2) return EVMC_STACK_UNDERFLOW;
                auto b = state.stack.pop();
                auto& a = state.stack.top();
                a += b;
                pc += 1;
                state.gas_left -= 3;
                break;
            }
            case OP_SSTORE: {
                if (state.gas_left < 2300) return EVMC_OUT_OF_GAS;  // EIP-2200 sentry
                auto key = state.stack.pop();
                auto value = state.stack.pop();
                state.host->set_storage(state.recipient, key, value);
                pc += 1;
                break;
            }
            // ... 140+ more opcodes ...
        }
        if (state.gas_left < 0) return EVMC_OUT_OF_GAS;
    }
    return EVMC_SUCCESS;
}
```

#### Advanced Interpreter

The advanced interpreter pre-processes the bytecode into a sequence of internal instructions per basic block. For each block, it computes:

- Total gas cost (subtracted at block entry).
- Net stack height change.
- Required stack inputs.

This lets the per-instruction execution skip per-opcode bounds checks, gas accounting, and stack overflow checks. The cost is the analysis pass, which adds a one-time fixed cost per contract code execution.

```cpp
struct AdvancedBlock {
    std::int32_t gas_cost;
    std::int16_t stack_req;
    std::int16_t stack_max_growth;
};

struct Instruction {
    void (*fn)(ExecutionState&) noexcept;
    std::uint64_t arg;
};

// Pre-pass produces a Vec<Instruction> with embedded block-entry instructions
// that batch gas + stack checks for an entire basic block.
```

For long-running computations (heavy zk-SNARK contracts, large MerkleProof verifications), the advanced interpreter can outperform the baseline by 30 to 50 percent. For short-lived calls it loses due to analysis overhead.

#### evmone JIT and EOF

`evmone` does not currently ship a JIT, but it has prototypes for ahead-of-time compilation to native code via LLVM (the `evmjit` project, archived). The reason JIT is not in production is consensus risk: a JIT bug that mis-compiles one opcode forks the network. EOF (EVM Object Format, EIP-3540 onward) restructures the bytecode into typed sections, which makes static analysis safer and unlocks future JITability.

### evmc: The Pluggable Host Interface

`evmc` is the C ABI between the EVM and its host (the execution client). The host owns the state database, the world state, and external data. evmc lets you swap interpreters at runtime.

```c
// evmc.h excerpt
struct evmc_host_interface {
    bool (*account_exists)(struct evmc_host_context* ctx, const evmc_address* address);
    evmc_bytes32 (*get_storage)(struct evmc_host_context* ctx,
                                 const evmc_address* address,
                                 const evmc_bytes32* key);
    enum evmc_storage_status (*set_storage)(struct evmc_host_context* ctx,
                                             const evmc_address* address,
                                             const evmc_bytes32* key,
                                             const evmc_bytes32* value);
    evmc_uint256be (*get_balance)(...);
    size_t (*get_code_size)(...);
    evmc_bytes32 (*get_code_hash)(...);
    size_t (*copy_code)(...);
    bool (*selfdestruct)(...);
    struct evmc_result (*call)(...);
    struct evmc_tx_context (*get_tx_context)(...);
    evmc_bytes32 (*get_block_hash)(...);
    void (*emit_log)(...);
    enum evmc_access_status (*access_account)(...);  // EIP-2929
    enum evmc_access_status (*access_storage)(...);
};
```

Silkworm, Erigon, and Aleth all link against `evmone` through this interface. A C++ host implementation looks like:

```cpp
class SilkwormHost {
public:
    static evmc_bytes32 get_storage_thunk(evmc_host_context* ctx, ...) {
        return reinterpret_cast<SilkwormHost*>(ctx)->get_storage(...);
    }

    evmc_bytes32 get_storage(const evmc_address& addr, const evmc_bytes32& key) {
        return state_.get_storage(addr, key);
    }

private:
    ExecutionState state_;
};
```

### Execution Client Landscape

The Ethereum Foundation insisted on client diversity for security. As of 2025 the major execution clients are:

| Client | Language | Notes |
|---|---|---|
| Geth | Go | Reference client. ~50% of mainnet share. |
| Reth | Rust | Paradigm-funded. ~10% share, growing. |
| Erigon | Go (Caplin uses Rust) | Optimized for archive nodes. |
| Nethermind | C# / .NET | ~10% share, popular for staking. |
| Besu | Java | ConsenSys, popular for permissioned chains. |
| Silkworm | C++23 | Erigon-compatible C++ rewrite, uses evmone. |

Silkworm is the C++ client. It implements Erigon's "staged sync" architecture: bulk-download headers, then bodies, then execute bodies, then build the state trie, all as separate stages that can be parallelized and resumed.

```cpp
// Silkworm staged sync sketch
class StagedSync {
public:
    void run() {
        for (auto& stage : stages_) {
            if (auto err = stage->forward(); err) {
                handle_error(*err);
                return;
            }
        }
    }

private:
    std::vector<std::unique_ptr<IStage>> stages_;
    // Stages: HeadersDownload, BlockHashes, Bodies, Senders, Execution,
    //         HashState, IntermediateHashes, AccountHistoryIndex, ...
};
```

### Aleth: The Legacy C++ Client

Aleth was the original C++ Ethereum client, descended from cpp-ethereum (Gavin Wood's reference implementation). It is unmaintained as of 2020 but is still useful as a historical reference. Many of evmone's design ideas trace back to Aleth's `VMs` directory, which had an early baseline interpreter.

The lessons from Aleth's decline:

- **Don't reinvent the database layer**. Aleth's home-grown OverlayDB was slower and buggier than LevelDB, and the team spent years fighting it.
- **Don't fork your own LevelDB**. Aleth's LevelDB fork drifted from upstream and missed critical fixes.
- **JSON-RPC matters**. Aleth's RPC was slow and incompatible with web3.js, and dapp developers fled to Geth.

These are recurring lessons in blockchain engineering: the consensus engine is 30 percent of the work, and the supporting infrastructure (database, networking, RPC, telemetry) is the other 70 percent.

### Senior Track Notes

- **The Cancun fork (March 2024) added blob transactions** (EIP-4844). Blob data is committed to with KZG (Kate-Zaverucha-Goldberg) commitments, which are the same primitive used in PlonK. The C++ implementation lives in `c-kzg-4844`.
- **The Pectra fork (2025) adds EOF** and account abstraction primitives. EOF restructures the EVM to be safer for static analysis and JIT.
- **Differential fuzzing** between evmone and reth is run continuously by the Ethereum Foundation. The fuzzer generates random EVM bytecode and runs it on both clients, comparing state diffs. This has caught dozens of subtle bugs over the years.
- **Gas metering precision matters**. A client that under-charges gas allows DoS. A client that over-charges breaks contracts. Every gas change in the spec (EIP-150, EIP-2929, EIP-3529) has had at least one client implementation bug at activation.

The next section moves to Solana, which uses a fundamentally different execution model.

---
