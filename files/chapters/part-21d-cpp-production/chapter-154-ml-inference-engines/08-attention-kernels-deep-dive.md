## Attention Kernels Deep Dive

Attention is the workload of the LLM. It is also the most algorithmically interesting kernel in the stack. Every major performance win in LLM inference since 2022 has come from a smarter attention kernel: FlashAttention (2022), FlashAttention v2 (2023), PagedAttention (2023), FlashAttention v3 (2024), MQA / GQA (architectural), and the in-flight attention variants now used in TensorRT-LLM and vLLM.

This section walks the family. For each variant, the motivation, the algorithm in pseudocode, and the C++ / CUDA implementation pattern.

### Vanilla Attention

For each layer, given `Q in [B, H, S, D]`, `K in [B, H, S, D]`, `V in [B, H, S, D]`:

```
S_attn = Q @ K^T / sqrt(D)        // [B, H, S, S]
P = softmax(S_attn, axis=-1)      // [B, H, S, S]
O = P @ V                         // [B, H, S, D]
```

Memory: `O(B*H*S^2)`. For B=4, H=32, S=8192, D=128, FP16: 16 GB just for `S_attn`. Plus `P`. Plus the inputs. Plus the output.

Compute: `O(B*H*S^2*D)`. The same shape gives 64 TFLOPS of work. On an H100 at 800 TFLOPS FP16, that is 80 ms of pure GEMM. But you cannot reach peak FLOPS because you spend most time waiting on HBM I/O for the intermediate.

The vanilla path is dead for production. Nobody runs it.

### FlashAttention v1

The insight: do not materialize the `[S, S]` matrix. Tile.

```
for each block of Q (size Bq rows):
    init O_i = 0, l_i = 0, m_i = -inf      // running output, sum, max
    for each block of K, V (size Bk rows):
        S_ij = Q_i @ K_j^T                   // tiny: [Bq, Bk]
        m_new = max(m_i, max(S_ij, axis=-1))
        P_ij = exp(S_ij - m_new)
        l_new = exp(m_i - m_new) * l_i + sum(P_ij, axis=-1)
        O_new = exp(m_i - m_new) * O_i + P_ij @ V_j
        m_i, l_i, O_i = m_new, l_new, O_new
    O_i = O_i / l_i                          // final normalization
    write O_i to HBM
```

The math: the running-max trick keeps the softmax numerically stable across tiles. The output gets rescaled each time the max moves up. By the end, you have the same answer as the full softmax, with `O(S)` memory.

In CUDA C++, each thread block handles one Bq-sized chunk of Q for one head. Tiles of K/V are loaded into shared memory. Computation is in registers. The output is written to HBM once, at the end.

```cpp
// Sketch of the FlashAttention v1 kernel structure
template <int Bq, int Bk, int D>
__global__ void flash_attn_v1_kernel(
    const half* Q, const half* K, const half* V, half* O,
    int B, int H, int S, float scale) {

    __shared__ half Q_smem[Bq * D];
    __shared__ half K_smem[Bk * D];
    __shared__ half V_smem[Bk * D];
    float O_reg[Bq * D / num_threads]{};
    float l_reg[Bq / num_threads]{};
    float m_reg[Bq / num_threads];
    for (auto& m : m_reg) m = -INFINITY;

    int b = blockIdx.z, h = blockIdx.y, q_tile = blockIdx.x;
    // Load Q_i into Q_smem (cooperative)
    load_q_tile(Q, Q_smem, b, h, q_tile);
    __syncthreads();

    int num_k_tiles = (S + Bk - 1) / Bk;
    for (int kt = 0; kt < num_k_tiles; ++kt) {
        load_kv_tile(K, V, K_smem, V_smem, b, h, kt);
        __syncthreads();

        float S_ij[Bq * Bk / num_threads];
        compute_qk(Q_smem, K_smem, S_ij, scale);

        // Online softmax update
        float m_new[/*per row owned by this thread*/];
        // ... compute new max, rescale O_reg, update l, accumulate P @ V
        compute_pv(S_ij, V_smem, O_reg, l_reg, m_reg, m_new);
        __syncthreads();
    }

    // Final normalize and write
    write_output(O, O_reg, l_reg, b, h, q_tile);
}
```

The real kernel is hundreds of lines because of MMA (matrix multiply accumulate) tiling, register usage, and the cooperative load patterns. CUTLASS provides the MMA tiles. FlashAttention layers the algorithm on top.

### FlashAttention v2

v2 reorganized the loop nest. v1 had the K/V tile loop *inside* the Q tile loop. v2 inverted: the Q loop is inside, K/V outside. The reasons:

1. Better warp-level work distribution. Warps process different Q rows in parallel rather than serially.
2. Fewer non-matmul ops. The rescaling logic moved out of the hot loop.
3. Better occupancy on Ampere (A100).

The result was a roughly 2x speedup over v1 on long sequences.

### FlashAttention v3

v3 (Hopper-specific) added asynchronous WGMMA, FP8 paths, and TMA (Tensor Memory Accelerator) for async loads from HBM. The core algorithm is similar to v2 but the implementation pipeline is different:

```
warp group A: WGMMA Q @ K^T  (async)
              wait
              softmax stats (rescaled)
              WGMMA P @ V    (async)
              wait
              write O
warp group B: same but offset by half a tile
              => overlap A's softmax with B's WGMMA
```

The result is closer to peak Tensor Core throughput on H100 (~75% of dense FP16, ~70% of dense FP8).

You do not implement v3 by hand. Link `flash-attn==2.7+` (which includes v3) or use cuDNN's SDPA API. The C++ frontend takes Q, K, V tensor pointers, scale, mask configuration, returns O.

### PagedAttention (vLLM)

The problem: in continuous batching, requests have different lengths. A naive KV cache layout `[batch, num_heads, max_seq, head_dim]` allocates the worst case for every request, wasting memory.

PagedAttention borrows from OS virtual memory. The KV cache is partitioned into fixed-size *blocks* (typically 16 tokens per block). Each request has a *block table*, mapping its logical token positions to physical block indices. The kernel reads the block table to find K and V for each token.

```cpp
// KV cache layout
// k_cache: [num_blocks, num_heads, head_dim/x, block_size, x]   x=8 or 16 for vec loads
// v_cache: [num_blocks, num_heads, head_dim, block_size]

struct PagedAttentionInputs {
    const half* q;            // [num_seqs, num_heads, head_dim]
    const half* k_cache;      // [num_blocks, num_kv_heads, head_dim/x, block_size, x]
    const half* v_cache;      // [num_blocks, num_kv_heads, head_dim, block_size]
    const int* block_tables;  // [num_seqs, max_blocks_per_seq]
    const int* context_lens;  // [num_seqs]
    half* out;                // [num_seqs, num_heads, head_dim]
    int num_heads, num_kv_heads, head_dim, block_size, max_blocks_per_seq;
    float scale;
};

__global__ void paged_attention_kernel(PagedAttentionInputs in) {
    int seq_idx = blockIdx.x;
    int head_idx = blockIdx.y;
    int kv_head_idx = head_idx / (in.num_heads / in.num_kv_heads);  // GQA
    int context_len = in.context_lens[seq_idx];

    extern __shared__ char smem[];
    float* logits = reinterpret_cast<float*>(smem);  // [context_len], padded

    // Phase 1: compute Q @ K^T for all keys in this sequence
    // Iterate blocks via block_tables[seq_idx]
    int num_blocks = (context_len + in.block_size - 1) / in.block_size;
    for (int blk = 0; blk < num_blocks; ++blk) {
        int phys = in.block_tables[seq_idx * in.max_blocks_per_seq + blk];
        // Compute QK for the block_size keys in this physical block
        compute_qk_block(in, seq_idx, head_idx, kv_head_idx, phys, blk, logits);
    }

    // Phase 2: online softmax across logits
    float max_logit = block_max(logits, context_len);
    float sum_exp = 0;
    for (int i = threadIdx.x; i < context_len; i += blockDim.x) {
        logits[i] = expf(logits[i] - max_logit);
        sum_exp += logits[i];
    }
    sum_exp = block_sum(sum_exp);

    // Phase 3: weighted sum P @ V
    float out_acc[HEAD_DIM_PER_THREAD]{};
    for (int blk = 0; blk < num_blocks; ++blk) {
        int phys = in.block_tables[seq_idx * in.max_blocks_per_seq + blk];
        accumulate_pv_block(in, kv_head_idx, phys, blk, logits, sum_exp, out_acc);
    }

    write_output(in.out, seq_idx, head_idx, out_acc);
}
```

The real vLLM kernel is `paged_attention_v1` and `paged_attention_v2` in `csrc/attention/`. v2 partitions the context dim across blocks and uses a separate reduction kernel, which helps on long contexts.

The C++ host code maintains the block tables, allocates blocks from a pool, and frees blocks when a request finishes. This is the Block Manager. Section 9 covers it in detail.

### Multi-Query Attention (MQA) and Grouped-Query Attention (GQA)

In standard multi-head attention, each head has its own K and V. For 32 query heads, you have 32 K heads and 32 V heads. The KV cache size is proportional to `num_heads`.

MQA shares one K and V across all query heads. The KV cache is 32x smaller. Quality is somewhat lower than full MHA.

GQA shares K and V across *groups* of query heads. With 32 query heads and 8 KV heads, each KV head is shared by 4 query heads. The KV cache is 4x smaller. Quality is close to MHA.

In 2026 every serious LLM (Llama 3, Mistral, Mixtral, Gemma 3, Qwen 3) uses GQA. The kernels just need to know `num_kv_heads`:

```cpp
int kv_head_idx = q_head_idx / (num_q_heads / num_kv_heads);
const half* k_for_this_head = k_cache + kv_head_idx * (head_dim * S);
```

Memory savings flow directly into either bigger batches (more tokens per second per GPU) or longer contexts (more tokens per request). Both are wins.

### Continuous Batching Attention

Continuous batching means requests at different stages share the same forward pass. Some are doing prefill (long sequence, many tokens), others are doing decode (one new token per request). A single attention call must handle both.

The trick: pad nothing. Instead, pass a `cu_seqlens` array (cumulative sequence lengths) and let the kernel compute starting offsets per request. The total number of tokens is the sum, and that is the M dimension of the GEMM.

```cpp
// cu_seqlens_q = [0, 7, 15, 16, 17, ...]  (req 0 has 7 query tokens, req 1 has 8, etc)
// cu_seqlens_k = [0, 100, 250, 251, 252, ...]  (req 0 has 100 keys, etc)

void varlen_flash_attention(
    const half* q,             // [total_q_tokens, num_heads, head_dim]
    const half* k,             // [total_k_tokens, num_kv_heads, head_dim]
    const half* v,             // [total_k_tokens, num_kv_heads, head_dim]
    const int* cu_seqlens_q,
    const int* cu_seqlens_k,
    int max_seqlen_q, int max_seqlen_k,
    half* out,
    cudaStream_t stream);
```

This is the kernel TGI and vLLM both use for the prefill path. Flash-attn calls it `flash_attn_varlen_func`. cuDNN exposes the same idea via segment IDs.

### Senior at FAANG: Attention as the Roofline

For decode (M=batch, K=num_tokens, D=head_dim per head), attention is memory-bound: each token requires reading the full KV cache. The arithmetic intensity is roughly 1 op per byte, far below the H100 peak ratio of ~590 ops/byte.

For prefill (long sequence per request), attention is compute-bound, dominated by the Q@K^T and P@V matmuls.

This compute-vs-memory split is *the* reason prefill / decode disaggregation (section 12) makes sense. Putting prefill and decode on the same GPU forces a compromise: either you waste compute (decode workload) or you waste memory bandwidth (prefill workload). Splitting them lets each pool run at its true bottleneck.

The next section pulls the engine together.

---
