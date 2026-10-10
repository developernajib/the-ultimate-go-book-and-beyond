## Prefill vs Decode Disaggregation

Prefill and decode are different workloads. Mixing them on the same GPU forces a compromise on both. Disaggregating them into separate GPU pools, with KV cache transferred between, is the architectural shift that production engines made in 2024-2026. DistServe (paper, 2024), Mooncake (Kimi, 2024), and DeepSeek's inference cluster (2025) all run disaggregated. TensorRT-LLM and vLLM both expose disaggregated mode in 2026.

This section covers the math, the architecture, and the C++ KV cache transfer protocol.

### The Asymmetry

Prefill processes the input prompt. Compute per token: `O(layers * hidden^2)` (the dense GEMMs) plus `O(layers * seq * hidden)` (attention against all prior tokens). With seq=2048 and a 70B model, prefill is tens of TFLOPS per token of input.

Decode processes one new token at a time. Compute per token: same dense GEMMs as prefill, plus `O(layers * context * hidden)` for attention against the KV cache. The dense GEMMs are now GEMVs (M=batch, not M=batch*seq). Memory I/O dominates because each weight is read once per token.

| Phase | Bottleneck | Optimal batch | Hardware that wins |
|-------|-----------|---------------|---------------------|
| Prefill | Compute (TFLOPS) | 1-4 requests, lots of tokens each | H100 / B200 (FLOPS) |
| Decode | Memory bandwidth (TB/s) | 64-256 requests, 1 token each | H200 / MI300X (more HBM) |

Mixing both on one GPU:

- Adding decode to a prefill batch wastes compute (the decode tokens contribute almost nothing to the FLOPS).
- Adding prefill to a decode batch wastes memory bandwidth (the long sequence of K/V reads slows the decode requests too).

### DistServe / Mooncake Architecture

```
Request -> Router -> Prefill pool (P GPUs)
                       |
                       | KV cache transfer (NVLink / NIC RDMA)
                       v
                     Decode pool (D GPUs) -> Token stream to client
```

Prefill pool: a few GPUs, each running prefill for one or two requests at a time. Optimized for compute throughput.

Decode pool: many GPUs, each running large-batch decode for many requests in parallel. Optimized for memory bandwidth and KV cache capacity.

KV transfer: when a request finishes prefill, its KV cache (per-layer, per-token) is shipped to the decode pool. The decode pool resumes from that state for the autoregressive part.

Mooncake adds a third pool: a *KV pool* (cheap CPU memory or NVMe across many machines) for caching prefixes. When a request comes in with a prompt that has been seen before, the prefix is loaded from the KV pool instead of recomputed in the prefill pool.

### KV Cache Transfer Math

For a 70B model with hidden=8192, num_layers=80, num_kv_heads=8, head_dim=128, FP16:

Per-token KV size = 80 layers * 8 heads * 128 dim * 2 (K+V) * 2 bytes = 327 KB

For a 4096-token prompt: 4096 * 327 KB = 1.34 GB.

Transfer over NVLink (900 GB/s): 1.5 ms.
Transfer over IB NDR (50 GB/s): 27 ms.
Transfer over PCIe (64 GB/s): 21 ms.

For the math to work, the transfer time must be small relative to the saved decode latency. Within a node (NVLink), it is. Across nodes (IB), it is for short-to-medium prompts but breaks for very long prompts. This is why Mooncake also caches KV blocks: if a prefix is in the cache, you skip the prefill entirely *and* skip the transfer.

### C++ KV Transfer Protocol

The transfer happens between two processes (or two GPUs of the same process) that hold KV pools. NCCL works for intra-node and intra-cluster transfers. For cross-rack transfers, RDMA Verbs over IB or RoCE.

Sketch using NCCL:

```cpp
// On the prefill rank, after prefill finishes for request rid
struct KVHandoff {
    uint64_t request_id;
    int num_layers;
    int num_kv_heads;
    int head_dim;
    int num_tokens;
    int target_decode_rank;
};

void send_kv_to_decode(const Request& req, ncclComm_t inter_comm,
                       cudaStream_t stream) {
    KVHandoff h{req.id, num_layers_, num_kv_heads_, head_dim_,
                static_cast<int>(req.input_token_ids.size()),
                pick_decode_rank(req)};

    // Send the metadata first (small, blocking)
    send_metadata(h, inter_comm);

    // Then the actual K and V buffers, layer by layer
    size_t per_layer = num_kv_heads_ * head_dim_ * h.num_tokens * sizeof(half);
    for (int layer = 0; layer < num_layers_; ++layer) {
        ncclSend(req.k_cache_ptr(layer), per_layer / sizeof(half),
                 ncclHalf, h.target_decode_rank, inter_comm, stream);
        ncclSend(req.v_cache_ptr(layer), per_layer / sizeof(half),
                 ncclHalf, h.target_decode_rank, inter_comm, stream);
    }
    cudaStreamSynchronize(stream);
}
```

On the decode side:

```cpp
void recv_kv_from_prefill(ncclComm_t inter_comm, cudaStream_t stream) {
    KVHandoff h = recv_metadata(inter_comm);

    // Allocate blocks in the decode pool's BlockManager
    Request req;
    req.id = h.request_id;
    int needed_blocks = (h.num_tokens + block_size_ - 1) / block_size_;
    bm_->allocate(req, h.num_tokens);

    size_t per_layer = num_kv_heads_ * head_dim_ * h.num_tokens * sizeof(half);
    for (int layer = 0; layer < num_layers_; ++layer) {
        // Recv into a staging buffer, then copy into block-paged layout
        ncclRecv(staging_, per_layer / sizeof(half),
                 ncclHalf, /*src=*/prefill_rank_, inter_comm, stream);
        scatter_into_blocks(staging_, req.block_table, layer, true);  // K
        ncclRecv(staging_, per_layer / sizeof(half),
                 ncclHalf, prefill_rank_, inter_comm, stream);
        scatter_into_blocks(staging_, req.block_table, layer, false); // V
    }
    cudaStreamSynchronize(stream);

    // Submit the request to the decode scheduler in DECODE state
    decode_scheduler_->add_continuation(std::move(req));
}
```

Production engines (Mooncake, NVIDIA Dynamo) use RDMA directly with verb-level zero-copy. Each KV block has a registered memory region and the receiver does an RDMA Read pulling directly from the prefill GPU's HBM. This avoids the staging buffer.

### When to Disaggregate

Disaggregation pays off when:

1. Prefill and decode have very different optimal hardware. Decode wants more HBM (use H200 or MI300X), prefill wants more compute (use H100 / B200).
2. The traffic mix has long prompts. With 100-token prompts, prefill is fast and the KV transfer dominates.
3. You have idle GPUs at off-peak that can be repurposed (decode pool grows when traffic spikes).

It does not pay off when:

1. Prompts are short (chat with no system prompt, no tool history).
2. The cluster is small (< 8 GPUs). The overhead of two pools is too much.
3. The model is small (< 7B). Disaggregation overhead dominates the gains.

### Mooncake's KV Pool

Mooncake (Moonshot's serving system, public paper 2024) added a third tier: a distributed KV pool sitting on the CPUs of the prefill and decode nodes, plus NVMe spillover.

Architecture:

```
Request -> Match prompt prefix against KV pool
              hit -> RDMA pull blocks into decode GPU, skip prefill
              miss -> Prefill -> Cache result blocks into KV pool -> Decode
```

The KV pool gives system-prompt-heavy workloads (every chat conversation has the same 2k-token system prompt) ~3x throughput improvement, because most prefill work is reused.

The pool is keyed by token-prefix hash. The block manager checks the prefix table on incoming requests. The match length determines how much is reused. The remainder is recomputed.

In C++ terms:

```cpp
struct PrefixKVTable {
    // Hash of token prefix -> list of physical block ids that hold the K/V
    std::unordered_map<uint64_t, std::vector<int>> table;
    std::shared_mutex mu;
};

std::vector<int> lookup_prefix(const std::vector<int>& tokens) {
    std::vector<int> blocks;
    uint64_t h = 14695981039346656037ull;  // FNV offset
    for (size_t i = 0; i < tokens.size(); ++i) {
        h ^= static_cast<uint64_t>(tokens[i]);
        h *= 1099511628211ull;
        if ((i + 1) % block_size == 0) {
            std::shared_lock lk(table_.mu);
            auto it = table_.table.find(h);
            if (it == table_.table.end()) break;
            blocks.insert(blocks.end(), it->second.begin(), it->second.end());
        }
    }
    return blocks;
}
```

When a prefill produces new blocks for a previously-unseen prefix, you compute the rolling hash and add the blocks to the table. The pool needs an LRU or LFU eviction policy to bound memory.

### Senior at FAANG: Cost Model

The disaggregation decision is a cost engineering question. For a given traffic distribution:

```
cost_combined = (prefill_FLOPS + decode_BW_used) / GPU_combined_capacity

cost_disagg = (prefill_FLOPS / GPU_prefill_capacity)
            + (decode_BW_used / GPU_decode_capacity)
            + KV_transfer_overhead
```

If your cluster is H100-only, `cost_combined` and `cost_disagg` are similar because the GPUs are identical. If you have a heterogeneous fleet (H100 + H200, or H100 + MI300X for decode), `cost_disagg` is lower because each pool runs on its best-fit hardware.

Section 20 covers the full cost engineering. The next section dives deeper into the KV cache, which is where most production memory goes.

---
