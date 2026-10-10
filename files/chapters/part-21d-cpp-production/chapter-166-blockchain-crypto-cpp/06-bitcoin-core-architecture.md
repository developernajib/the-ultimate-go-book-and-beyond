## Bitcoin Core Architecture

Bitcoin Core is the reference implementation of the Bitcoin protocol. It has been continuously maintained since 2009 and is the canonical example of how to write consensus-critical C++ at production scale. This section gives a senior engineer's tour of the codebase as of release 28.x.

### Source Tree Layout

The Bitcoin Core repo is at `github.com/bitcoin/bitcoin`. The interesting C++ lives under `src/`:

```
src/
  consensus/        # consensus rules (validation.h, tx_check.cpp, params.cpp)
  primitives/       # block, transaction, transaction-output data structures
  script/           # Script interpreter (interpreter.cpp), Tapscript
  policy/           # standardness rules separate from consensus
  validation.cpp    # block-level validation orchestration (~5000 lines)
  txmempool.cpp     # mempool data structure
  wallet/           # built-in wallet (separate process since 24.0)
  net.cpp           # P2P framing
  net_processing.cpp # P2P message handling
  rpc/              # JSON-RPC interface
  kernel/           # the libbitcoinkernel API surface
  util/             # logging, threadsafety annotations, IO helpers
  test/             # unit tests
  test/fuzz/        # libFuzzer harnesses
```

The 2024-2025 trend is the **libbitcoinkernel extraction**. The goal is to factor out the consensus engine into a standalone shared library that can be linked from any application (Rust nodes, Go indexers, alternative wallets) without dragging in the wallet, the GUI, or even the P2P layer. The work tracks at `kernel/bitcoinkernel.h`. As of 28.x the kernel exports `Validate-Block`, `LoadChainstate`, `BlockManager`, and a callback-based notification API.

### Threading Model

Bitcoin Core uses a small fixed set of threads:

- **net thread**: epoll loop reading and writing TCP sockets.
- **msghand thread** (single): processes inbound messages serially. This thread holds `cs_main` for most of its life and is the source of most contention.
- **scheduler thread**: timed background tasks (mempool eviction, address relay, ping).
- **script verification thread pool**: per-CPU threads for parallel CHECKSIG and TAPROOT verifies during block validation.
- **wallet thread** (per-wallet): handles wallet-specific work. Removed from the daemon process since 24.0.
- **HTTP/RPC threads**: small pool serving JSON-RPC.

The contention rule of thumb is: any code reachable from `msghand` must avoid blocking. Disk IO is offloaded to async wrappers around the chainstate.

### The Mutex Discipline

Bitcoin Core uses Clang's thread safety analysis aggressively. Every mutex is annotated with `GUARDED_BY` and every function that requires the lock is annotated with `EXCLUSIVE_LOCKS_REQUIRED`. The compiler refuses to build code that violates these contracts.

```cpp
// Sketch matching Bitcoin Core's style
class CChainState {
public:
    bool ConnectBlock(const CBlock& block, BlockValidationState& state)
        EXCLUSIVE_LOCKS_REQUIRED(cs_main);

    int nHeight GUARDED_BY(cs_main) = 0;
    CBlockIndex* pindexBestHeader GUARDED_BY(cs_main) = nullptr;
};

extern RecursiveMutex cs_main;
```

The `RecursiveMutex` is a deliberate compromise. Bitcoin Core has many functions that take `cs_main` and call other functions that also take `cs_main`. Refactoring this into a non-recursive lock would be a multi-year effort. The cost is that recursive locks are about 2x slower than non-recursive ones, and a deadlock with a recursive lock is harder to diagnose because the same thread can be at multiple lock depths.

### The Validation Engine

Block validation is the heart of Bitcoin Core. The pipeline at high level:

1. **CheckBlock**: stateless checks (POW, merkle root, transaction format).
2. **AcceptBlock**: write to disk, link into the block tree.
3. **ConnectBlock**: stateful checks (signatures, double-spends, fee constraints), update UTXO set, compute new chain tip.
4. **FlushStateToDisk**: periodically persist chainstate.

Step 3 is where the parallel script verification thread pool earns its existence. For each input in each transaction, a verification job is queued. The pool drains the queue and reports failures back to the main thread. If any verification fails, the entire block is rejected.

```cpp
// Highly simplified
class CCheckQueue {
public:
    void Add(std::vector<CScriptCheck>&& checks);
    bool Wait();  // returns false if any check failed

private:
    std::deque<CScriptCheck> queue_;
    std::mutex mtx_;
    std::condition_variable cv_;
    std::atomic<bool> failed_{false};
};

bool ConnectBlock(const CBlock& block, ...) {
    CCheckQueue check_queue;
    for (const auto& tx : block.vtx) {
        std::vector<CScriptCheck> checks;
        for (size_t i = 0; i < tx.vin.size(); ++i) {
            checks.emplace_back(tx, i, /* flags */);
        }
        check_queue.Add(std::move(checks));
    }
    if (!check_queue.Wait()) return false;
    // Apply UTXO updates
    return true;
}
```

The 2023 work to add **assumeutxo** lets a node bootstrap from a snapshot of the UTXO set committed to in the source code. This skips initial block download for the snapshot range, reducing sync time from 24 hours to 1 to 2 hours on a fast disk.

### Chainstate Database

The UTXO set is stored in LevelDB. The key is `<txid, vout_index>` and the value is the encoded coin (amount, scriptPubKey, height, coinbase flag). At time of writing the UTXO set has roughly 130 million entries occupying 8 GB on disk and 2 GB in the in-memory cache.

The cache is a custom data structure called `CCoinsViewCache`, layered over the LevelDB-backed `CCoinsViewDB`. Reads check the cache first, falling through to LevelDB on miss. Writes accumulate in the cache until a flush. The flush is the long-pole operation in block validation, taking minutes during initial block download.

```cpp
class CCoinsView {
public:
    virtual bool GetCoin(const COutPoint& out, Coin& coin) const = 0;
    virtual bool HaveCoin(const COutPoint& out) const = 0;
    virtual uint256 GetBestBlock() const = 0;
    virtual bool BatchWrite(CCoinsMap& mapCoins, const uint256& hashBlock) = 0;
};

class CCoinsViewCache : public CCoinsView {
public:
    CCoinsMap cache_;
    std::shared_ptr<CCoinsView> base_;

    bool GetCoin(const COutPoint& out, Coin& coin) const override {
        if (auto it = cache_.find(out); it != cache_.end()) {
            coin = it->second.coin;
            return !coin.IsSpent();
        }
        return base_->GetCoin(out, coin);
    }
};
```

### Mempool

The mempool stores unconfirmed transactions. Bitcoin Core's mempool is a multi-index container (using `boost::multi_index_container`) keyed by:

- txid
- ancestor fee rate (used by miners)
- descendant fee rate (used by RBF / replace-by-fee logic)
- entry time (used by eviction)

The data structure decisions matter because the mempool is the most frequent target of denial-of-service attacks. A naive linear scan of 100,000 transactions on every new arrival kills the node.

### P2P Layer

Bitcoin's P2P protocol is a custom binary protocol over TCP, plus optional Tor and I2P. The framing is a 24-byte header with magic, command, length, and checksum, followed by a payload.

Bitcoin Core's P2P thread model:

- **net thread**: poll loop on all sockets.
- **msghand thread**: dispatches received messages to handlers.

A senior reviewer should note:

- Bitcoin Core uses **zero-copy receive** by reading directly into the message buffer. The buffer is sized at the protocol max (32 MiB).
- Outbound message serialization uses `CDataStream`, a custom serializer that supports both reading and writing through templated `<<` and `>>` operators. The compiler inlines the serialization tightly.

### RPC and the Kernel

The JSON-RPC interface is the primary external API. A senior consideration: many RPCs hold `cs_main` for the duration of the call. A long-running `gettxoutsetinfo` can stall block validation for minutes. The fix in 24.0+ was to separate read-only RPC paths to use the chainstate snapshot mechanism.

The libbitcoinkernel API exports a C interface. C++ callers wrap it in their own classes. The C interface guarantees ABI stability across minor versions, which the C++ classes do not.

### Senior Track Notes

- **Bitcoin Core uses Boost minimally and is in the process of removing it**. Boost.Multi_index, Boost.Signals2, and Boost.Filesystem have been replaced by C++17 standard library alternatives. As of 28.x, Boost is only required for the test suite.
- **Compile times are a real concern**. A clean build of Bitcoin Core takes 8 minutes on a 16-core box. The team has aggressively reduced template instantiations and uses precompiled headers.
- **Determinism testing**. The functional test suite includes a `--randomseed` flag that lets you replay tests with a fixed seed. CI runs every test with multiple seeds to flush out race conditions.
- **Fuzzing**. Every new feature must include a fuzz harness under `src/test/fuzz/`. The harnesses run continuously on OSS-Fuzz and find dozens of bugs per year, mostly in deserializers.

The next section drills into Bitcoin Script and Taproot, the part of the consensus engine that interacts with cryptography.

---
