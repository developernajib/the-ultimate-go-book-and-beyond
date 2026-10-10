## Solana Validator Internals

Solana is the most architecturally aggressive Layer 1 in production. Block times of 400 ms, transaction throughput of 50,000 per second in burst, and parallel execution by default. The trade-off is the most complex validator software in crypto. As of 2025 there are two production validator implementations: Anza's Agave (Rust, the descendant of the original Solana Labs validator) and Jump Crypto's Firedancer (C and C++, the high-performance rewrite). This section focuses on Firedancer because it is the C++ relevant work.

### The Tile Architecture

Firedancer is structured as a set of single-purpose **tiles**, each pinned to a CPU core, communicating through lock-free shared-memory channels. There is no general-purpose thread pool. Every core has a fixed role.

The major tiles:

- **net tile**: receives UDP packets via `XDP` (eXpress Data Path), parses headers, dispatches to downstream tiles.
- **quic tile**: terminates QUIC connections from clients submitting transactions.
- **verify tile**: parallel signature verification, one per CPU core in the verify pool.
- **dedup tile**: drops duplicate transactions seen recently.
- **pack tile**: assembles transactions into proposed blocks (when this validator is leader).
- **bank tile**: executes transactions against the Solana state.
- **shred tile**: encodes blocks into Reed-Solomon shreds for Turbine propagation.
- **gossip tile**: maintains the cluster membership view via the gossip protocol.
- **replay tile**: replays blocks received from other validators.

Every tile is a tight event loop. The C code uses `fd_tango`, a custom shared-memory IPC library that uses lock-free single-producer-single-consumer queues with cache-line padding.

```c
// fd_tango message queue, simplified
struct fd_mcache {
    ulong depth;
    ulong seq;  // producer sequence
    ulong _pad[6];
    fd_frag_meta_t frags[];  // depth entries
};

void fd_mcache_publish(fd_mcache_t* m, fd_frag_meta_t* f) {
    ulong slot = m->seq & (m->depth - 1);
    m->frags[slot] = *f;
    fd_compiler_mfence();
    m->seq++;
}

int fd_mcache_consume(fd_mcache_t* m, ulong* cons_seq, fd_frag_meta_t* out) {
    if (*cons_seq == m->seq) return 0;  // empty
    ulong slot = *cons_seq & (m->depth - 1);
    *out = m->frags[slot];
    fd_compiler_mfence();
    if (*cons_seq < m->seq) {
        (*cons_seq)++;
        return 1;
    }
    return -1;  // overrun
}
```

The cache-line-aligned producer sequence prevents false sharing between producer and consumer.

### QUIC TPU

Solana's transaction submission protocol is **QUIC over UDP**. Earlier versions of Solana used a UDP fire-and-forget protocol, but it was vulnerable to spam. QUIC adds connection-level rate limiting per source IP and per stake-weighted public key.

Firedancer's QUIC implementation is a from-scratch C library (`fd_quic`) optimized for the Solana use case:

- Stake-weighted connection limits.
- Zero-copy receive paths using `recvmmsg` and `sendmmsg`.
- TLS 1.3 handshake using BoringSSL.
- No HTTP/3 layer (QUIC streams carry raw transactions).

```cpp
// C++ wrapper around fd_quic
class QuicTpuListener {
public:
    void start(int udp_fd) {
        quic_ = fd_quic_new(/* config */);
        loop_thread_ = std::jthread([this](std::stop_token stop) { run_loop(stop); });
    }

private:
    void run_loop(std::stop_token stop) {
        while (!stop.stop_requested()) {
            fd_quic_service(quic_);
            // drain received transactions
            while (auto pkt = fd_quic_pop_rx(quic_)) {
                publish_to_verify_tile(pkt);
            }
        }
    }

    fd_quic_t* quic_;
    std::jthread loop_thread_;
};
```

### The Verify Pipeline

Every received transaction needs an Ed25519 signature verification. At 50,000 TPS with an average of 1.5 signatures per transaction, that is 75,000 verifies per second.

Firedancer uses two tricks:

1. **AVX-512 batched verification**. The custom `fd_ed25519` library processes 8 signatures in parallel per AVX-512 register pass. On a Sapphire Rapids core this is roughly 350,000 verifies per second per core.
2. **GPU verification offload**. For burst loads, the GPU verifier processes batches of 1024 signatures in roughly 1 ms.

```cpp
// Batched Ed25519 verify, AVX-512 path
extern "C" int fd_ed25519_verify_batch_avx(
    int n,
    const std::uint8_t* msgs[],
    const std::uint64_t msg_lens[],
    const std::uint8_t pubkeys[][32],
    const std::uint8_t sigs[][64]);

class VerifyTile {
public:
    void run() {
        constexpr std::size_t batch_size = 64;
        std::array<const std::uint8_t*, batch_size> msgs;
        std::array<std::uint64_t, batch_size> lens;
        std::array<std::array<std::uint8_t, 32>, batch_size> pks;
        std::array<std::array<std::uint8_t, 64>, batch_size> sigs;
        std::size_t n = drain_input(msgs, lens, pks, sigs, batch_size);
        if (n == 0) return;
        int rc = fd_ed25519_verify_batch_avx(n, msgs.data(), lens.data(),
                                              reinterpret_cast<const uint8_t(*)[32]>(pks.data()),
                                              reinterpret_cast<const uint8_t(*)[64]>(sigs.data()));
        if (rc != 0) {
            // fallback to per-sig verify to identify the bad one
        }
        publish_verified_batch(n);
    }
};
```

### Sealevel: Parallel Execution

Solana's defining feature is parallel transaction execution. Every transaction declares which accounts it reads and writes. The scheduler partitions transactions into batches such that within a batch no two transactions write to the same account.

```cpp
class SealevelScheduler {
public:
    struct Batch {
        std::vector<Transaction> txs;
    };

    [[nodiscard]] std::vector<Batch>
    schedule(std::vector<Transaction> txs) {
        std::vector<Batch> batches;
        std::vector<std::unordered_set<Pubkey>> writes;
        std::vector<std::unordered_set<Pubkey>> reads;
        for (auto& tx : txs) {
            std::size_t target = batches.size();
            for (std::size_t i = 0; i < batches.size(); ++i) {
                bool conflict = false;
                for (const auto& acc : tx.account_metas) {
                    if (acc.is_writable) {
                        if (writes[i].count(acc.pubkey) || reads[i].count(acc.pubkey)) {
                            conflict = true; break;
                        }
                    } else {
                        if (writes[i].count(acc.pubkey)) {
                            conflict = true; break;
                        }
                    }
                }
                if (!conflict) { target = i; break; }
            }
            if (target == batches.size()) {
                batches.emplace_back();
                writes.emplace_back();
                reads.emplace_back();
            }
            for (const auto& acc : tx.account_metas) {
                if (acc.is_writable) writes[target].insert(acc.pubkey);
                else reads[target].insert(acc.pubkey);
            }
            batches[target].txs.push_back(std::move(tx));
        }
        return batches;
    }
};
```

The actual Firedancer scheduler is more sophisticated, using priority fees to break ties and sliding windows to avoid head-of-line blocking. The point is the same: parallelism is **declared**, not detected.

### Turbine Block Propagation

When a leader produces a block, it cannot afford to send the full block to all other validators (1500+ nodes worldwide). Instead, the block is **shredded** into MTU-sized fragments, encoded with Reed-Solomon erasure coding, and propagated through a stake-weighted tree.

The leader sends shreds to a small set of "first-layer" nodes. Each first-layer node forwards shreds to a set of "second-layer" nodes, and so on. The structure forms a fanout-N tree where N is roughly 200 in production. Each shred is signed by the leader so receivers can verify provenance.

```cpp
struct Shred {
    Slot slot;
    std::uint32_t index;
    std::uint8_t shred_type;  // data or coding
    std::array<std::uint8_t, 64> signature;
    std::vector<std::uint8_t> payload;  // ~1228 bytes
};

class TurbineForwarder {
public:
    void on_shred_received(Shred shred, const ContactInfo& sender) {
        // verify leader signature
        if (!verify_leader(shred)) return;
        // determine our position in the tree
        auto children = compute_children(shred.slot, current_layer_);
        for (const auto& child : children) {
            send_udp(child.tvu_addr, shred);
        }
        // pass to local validator for replay
        replay_input_.publish(shred);
    }
};
```

If a validator misses a shred, Reed-Solomon coding lets it reconstruct the missing piece from the others (typically 32 data shreds plus 32 coding shreds per "FEC set"). If even reconstruction fails, the validator requests a repair from peers via the gossip layer.

### Gossip and Cluster Membership

The gossip protocol is a CRDT-based key-value store distributed across the cluster. Each validator publishes signed `ContactInfo`, vote credits, snapshot hashes, and other metadata. Gossip uses pull-and-push every 100 ms with logarithmic-fanout sampling.

The C++ implementation in Firedancer is `fd_gossip`. The CRDT semantics make convergence automatic, but the per-message cryptography (ed25519 verify per gossip packet) is a hot path that needs the same batched verification as the TPU.

### Replay Stage

When a validator receives all shreds for a block from another validator, it replays the block to verify the leader's claimed state root. The replay stage is the symmetric counterpart to the leader's bank stage:

1. Reassemble shreds into transactions.
2. Run the same Sealevel scheduler.
3. Execute transactions against the local state.
4. Compute the bank hash.
5. Compare against the leader's claimed bank hash.

If the hashes match, the validator votes for this block. If not, the validator's own state is wrong (or the leader is malicious), and the validator drops out of consensus until it can repair.

### Senior Track Notes

- **Firedancer is incrementally replacing Agave**. The strategy is "Frankendancer": a hybrid where the validator runs Agave for some tiles and Firedancer for others. Each release moves more tiles to Firedancer. As of 2025, the network, QUIC, verify, and shred tiles are Firedancer, the bank and replay tiles are still Agave.
- **The bank stage is the hardest tile to rewrite** because it must execute SBF (Solana BPF) bytecode bit-identically to Agave. Firedancer's SBF interpreter is being written in C with comprehensive differential fuzzing against Agave.
- **Solana's parallel execution model breaks down under contention**. A popular DeFi pool that every transaction wants to write to becomes a single sequential stream. Solana's "compute units per account per block" limit forces fairness but also caps throughput on hot accounts.
- **The gossip protocol is the most complex production CRDT in crypto**. The September 2021 outage was caused by a gossip storm where validators amplified each other's messages exponentially. The fix was rate limits per peer and per message type.

The next section shifts to MEV, the off-chain layer that influences which transactions actually get into blocks.

---
