## MEV and Flashbots

MEV stands for Maximal Extractable Value. It is the profit a block producer (validator, sequencer, or builder) can extract by ordering, including, or excluding transactions in a block. MEV is a multi-billion-dollar industry on Ethereum and Solana, and the systems that capture it are some of the most performance-sensitive C++ codebases in production.

### What MEV Looks Like

The canonical MEV opportunities:

- **Arbitrage**. A price differs between two DEXes. A searcher submits a transaction that buys low on one and sells high on the other in the same block.
- **Liquidation**. A lending protocol position is undercollateralized. The first liquidator earns a 5 to 10 percent bonus.
- **Sandwich attack**. A user submits a large swap. A searcher front-runs with a buy, lets the user trade at a worse price, then back-runs with a sell. This is the dominant predatory MEV strategy.
- **NFT mint sniping**. A new mint opens at block N. Searchers submit transactions to maximize their share of the supply.
- **Just-in-time (JIT) liquidity**. A searcher provides concentrated liquidity for one block to capture fees from a known large swap.

In 2024, total MEV on Ethereum mainnet was estimated at \$700M. On Solana it was lower in dollar terms but higher in volume because of the lower fees.

### Proposer-Builder Separation (PBS)

Before PBS, validators built their own blocks and captured all MEV themselves. This concentrated MEV in large staking pools and gave smaller validators no way to compete. PBS, formalized by Flashbots in 2021 and now standard on Ethereum mainnet, separates the roles:

- **Searchers** find MEV opportunities and bundle transactions.
- **Builders** assemble searcher bundles plus public mempool transactions into a block.
- **Relays** receive blocks from builders and forward the most profitable to validators (proposers).
- **Proposers** sign whichever block pays them the most.

The protocol between these actors is `MEV-Boost` for relays and `relayooor`-compatible builders. A proposer running MEV-Boost asks the relay for the highest-bid block, signs the block header, and the relay publishes the full block.

### Builder Architecture

A modern Ethereum block builder is one of the most demanding low-latency C++ systems outside of HFT. The builder:

1. Maintains a forked simulation of the latest state (typically using `revm` or `evmone` with a fork backend).
2. Receives bundles from searchers via WebSocket or HTTP.
3. Receives public mempool transactions from connected nodes.
4. Continuously simulates candidate blocks, optimizing for proposer payment.
5. Submits the highest-paying block to relays roughly 200 ms before the slot deadline.

```cpp
class BlockBuilder {
public:
    void on_bundle(const SearcherBundle& bundle) {
        std::scoped_lock lock(bundle_mtx_);
        bundles_.insert({bundle.id, bundle});
        rebuild_pending_.store(true, std::memory_order_release);
    }

    void on_mempool_tx(const Transaction& tx) {
        mempool_.add(tx);
        rebuild_pending_.store(true, std::memory_order_release);
    }

    void build_loop() {
        while (running_.load(std::memory_order_acquire)) {
            if (!rebuild_pending_.exchange(false, std::memory_order_acq_rel)) {
                std::this_thread::yield();
                continue;
            }
            auto candidate = build_candidate();
            if (candidate.proposer_payment > best_block_.proposer_payment) {
                best_block_ = std::move(candidate);
                submit_to_relays(best_block_);
            }
        }
    }

private:
    Block build_candidate() {
        Block b{base_state_};
        // Add bundles in order of effective gas price + tip
        std::vector<SearcherBundle> sorted_bundles(bundles_.begin(), bundles_.end());
        std::ranges::sort(sorted_bundles, std::greater{}, &SearcherBundle::priority_score);
        for (const auto& bundle : sorted_bundles) {
            auto sim = simulate_bundle(b.state, bundle);
            if (sim.success && b.gas_used + sim.gas_used <= block_gas_limit) {
                b.apply(sim);
            }
        }
        // Fill remaining gas with mempool txs
        for (const auto& tx : mempool_.sorted_by_gas_price()) {
            if (b.gas_used + tx.gas_limit > block_gas_limit) break;
            auto sim = simulate_tx(b.state, tx);
            if (sim.success) b.apply(sim);
        }
        return b;
    }

    std::atomic<bool> rebuild_pending_{false};
    std::atomic<bool> running_{true};
    std::mutex bundle_mtx_;
    std::unordered_map<BundleId, SearcherBundle> bundles_;
    Mempool mempool_;
    State base_state_;
    Block best_block_;
};
```

The hot path is `simulate_bundle`. Each simulation runs the EVM (via evmone) against a forked state, measures gas used and value transferred to the proposer, and either commits or discards the result. A high-performance builder simulates millions of bundle permutations per slot.

### Searcher Architecture

A searcher is more focused. The typical searcher monitors a specific opportunity (one DEX pair, one lending protocol, one mint) and submits bundles when conditions match.

```cpp
class ArbitrageSearcher {
public:
    void on_block(const Block& b) {
        // Update local state replicas
        for (const auto& tx : b.txs) state_.apply(tx);
        // Check all monitored pairs for new arbitrage opportunities
        for (auto& pair : pairs_) {
            auto opp = check_pair(pair);
            if (opp && opp->profit > min_profit_) {
                submit_bundle(*opp);
            }
        }
    }

    void on_pending_tx(const Transaction& tx) {
        // Simulate this pending tx to see if it creates an arb opportunity
        State forked = state_.fork();
        auto sim = evmone_->execute(forked, tx);
        if (!sim.success) return;
        for (auto& pair : affected_pairs(sim.touched_storage)) {
            auto opp = check_pair_after(pair, forked);
            if (opp && opp->profit > min_profit_) {
                submit_back_run(tx, *opp);
            }
        }
    }

private:
    State state_;
    std::vector<MonitoredPair> pairs_;
    std::unique_ptr<EvmOneEngine> evmone_;
    CAmount min_profit_;
};
```

The latency budget for a searcher is brutal. From the moment a target transaction enters the public mempool to the moment the searcher's bundle reaches the builder, you have roughly 50 to 200 ms before another searcher beats you. This is why every searcher worth running is colocated with major mempool feeds (Geth nodes in AWS us-east-1) and uses kernel-bypass networking on the inbound side.

### Mempool Monitoring

The public Ethereum mempool is exposed via the `txpool` JSON-RPC namespace and via direct P2P (subscribing to a Geth or Erigon node). Latency-sensitive searchers run their own modified Geth/Reth nodes that emit pending transactions over a Unix domain socket.

A high-performance C++ mempool listener:

```cpp
class MempoolListener {
public:
    void connect(const std::string& sock_path) {
        fd_ = ::socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0);
        sockaddr_un addr{};
        addr.sun_family = AF_UNIX;
        std::strncpy(addr.sun_path, sock_path.c_str(), sizeof(addr.sun_path) - 1);
        ::connect(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
    }

    void poll_loop(std::stop_token stop) {
        std::array<std::uint8_t, 65536> buf;
        while (!stop.stop_requested()) {
            ssize_t n = ::recv(fd_, buf.data(), buf.size(), 0);
            if (n > 0) {
                parse_and_dispatch({buf.data(), static_cast<std::size_t>(n)});
            } else if (n == 0) {
                break;
            } else if (errno != EAGAIN) {
                break;
            }
        }
    }

    void parse_and_dispatch(std::span<const std::uint8_t> data) {
        // Streaming RLP parser, no allocations on hot path
        Transaction tx = rlp_decode_tx(data);
        for (auto& sub : subscribers_) sub->on_tx(tx);
    }

private:
    int fd_{-1};
    std::vector<std::shared_ptr<ITxSubscriber>> subscribers_;
};
```

The RLP decoder is hand-written, allocates nothing on the hot path, and uses `std::span` views into the receive buffer. A typical searcher processes 5,000 mempool transactions per second.

### Simulation Engines

The simulation engine is the searcher's most important asset. The two open-source choices are:

- **revm** (Rust): used by `mev-boost-builder`, `mev-bot`, and many production searchers. Fastest pure-EVM simulator.
- **evmone** (C++): integrated via `evmc`. Most natural for C++ codebases.

For maximum throughput, searchers maintain a **forked state** in memory and apply transactions speculatively. The forked state must support cheap rollback. The classic implementation is a **journal**: every state mutation pushes an undo entry, and rollback pops the journal back to a checkpoint.

```cpp
class JournaledState {
public:
    Snapshot take_snapshot() { return {journal_.size()}; }

    void rollback(Snapshot s) {
        while (journal_.size() > s.depth) {
            journal_.back().undo(*this);
            journal_.pop_back();
        }
    }

    void set_storage(Address a, uint256 k, uint256 v) {
        auto& entry = storage_[{a, k}];
        journal_.push_back(JournalEntry::SetStorage(a, k, entry));
        entry = v;
    }

    // ... other state operations ...

private:
    std::unordered_map<std::pair<Address, uint256>, uint256, PairHasher> storage_;
    std::vector<JournalEntry> journal_;
};
```

This pattern is also used inside `evmone` to handle EVM `REVERT`, which must undo all state changes within a sub-call.

### Senior Track Notes

- **Latency is the only thing that matters at the searcher level**. A 5 ms improvement is worth millions of dollars per year. Every C++ trick (kernel-bypass NICs, huge pages, CPU pinning, real-time priority, NUMA-aware allocators) is in scope.
- **The PBS protocol creates trust assumptions on relays**. A malicious relay can steal MEV by signing a builder's block, replacing transactions, and submitting the modified block to the proposer. Several incidents in 2023 caused the "trusted relay" model to be questioned. Proposed fixes include cryptographic guarantees (Optimistic Relay) and TEE-based relays (SUAVE).
- **Solana MEV is different**. The lack of a public mempool means MEV is more centralized at the validator level. Jito Labs runs the dominant MEV infrastructure, with a custom sequencer and bundle auction. Firedancer plans to integrate Jito-style auctions natively.
- **Cross-domain MEV** (extracting value across multiple chains in the same atomic action) is the active research frontier. SUAVE is one approach. Cross-chain intent solvers (CowSwap, UniswapX) are another.

The next section moves from MEV to centralized exchanges, where C++ engineering directly underpins billions in daily volume.

---
