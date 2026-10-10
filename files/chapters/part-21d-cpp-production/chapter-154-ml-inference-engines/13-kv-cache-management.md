## KV Cache Management

The KV cache is the single largest memory consumer in LLM inference. For a 70B model with 8K context per request and 100 concurrent requests, the KV cache alone is 80+ GB. Managing it well is the difference between hitting your throughput SLO and OOM crashing every five minutes.

### The Math

For each transformer layer, attention reads keys and values for every prior token. Caching them avoids recomputation.

Per-token, per-layer KV bytes:

```
bytes_per_token_per_layer = 2 * num_kv_heads * head_dim * dtype_bytes
```

Total per request:

```
bytes_per_request = bytes_per_token_per_layer * num_layers * context_length
```

Concrete numbers, Llama 3 70B FP16, GQA with 8 KV heads, head_dim=128:

```
per_token_per_layer = 2 * 8 * 128 * 2 = 4096 bytes (4 KB)
per_token_all_layers = 4096 * 80 = 327 KB
8K context = 327 KB * 8192 = 2.7 GB per request
```

A single 8K-context request takes 2.7 GB just for KV. Hundred requests at 8K = 270 GB. Far more than one GPU.

For Llama 3 8B (32 layers, 8 KV heads, head_dim=128) the per-token-all-layers is 65 KB, 8K context is 540 MB. More forgiving but still significant.

### Paged Layout

vLLM's PagedAttention layout for K (V is similar but with different inner-axis):

```
k_cache shape: [num_blocks, num_kv_heads, head_dim/x, block_size, x]
   where x = 8 for FP16 (16-byte vectorized loads), 16 for FP8
```

The unusual `head_dim/x, block_size, x` arrangement is for coalesced loads in the attention kernel. Each thread loads `x` consecutive elements of one head_dim chunk for `block_size` tokens at once.

```cpp
// Address calculation for k_cache[block_id, head, dim, token]
size_t k_offset(int block_id, int head, int dim, int token,
                int num_heads, int head_dim, int block_size, int x) {
    int dim_block = dim / x;
    int dim_offset = dim % x;
    return ((static_cast<size_t>(block_id) * num_heads + head) * (head_dim / x) + dim_block)
           * block_size * x
           + token * x
           + dim_offset;
}
```

The block_size is typically 16. Smaller blocks mean more block-table overhead per request. Larger blocks waste memory at request boundaries (the last block is partially used).

### Block Table

Each request has a block table mapping its logical token positions to physical block IDs.

```cpp
struct RequestKVState {
    std::vector<int> block_table;  // logical block i -> physical block id
    int num_filled_tokens;          // how many tokens have K/V filled
};
```

When the request generates a new token, the engine writes to:

```
logical_block = num_filled_tokens / block_size
within_block  = num_filled_tokens % block_size
physical_block = request.block_table[logical_block]
```

If `num_filled_tokens % block_size == 0`, allocate a new block first.

### Prefix Caching

Long shared prompts (system prompts, few-shot examples) get reused across requests. Prefix caching reuses the same physical blocks for those prefix tokens.

The mechanism: when a request starts, the engine hashes its prompt token-by-token in `block_size` increments. If the hash hits an existing block, use it (bump refcount, do not recompute that block). If miss, allocate new and remember the hash.

```cpp
class PrefixCache {
public:
    struct Block {
        int physical_id;
        int ref_count;
        std::array<int, 16> tokens;  // for verification on hash collision
        uint64_t hash;
    };

    // Returns the physical block id for the given token sequence,
    // or -1 if not cached.
    int lookup(const std::vector<int>& tokens, size_t start_idx,
               int block_size, uint64_t prefix_hash) {
        std::shared_lock lk(mu_);
        auto it = table_.find(prefix_hash);
        if (it == table_.end()) return -1;
        // Verify tokens match (collision check)
        for (int i = 0; i < block_size; ++i) {
            if (it->second.tokens[i] != tokens[start_idx + i]) return -1;
        }
        return it->second.physical_id;
    }

    void insert(uint64_t hash, int physical_id,
                const std::vector<int>& tokens, size_t start, int block_size) {
        std::unique_lock lk(mu_);
        Block b{physical_id, 1, {}, hash};
        for (int i = 0; i < block_size; ++i) b.tokens[i] = tokens[start + i];
        table_[hash] = b;
    }

private:
    std::shared_mutex mu_;
    std::unordered_map<uint64_t, Block> table_;
};
```

Hashing scheme: rolling FNV-1a or xxhash over `(parent_hash, token_id_block)`. Each block's hash depends on all preceding tokens in the request, so the hash uniquely identifies the prefix.

When a block is freed (refcount drops to zero from active requests), you can keep it in the cache anyway (treat it as evictable but still hashed). LRU eviction kicks in when you need free physical blocks.

Production cache hit rates for chat workloads: 50 to 90% of prompt tokens are cache hits. The TTFT improvement is proportional.

### KV Cache Compression

Three approaches:

**Quantization** (covered in section 6). FP8 KV cache halves memory.

**Eviction.** Drop K and V for tokens deemed unimportant. H2O (Heavy-Hitter Oracle), StreamingLLM (keep first few "sink" tokens + recent window). Lossy but useful for very long contexts.

**Sharing.** GQA / MQA share K and V across query heads. Architectural choice, not a runtime knob.

For most production deployments in 2026, FP8 KV cache + GQA is the standard combo.

### Cache Hit Ratio Measurement

A cache hit ratio metric helps you tune prefix cache size:

```cpp
struct CacheStats {
    std::atomic<uint64_t> hits{0};
    std::atomic<uint64_t> misses{0};

    double hit_ratio() const {
        uint64_t h = hits.load(), m = misses.load();
        return h + m == 0 ? 0.0 : static_cast<double>(h) / (h + m);
    }
};
```

Track hits and misses at the *block* granularity (a 100-block prompt with 50 hits has 50% hit ratio). Plot hit ratio vs cache size to find the knee. Hit ratio is the lever that determines whether your TTFT goal is achievable at the chosen cluster size.

### Sliding Window Attention and KV Truncation

Some models (Mistral, Gemma, Phi) use sliding window attention: each token only attends to the last N (e.g., 4096) tokens. The KV cache only needs to keep N tokens per layer.

For these models, the cache is a circular buffer:

```cpp
struct SlidingKVCache {
    int window_size;
    int write_pos;     // next slot to write
    int valid_tokens;  // min(written, window_size)
    half* k_buffer;    // [num_layers, num_kv_heads, window_size, head_dim]
    half* v_buffer;
};
```

Implementation note: the attention kernel needs to know the start position of the valid range so it does not score against stale tokens. This is typically passed as a per-head sliding-window mask argument.

### Multi-Request KV Pool Sizing

For a fleet GPU, the KV pool size determines how many concurrent requests fit:

```
free_HBM = total_HBM - weights - activations - workspace
num_blocks = free_HBM / (block_size * per_token_per_layer * num_layers)
max_concurrent_tokens = num_blocks * block_size
max_concurrent_requests ~= max_concurrent_tokens / avg_context_length
```

For a 70B model on H100 80GB with TP=4 (so 35 GB weights / GPU, ~30 GB free):

```
per_token_all_layers = 327 KB (FP16) or 164 KB (FP8)
num_blocks_FP16 = 30 GB / (16 * 4 KB) = 30 GB / 64 KB = ~480k blocks per GPU
                 = 7.6 M tokens per GPU
                 = ~1900 concurrent requests at 4k context
```

Move to FP8 KV: 3800 concurrent requests. Move to MQA / GQA-1: even more. These knobs are the difference between \$1 / 1k tokens and \$0.30 / 1k tokens.

### Senior at FAANG: KV Cache Allocation Failures

When the KV pool runs out, your engine has to do something. Three options:

1. **Reject the new request.** Simple. Caller retries.
2. **Preempt a running request.** Save its KV to host RAM (or NVMe), free the GPU blocks, replay later.
3. **Recompute on resume.** Throw away the KV. When the request comes back, reprocess the entire prompt. Used in vLLM as a fallback.

Each has tradeoffs. Reject is fast but raises error rates. Preempt is good but requires fast device-to-host transfer (use pinned memory, async copies). Recompute is the most general but costs the longest TTFT spike.

A production engine implements all three with priority: try preempt first, fall back to recompute, give up and reject only when the queue is too long.

The next section covers CUDA Graphs, which eliminate kernel launch overhead in the decode loop.

---
