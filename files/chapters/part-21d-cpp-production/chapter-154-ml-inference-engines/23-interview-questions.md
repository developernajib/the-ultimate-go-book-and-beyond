## Interview Questions

The 15 questions below are the depth of question you will see at L5+ on an inference team interview at OpenAI, Anthropic, Google DeepMind, NVIDIA, Meta GenAI, or any frontier lab. Senior expectations: answer the surface question, then go one or two layers deeper before the interviewer asks.

### 1. Why is decode memory-bound and prefill compute-bound?

Prefill processes a sequence of S tokens through L layers. Each layer is a GEMM with M = batch * S, N = K = hidden. M is large. Arithmetic intensity is `2 * M * N * K / (2 * (M*K + K*N + M*N))` bytes, around `M * 2 / (M + 2)`, which approaches 2 * hidden bytes per FLOP. For hidden=8192 that is 16384 FLOPs per byte: deeply compute-bound.

Decode is the same model but M = batch (no S, since one token per request). M is small (1-256). The same intensity formula gives roughly 2 * batch FLOPs per byte. For batch = 32, that is 64 FLOPs per byte. H100 peak is ~590 FLOPS / byte. We are at 11% of the compute roofline, 89% is wasted unless we batch much harder. Hence memory-bound.

Push further: the decode workload's true latency floor is `weights_bytes / HBM_bandwidth`, which on H100 (3.35 TB/s) for an FP16 70B model TP=8 is 17.5 GB / 3.35 TB/s = 5.2 ms. Anything above that floor is overhead.

### 2. Walk through the FlashAttention v1 algorithm. Why is it faster than vanilla?

Vanilla attention materializes the [S, S] attention matrix. Memory I/O for the matrix dominates the kernel.

FlashAttention tiles. For each Q block (size Bq), iterate over K/V blocks (size Bk). Compute the Bq x Bk score sub-matrix in registers. Maintain a running max `m` and running sum `l` per row, and a running output `O`. When a new tile produces a higher max, rescale the previous `O` and `l`. After all K/V tiles, normalize O by l.

The tile-level math:

```
S_ij = Q_i K_j^T
m_new = max(m_old, max(S_ij, axis=row))
P_ij = exp(S_ij - m_new)
l_new = exp(m_old - m_new) * l_old + sum(P_ij, axis=row)
O_new = exp(m_old - m_new) * O_old + P_ij V_j
```

Memory cost: O(S * D) instead of O(S^2). Speed: 2-5x because no HBM trips for the intermediate.

Senior layer: v2 inverted the loop order (outer is K/V, inner is Q) for better warp use. v3 added async WGMMA on Hopper to overlap softmax with the next matmul.

### 3. How does PagedAttention solve KV cache fragmentation?

Traditional KV cache: a `[batch, num_heads, max_seq, head_dim]` tensor. Each request reserves the worst-case slot. With variable-length requests, half the cache is wasted on padding.

PagedAttention treats the KV cache like virtual memory. Fixed-size blocks (16 tokens each). Each request has a *block table* mapping logical positions to physical block ids. Tokens in different blocks of the same request live in non-contiguous physical memory. The attention kernel reads the block table to find each block.

Wins: no internal fragmentation (blocks are 100% used until the last block of a request), no external fragmentation (free blocks can serve any request), and prefix caching (multiple requests can share read-only prefix blocks via reference counting).

The cost is a small extra memory read (the block table) per attention computation. Negligible.

### 4. Explain GQA. Why does it not hurt accuracy much?

Multi-head attention has separate K and V per head. With H query heads, the KV cache is H times the size of one head's K and V.

GQA shares K and V across groups of query heads. With H=32 query heads and K=8 KV heads, each KV head is shared by 4 query heads. KV cache shrinks by 4x.

Why accuracy holds: the heads in a transformer are highly redundant, many learn similar patterns. Sharing K and V removes some of that redundancy without removing the *ability* of different query heads to attend differently (each query head still computes its own scores). The gain in being able to fit longer context or larger batch in HBM more than offsets the small accuracy cost.

Trained-from-scratch: GQA with 8 KV heads typically loses 0.0-0.2 in perplexity vs full MHA on the same compute budget.

### 5. What is the difference between FP8 E4M3 and E5M2? When do you use each?

E4M3: 4 exponent bits, 3 mantissa bits. Range ~ +/-448. Step ~ 1/8 of the magnitude.

E5M2: 5 exponent, 2 mantissa. Range ~ +/-57344. Step ~ 1/4 of the magnitude.

E4M3 has higher precision but smaller range. Used for activations and weights, where precision matters and ranges are bounded post-normalization.

E5M2 has higher range but lower precision. Used for gradients (which can be large during training), and for KV cache (where precision matters less because the softmax averages).

Mixing: an FP8 transformer typically does GEMMs with E4M3 inputs and FP16 (or FP32) accumulators, then quantizes back to E4M3. The KV cache is E5M2 to handle outlier activations safely.

### 6. Implement the address calculation for a paged KV cache layout `[num_blocks, num_kv_heads, head_dim/x, block_size, x]`.

```cpp
size_t k_offset(int block_id, int kv_head, int dim, int token_in_block,
                int num_kv_heads, int head_dim, int block_size, int x) {
    int dim_chunk = dim / x;
    int dim_subidx = dim % x;
    return ((static_cast<size_t>(block_id) * num_kv_heads + kv_head)
            * (head_dim / x) + dim_chunk)
            * block_size * x
            + token_in_block * x
            + dim_subidx;
}
```

Why this layout: the kernel reads `x` consecutive elements of one head_dim chunk for `block_size` tokens at once. Coalesced 16-byte loads (when x=8, FP16 -> 16 bytes, or x=16, FP8 -> 16 bytes). The first axis is `num_blocks` so blocks for different requests can be allocated in any order.

### 7. A request comes in with a 10000-token prompt. The scheduler is in the middle of decoding 50 other requests. What does chunked prefill do?

Without chunking, the prefill blocks decode for 50 requests for hundreds of ms. Their TPOT spikes.

With chunked prefill: the prefill is split into chunks of size `max_batched_tokens - active_decode_count`. For example, 4096 - 50 = 4046 tokens per iteration. The prefill takes ceil(10000 / 4046) = 3 iterations. During each, the 50 decode requests still get one token each.

TTFT for the new request: 3 iterations instead of 1. Slightly worse alone, but the existing 50 requests do not stall. Globally, p99 TPOT does not spike, system stays stable.

The knob: chunk size. Larger means fewer chunks (better TTFT for big prefills) but more decode latency hit per iteration.

### 8. Why does TP work well within a NVLink node and badly across PCIe nodes?

TP requires all-reduce per layer. For an LLM with 80 layers, ~160 all-reduces per token. Each all-reduce is `2 * num_ranks * (hidden_size / num_ranks)` bytes per rank participating, roughly 2 * hidden_size bytes total per rank.

For hidden=8192, FP16, that is 32 KB per all-reduce. Over NVLink at 900 GB/s, the transfer is 35 ns of bandwidth time, dominated by ~1 us of latency. 160 all-reduces = 160 us per token. Trivial.

Over PCIe 5.0 (64 GB/s) plus IB (50 GB/s), the bandwidth time per all-reduce is in microseconds, the latency is 5-10 us per hop. 160 all-reduces = 1-2 ms per token. Significant.

Worse: ring all-reduce on 8 ranks needs 14 hops. 14 * 5 us = 70 us per all-reduce, 11 ms per token of latency, comparable to the actual compute. TP across PCIe is unworkable.

### 9. Design a block manager that supports prefix caching. What are the data structures?

Pieces:

- `std::vector<int> free_blocks`, pool of physical block ids.
- `std::vector<int> ref_counts`, refcount per physical block.
- `std::unordered_map<uint64_t, int> hash_to_block`, prefix hash -> physical block id (for cache lookup).
- `std::unordered_map<int, uint64_t> block_to_hash`, reverse mapping for evict cleanup.
- `std::list<int> lru_evictable`, blocks at refcount 0 but cached, in LRU order.

Operations:

- **allocate(req, num_tokens)**: hash incoming prompt by 16-token chunks. For each chunk, check `hash_to_block`, if hit, bump refcount, append to req's block table. For miss, pop from `free_blocks` (or evict LRU), track for later hash insertion.
- **release(req)**: decrement refcounts. If a refcount goes to 0, the block becomes evictable but stays in the cache (insert into LRU tail).
- **evict()**: pop from LRU head, free.
- **on_block_full(req, block_id, prefix_hash)**: when a block becomes immutable (last token written), insert `hash_to_block[prefix_hash] = block_id` so future requests can reuse.

The hash chains: `hash(block_i) = hash(prefix_up_to_block_i)`, computed as a rolling hash over the tokens in the block plus the previous block's hash.

### 10. What metric tells you the cluster needs more capacity?

Not GPU use (always wrong). Not CPU use (irrelevant for inference).

The right metric: **goodput at SLO**. Plot tokens-per-second-meeting-SLO over time. When this number plateaus or drops while incoming traffic is rising, capacity is exhausted.

The leading indicator: p99 TTFT or p99 TPOT exceeding the SLO budget for some duration (e.g., 5 minutes). Alarm on this.

The trailing indicator: requests rejected or queued beyond a threshold.

The lagging indicator: gross margin compression as you start using on-demand spot capacity to soak overflow.

### 11. What is speculative decoding and when does it lose?

Mechanism: a small draft model generates K candidate tokens. The big target model runs one forward pass on those K candidates. Each position's logits give a probability for the draft's chosen token. Accept if `r < p_target / p_draft` (random `r`). On rejection, resample from an adjusted distribution at that position and stop. Average accepted tokens per target forward pass: `E[accepted]`. Speedup = `E[accepted] / 1`.

When it loses:

1. The decode batch is already large. Adding K candidates per request multiplies the effective batch K-fold. The target's forward pass becomes longer than `K * (single-token forward)`, so you lose throughput.

2. Acceptance rate is low. If <50%, the verify pass cost is mostly wasted.

3. Memory pressure. Speculative decoding requires extra K/V cache for the K candidates. If KV is the bottleneck, you reduce concurrent requests, hurting overall throughput.

The right deployment: speculative on for low-batch latency-critical traffic, off for high-batch throughput-critical traffic.

### 12. Why disaggregate prefill and decode?

Prefill is compute-bound (large M GEMMs). Decode is memory-bound (small M, weights bandwidth dominates). Optimal hardware differs (more FLOPS for prefill, more HBM bandwidth and capacity for decode). Optimal batch differs (low for prefill, high for decode).

Disaggregating: prefill pool runs prefill at its compute roofline. Decode pool runs decode at its memory roofline. KV transfer between the pools.

Wins: 1.5-2x effective throughput on workloads with mixed prefill / decode. Better use of heterogeneous fleets (H100 prefill + H200 decode).

Costs: KV transfer latency (1-30 ms depending on transport). Architectural complexity. Requires the engine to support resuming a request from a freshly transferred KV cache.

Worth it when: prompts are long (so prefill is significant), traffic is high enough to fill both pools, and the KV transfer cost is amortized.

### 13. Sketch the PTQ INT4 weight + FP16 activation kernel structure.

Weights: stored as packed INT4 with per-group (typically 128 elements) FP16 scales. Layout: `[N, K/2]` for the packed weights, `[N, K/group_size]` for the scales.

Kernel:

```cpp
__global__ void w4a16_gemm(
    const half* x,              // [M, K]
    const uint8_t* w_packed,    // [N, K/2]
    const half* scales,         // [N, K/group_size]
    half* y, int M, int N, int K, int group_size) {
    // each block computes a [BM, BN] tile of y
    int row = blockIdx.x * BM + threadIdx.x;  // M dimension
    int col = blockIdx.y * BN + threadIdx.y;  // N dimension
    if (row >= M || col >= N) return;
    float acc = 0.0f;
    for (int g = 0; g < K / group_size; ++g) {
        half scale = scales[col * (K / group_size) + g];
        for (int i = 0; i < group_size; i += 2) {
            uint8_t pack = w_packed[col * (K/2) + (g*group_size + i)/2];
            int8_t  q_lo = (pack & 0x0F) - 8;       // dequant low nibble
            int8_t  q_hi = ((pack >> 4) & 0x0F) - 8;
            float w_lo = static_cast<float>(q_lo) * __half2float(scale);
            float w_hi = static_cast<float>(q_hi) * __half2float(scale);
            acc += __half2float(x[row * K + g*group_size + i])     * w_lo;
            acc += __half2float(x[row * K + g*group_size + i + 1]) * w_hi;
        }
    }
    y[row * N + col] = __float2half(acc);
}
```

Real kernels (Marlin, Machete) use Tensor Cores via WMMA / WGMMA, dequant in registers as part of the load, and tile aggressively. The skeleton above shows the algorithm, the production kernel is 1000+ lines.

### 14. What is the sequence of operations from request arrival to first token in vLLM?

1. HTTP / gRPC handler accepts the request, queues it in the engine.
2. Tokenizer encodes the prompt (CPU work, fast tokenizers in Rust C++ via Hugging Face Tokenizers).
3. Scheduler picks the request for the next iteration. Allocates KV blocks via the BlockManager. If a prefix is in the cache, reuses those blocks.
4. Model executor builds the iteration's batched input. Cu_seqlens for varlen attention. Block tables for paged attention. Position IDs.
5. Forward pass runs on GPU: embedding, N transformer layers (each: norm, paged attention, MLP, residuals), final norm, LM head.
6. Sampler computes the next token (top-k / top-p / temperature) on GPU.
7. The token is copied back to host. Detokenizer converts to a string fragment (incremental detokenization handles BPE merges across calls).
8. Response chunk streamed to the client.

For the first token (TTFT), all of step 5 includes processing the entire prompt through every layer. For subsequent tokens (TPOT), step 5 is one new token, with attention reading the now-cached K/V.

### 15. You see `PIPE_TENSOR_ACTIVE` at 25% during decode. What do you check?

25% on tensor cores in decode is normal-ish (decode is memory-bound, you cannot expect 80% tensor core busy). But before accepting it, check:

1. Batch size. If batch is 1-4, decode is GEMV-shaped, tensor cores barely engage. Push batch up.
2. Quantization. FP16 weights are bandwidth-bound. Move to FP8 or INT4 weights to halve HBM read time.
3. KV cache dtype. FP8 KV halves attention bandwidth.
4. CUDA launch overhead. If `PIPE_TENSOR_ACTIVE` is low *and* you see gaps between kernels in NSight, the launch overhead is eating cycles. Capture the decode loop in a CUDA Graph.
5. Memory layout. If KV cache or weights have stride patterns that prevent coalesced loads, bandwidth use is wasted. Check vectorized load width (16 bytes ideal).
6. NCCL all-reduce overlap. If TP is on, the all-reduce per layer can be serial with the next layer's compute. Use a dedicated comm stream and event-based overlap.

The cumulative answer: decode tensor core use is the wrong metric to chase. Watch DRAM bandwidth use. If that is at 80%+, you are at the roofline, the only way out is quantization. If it is low *and* tensor core is low, you have a launch overhead problem. CUDA Graphs is the answer.

The next section is hands-on exercises.

---
