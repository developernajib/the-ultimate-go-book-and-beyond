## The Move Language Runtime

Move is a smart contract language developed at Diem (Facebook's Libra), now used in production by Aptos, Sui, and several research chains. Its design pivot from the EVM is **resource-oriented programming**: values that represent assets are typed as resources, can only be moved (not copied), and can only be created or destroyed by their defining module. This eliminates an entire class of bugs (re-entrancy, accidental token duplication, incorrect transfer logic).

The Move VM was originally prototyped in C++ at Diem, then re-implemented in Rust as the production target. This section covers the bytecode model, the verifier, and the resource semantics, with code in both forms.

### Bytecode Model

The Move VM is a stack-based bytecode interpreter, similar in shape to JVM bytecode. Instructions:

- **Stack manipulation**: `Pop`, `LdU64(value)`, `LdConst(idx)`, `LdTrue`, `LdFalse`.
- **Local variables**: `MoveLoc(idx)`, `CopyLoc(idx)`, `StLoc(idx)`.
- **Reference operations**: `MutBorrowLoc(idx)`, `ImmBorrowLoc(idx)`, `ReadRef`, `WriteRef`, `FreezeRef`.
- **Arithmetic**: `Add`, `Sub`, `Mul`, `Div`, `Mod`, `BitOr`, `BitAnd`, `Xor`, `Shl`, `Shr`.
- **Control flow**: `Branch`, `BrTrue`, `BrFalse`, `Call`, `Ret`.
- **Resource operations**: `Pack(struct_idx)`, `Unpack(struct_idx)`, `MoveTo`, `MoveFrom`, `Exists`.
- **Generics**: `CallGeneric`, `PackGeneric`, etc.

Each bytecode is a single byte plus operands.

### Resource Semantics

A resource is a struct with the `key` (or `store`) ability that cannot be copied or dropped. The Move type system has four abilities:

- `copy`: the value can be duplicated.
- `drop`: the value can be discarded.
- `store`: the value can be stored inside another struct.
- `key`: the value can be a top-level resource at an address.

A typical token type:

```move
module 0x1::Coin {
    struct Coin<phantom T> has store { value: u64 }

    public fun zero<T>(): Coin<T> {
        Coin { value: 0 }
    }

    public fun value<T>(c: &Coin<T>): u64 {
        c.value
    }

    public fun split<T>(c: Coin<T>, amount: u64): (Coin<T>, Coin<T>) {
        assert!(c.value >= amount, 0);
        Coin { value: c.value - amount } 
        // ... new and remainder construction ...
    }

    public fun deposit<T>(account: &signer, c: Coin<T>) acquires Wallet {
        let w = borrow_global_mut<Wallet<T>>(signer::address_of(account));
        w.coin.value = w.coin.value + c.value;
        let Coin { value: _ } = c;
    }
}
```

A `Coin<T>` cannot be copied or dropped silently. The compiler refuses to emit bytecode that would. The runtime enforces the same invariant: a function that returns and does not consume a `Coin` is a verification error.

### The Bytecode Verifier

The verifier is the heart of Move's safety story. It runs once per module at publish time. It checks:

- **Type safety**: every operation has compatible operand types.
- **Resource safety**: a resource is never duplicated, never dropped without an explicit destruction, never escapes its defining module.
- **Reference safety**: no dangling references, no aliasing of mutable references, no mutable references that outlive the borrowed value.
- **Linking safety**: every called function exists and has a compatible signature.

The verifier is around 5000 lines of code. It is the most security-critical component of the runtime, because a verifier bug allows a module to violate type safety at runtime, which can be used to forge resources.

A C++ implementation of a simplified verifier:

```cpp
class MoveBytecodeVerifier {
public:
    Result<void> verify_module(const CompiledModule& m) {
        for (const auto& f : m.functions) {
            if (auto err = verify_function(m, f); err) return err;
        }
        return {};
    }

private:
    Result<void> verify_function(const CompiledModule& m, const CompiledFunction& f) {
        // Type stack simulation
        std::vector<TypeStackElement> stack;
        std::vector<TypeStackElement> locals = f.parameter_types;
        locals.resize(f.local_count);

        for (std::size_t pc = 0; pc < f.code.size(); ++pc) {
            const auto& op = f.code[pc];
            switch (op.kind) {
                case Opcode::LdU64:
                    stack.push_back(TypeStackElement::U64);
                    break;
                case Opcode::Add: {
                    if (stack.size() < 2) return Error{"stack underflow"};
                    auto b = stack.back(); stack.pop_back();
                    auto a = stack.back(); stack.pop_back();
                    if (a != b || !is_integer(a)) return Error{"type mismatch"};
                    stack.push_back(a);
                    break;
                }
                case Opcode::Pack: {
                    const auto& def = m.struct_defs[op.struct_idx];
                    if (stack.size() < def.fields.size()) return Error{"stack underflow"};
                    for (std::size_t i = def.fields.size(); i-- > 0;) {
                        if (stack[stack.size() - 1] != def.fields[i].type) {
                            return Error{"type mismatch in pack"};
                        }
                        stack.pop_back();
                    }
                    stack.push_back(TypeStackElement::Struct(op.struct_idx));
                    break;
                }
                // ... 100+ more opcodes ...
            }
        }

        // Verify all locals are consumed if they are resources without drop
        for (std::size_t i = 0; i < locals.size(); ++i) {
            if (is_resource_without_drop(locals[i])) {
                return Error{"unconsumed resource"};
            }
        }
        return {};
    }
};
```

The real verifier does dataflow analysis on the function CFG, not just linear scan. It tracks borrow regions, reference lifetimes, and resource ownership across all paths.

### Aptos vs. Sui

Aptos and Sui both use Move but with different runtime models:

- **Aptos**: account-centric. Resources live at user addresses, similar to Ethereum accounts. Parallel execution via Block-STM (optimistic concurrency control with rollback).
- **Sui**: object-centric. Every object has a globally unique ID. Transactions declare which objects they touch, similar to Solana's account access lists. Parallel execution is automatic and non-rollback for non-overlapping transactions.

Sui's object model is friendlier to high-throughput parallel execution. Aptos's account model is friendlier to legacy Ethereum patterns.

### Parallel Execution: Block-STM

Block-STM is Aptos's optimistic concurrency control scheme. The algorithm:

1. The block executor speculatively runs transactions in parallel, each with its own private read/write set.
2. After execution, the executor checks for conflicts: if Tx_i wrote to a key that Tx_j (with j > i) also read or wrote, Tx_j is aborted and re-executed.
3. The process iterates until all transactions have committed in order.

```cpp
struct TxExecution {
    Transaction tx;
    std::unordered_set<Address> reads;
    std::unordered_set<Address> writes;
    std::unordered_map<Address, Value> write_values;
    int version;  // bumped on re-execution
};

class BlockSTM {
public:
    std::vector<TxResult> execute(std::vector<Transaction> txs, const State& base) {
        std::vector<TxExecution> execs(txs.size());
        for (std::size_t i = 0; i < txs.size(); ++i) {
            execs[i].tx = std::move(txs[i]);
        }
        std::atomic<bool> changed{true};
        while (changed.exchange(false)) {
            // Parallel execute
            std::for_each(std::execution::par_unseq, execs.begin(), execs.end(),
                          [&](TxExecution& e) {
                              auto view = make_view(base, execs, &e - execs.data());
                              run_tx(e, view);
                          });
            // Sequential validate
            for (std::size_t i = 0; i < execs.size(); ++i) {
                for (std::size_t j = i + 1; j < execs.size(); ++j) {
                    for (auto& w : execs[i].writes) {
                        if (execs[j].reads.count(w) || execs[j].writes.count(w)) {
                            execs[j].version++;
                            changed.store(true);
                            break;
                        }
                    }
                }
            }
        }
        return collect_results(execs);
    }
};
```

The actual implementation uses a more sophisticated multi-version data structure to avoid re-executing more than necessary. The C++ relevance is that high-performance Block-STM implementations need careful memory management around the speculative state, and the Aptos team has explored C++-native MVCC stores for higher throughput.

### Senior Track Notes

- **Move was prototyped in C++ at Diem in 2018-2019**, then ported to Rust in 2020. The C++ codebase informed the Rust design but is no longer in production. Some embedded use cases (game engines, edge devices that cannot run a Rust runtime) maintain forks of the original C++ verifier.
- **Sui's parallel execution is owner-aware**. An "owned" object can be modified only by transactions signed by its owner, which removes most conflict scenarios. "Shared" objects (DEX pools, oracles) are the remaining contention point.
- **Move's formal verification story** uses the Move Prover, which translates Move source to Boogie / Z3 SMT-LIB queries. Critical contracts (the Aptos staking contract, the Sui validator set contract) are formally verified.
- **Bytecode upgrade compatibility** is a hard problem. Aptos and Sui use different upgrade policies. Aptos allows backwards-compatible additions only. Sui has stricter immutability for shared objects. C++ tooling that introspects Move bytecode must understand these policies to avoid generating incompatible upgrades.

The next section moves to bridges, which are where most catastrophic security failures in crypto have happened.

---
