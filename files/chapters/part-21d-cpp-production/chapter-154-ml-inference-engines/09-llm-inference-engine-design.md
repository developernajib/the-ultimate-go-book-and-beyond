## LLM Inference Engine Design

This section connects the kernels into a complete engine. The design follows vLLM and TensorRT-LLM with simplifications for clarity. The goal is a C++ skeleton that you could grow into a real engine, plus an explanation of why each component exists.

### The Big Picture

```
+--------------+   +-----------+   +------------+   +----------+
| API server   |-->| Tokenizer |-->| Scheduler  |-->| Executor |
+--------------+   +-----------+   +------------+   +----------+
                                          |              |
                                          v              v
                                   +--------------+ +-------------+
                                   | BlockManager | | Model on GPU|
                                   +--------------+ +-------------+
                                          |
                                          v
                                   +--------------+
                                   | KV Cache pool|
                                   +--------------+
```

A token's path through the system on each iteration:

1. **Scheduler** picks a batch of requests to run this iteration. Mix of prefill and decode.
2. **BlockManager** assigns physical KV blocks to any new tokens that will be generated.
3. **Executor** runs the model forward pass on the batched input, writing new K/V to the assigned blocks.
4. **Sampler** picks the next token for each request.
5. **Detokenizer** converts the token id to a string fragment, sent back to the client.
6. **Scheduler** updates request state, frees blocks for finished requests.

This loop runs ~100 to 1000 times per second per GPU.

### Request Lifecycle

```cpp
enum class RequestState { kPending, kPrefill, kDecode, kFinished, kAborted };

struct Request {
    uint64_t id;
    std::vector<int> input_token_ids;     // input prompt
    std::vector<int> output_token_ids;    // generated so far
    int max_new_tokens;
    SamplingParams sampling;
    RequestState state = RequestState::kPending;

    // Block table: logical block -> physical block index in KV pool
    std::vector<int> block_table;
    int num_computed_tokens = 0;          // prefix already through prefill
    bool is_streaming = true;
    std::function<void(const std::string&)> on_token;
    std::function<void(const FinishReason&)> on_finish;
};
```

`num_computed_tokens` lets you do *chunked prefill*: process the prompt in chunks across multiple iterations rather than monolithically. This keeps prefill from blocking decode requests for too long.

### Block Manager (PagedAttention's Heart)

The BlockManager owns a pool of fixed-size KV blocks (16 tokens each is typical). It hands them out to requests and reclaims them on completion.

```cpp
class BlockManager {
public:
    BlockManager(int num_blocks, int block_size)
        : block_size_(block_size), num_blocks_(num_blocks) {
        free_blocks_.reserve(num_blocks);
        for (int i = num_blocks - 1; i >= 0; --i) free_blocks_.push_back(i);
        ref_counts_.assign(num_blocks, 0);
    }

    // Allocate enough blocks to hold `num_tokens` for this request
    bool allocate(Request& req, int num_tokens) {
        int needed = (num_tokens + block_size_ - 1) / block_size_
                   - static_cast<int>(req.block_table.size());
        if (needed > static_cast<int>(free_blocks_.size())) return false;
        for (int i = 0; i < needed; ++i) {
            int blk = free_blocks_.back();
            free_blocks_.pop_back();
            ++ref_counts_[blk];
            req.block_table.push_back(blk);
        }
        return true;
    }

    // Release blocks. With prefix sharing, only blocks at refcount 0 actually free.
    void release(Request& req) {
        for (int blk : req.block_table) {
            if (--ref_counts_[blk] == 0) {
                free_blocks_.push_back(blk);
            }
        }
        req.block_table.clear();
    }

    // Prefix caching: try to share blocks with another request that has the same prefix
    bool try_share_prefix(Request& req, const std::vector<int>& prefix_blocks) {
        for (int blk : prefix_blocks) ++ref_counts_[blk];
        req.block_table.insert(req.block_table.end(),
                               prefix_blocks.begin(), prefix_blocks.end());
        return true;
    }

    int num_free() const { return static_cast<int>(free_blocks_.size()); }

private:
    int block_size_;
    int num_blocks_;
    std::vector<int> free_blocks_;
    std::vector<int> ref_counts_;
};
```

The two non-obvious bits:

**Reference counting** lets multiple requests share a prefix. If 1000 requests start with the same 200-token system prompt, you fill 13 blocks once (200 / 16 = 12.5), and every subsequent request just bumps the refcount. Massive memory saving for chat APIs with long system prompts.

**Eviction policy.** When you run out of blocks, you have to either reject new requests or preempt a running request (write its KV to host RAM, free the blocks, restart later). vLLM uses a swap mechanism. TensorRT-LLM uses LRU on a CPU mirror. Either works, pick one and stick with it.

### Scheduler

The scheduler decides which requests run this iteration. The tradeoffs:

- **Decode requests** are cheap per token but require K/V from prior iterations.
- **Prefill requests** are expensive (process N input tokens at once) but unblock the user (TTFT).
- **Memory budget** caps total active requests.

A simple priority scheduler:

```cpp
struct ScheduledBatch {
    std::vector<Request*> prefill;   // requests doing prefill this step
    std::vector<Request*> decode;    // requests doing decode this step
    int total_tokens_to_process = 0;
};

class Scheduler {
public:
    Scheduler(BlockManager* bm, int max_batched_tokens, int max_running)
        : bm_(bm), max_batched_tokens_(max_batched_tokens),
          max_running_(max_running) {}

    void add_request(std::unique_ptr<Request> req) {
        std::lock_guard lk(mu_);
        waiting_.push_back(std::move(req));
    }

    ScheduledBatch step() {
        std::lock_guard lk(mu_);
        ScheduledBatch batch;

        // 1. Continue all running decode requests first
        for (auto& req : running_) {
            if (req->state != RequestState::kDecode) continue;
            if (!bm_->allocate(*req, req->num_computed_tokens
                                     + static_cast<int>(req->output_token_ids.size())
                                     + 1)) {
                // Out of blocks: preempt the lowest-priority running req and retry
                preempt_one();
                bm_->allocate(*req, /*...*/);
            }
            batch.decode.push_back(req.get());
            batch.total_tokens_to_process += 1;
        }

        // 2. Admit new prefill requests up to budget
        while (!waiting_.empty()
               && static_cast<int>(running_.size()) < max_running_
               && batch.total_tokens_to_process < max_batched_tokens_) {
            auto& req = waiting_.front();
            int prompt_len = static_cast<int>(req->input_token_ids.size());
            int chunk = std::min(prompt_len - req->num_computed_tokens,
                                 max_batched_tokens_ - batch.total_tokens_to_process);
            if (chunk <= 0) break;
            if (!bm_->allocate(*req, req->num_computed_tokens + chunk)) break;
            req->state = RequestState::kPrefill;
            batch.prefill.push_back(req.get());
            batch.total_tokens_to_process += chunk;
            // Move from waiting to running on first chunk
            if (req->num_computed_tokens == 0) {
                running_.push_back(std::move(req));
                waiting_.pop_front();
            }
        }

        return batch;
    }

    void mark_finished(Request* req) {
        std::lock_guard lk(mu_);
        bm_->release(*req);
        // remove from running_
    }

private:
    void preempt_one();  // implementation depends on policy

    BlockManager* bm_;
    int max_batched_tokens_;
    int max_running_;
    std::mutex mu_;
    std::deque<std::unique_ptr<Request>> waiting_;
    std::vector<std::unique_ptr<Request>> running_;
};
```

`max_batched_tokens` is the sum of (prefill chunk sizes) + (decode token count) per step. Around 4096 to 16384 is typical for an H100. Higher means longer prefill chunks (worse decode latency for everyone in the batch). Lower means smaller batches (worse throughput).

### Executor: The Forward Pass

The executor takes the scheduled batch and runs the model:

```cpp
class Executor {
public:
    void run(const ScheduledBatch& batch) {
        // 1. Build the input token tensor
        std::vector<int> input_ids;
        std::vector<int> position_ids;
        std::vector<int> cu_seqlens_q;
        std::vector<int> cu_seqlens_k;
        std::vector<int> block_table_flat;
        int cu_q = 0, cu_k = 0;
        cu_seqlens_q.push_back(0);
        cu_seqlens_k.push_back(0);

        for (auto* req : batch.prefill) {
            int chunk_start = req->num_computed_tokens;
            int chunk_end = std::min(static_cast<int>(req->input_token_ids.size()),
                                      chunk_start + max_chunk_);
            for (int i = chunk_start; i < chunk_end; ++i) {
                input_ids.push_back(req->input_token_ids[i]);
                position_ids.push_back(i);
            }
            cu_q += chunk_end - chunk_start;
            cu_k += chunk_end;            // k context = all tokens up to chunk_end
            cu_seqlens_q.push_back(cu_q);
            cu_seqlens_k.push_back(cu_k);
        }
        for (auto* req : batch.decode) {
            int next_pos = req->input_token_ids.size() + req->output_token_ids.size();
            int last_token = req->output_token_ids.empty()
                ? req->input_token_ids.back()
                : req->output_token_ids.back();
            input_ids.push_back(last_token);
            position_ids.push_back(next_pos);
            cu_q += 1;
            cu_k += next_pos + 1;
            cu_seqlens_q.push_back(cu_q);
            cu_seqlens_k.push_back(cu_k);
        }

        // 2. Copy to GPU pinned buffers
        cudaMemcpyAsync(d_input_ids_, input_ids.data(),
                        input_ids.size() * sizeof(int),
                        cudaMemcpyHostToDevice, stream_);
        // ... same for position_ids, cu_seqlens, block_tables

        // 3. Forward pass through the model
        model_->forward(
            d_input_ids_, d_position_ids_,
            d_cu_seqlens_q_, d_cu_seqlens_k_,
            d_block_table_, d_logits_,
            static_cast<int>(input_ids.size()),
            stream_);

        // 4. Sample next tokens for the decode portion of the batch
        sampler_->sample(d_logits_, batch, stream_);

        // 5. Copy the sampled tokens back, append to requests
        cudaStreamSynchronize(stream_);
        commit_results(batch);
    }
};
```

Step 5's synchronize is the simple version. A real engine pipelines: while step `t` syncs, the scheduler is preparing step `t+1`. CUDA Graphs (section 14) eliminate launch overhead within step `t`.

### Speculative Decoding

The decode loop is bottlenecked on the sequential `forward` per token. Speculative decoding tries to predict K tokens at once and verify them in parallel.

**Draft model.** A small model (1B params) generates K candidate tokens autoregressively. The big model runs *one forward pass* on those K candidates as if they were a sequence. Each position in the big model's output gives a probability distribution. You compare the draft's chosen token at position i against the big model's distribution: if the big model would have sampled that token, accept, if not, reject from that point and keep what was accepted.

```cpp
struct SpeculativeStep {
    std::vector<int> draft_tokens;  // K candidates from draft model
    std::vector<float> draft_probs; // p_draft(token_i)
};

void speculative_decode(Request& req, int K) {
    // 1. Draft: run small model K times autoregressively
    SpeculativeStep step;
    int last_token = req.last_token();
    for (int i = 0; i < K; ++i) {
        auto [tok, p] = draft_model_.step(last_token);
        step.draft_tokens.push_back(tok);
        step.draft_probs.push_back(p);
        last_token = tok;
    }

    // 2. Target: run big model on [original_last, draft_0, ..., draft_K-1]
    auto target_logits = target_model_.forward(/* K+1 positions */);

    // 3. Verify: accept tokens with probability min(1, p_target / p_draft)
    int accepted = 0;
    for (int i = 0; i < K; ++i) {
        float p_target = softmax(target_logits[i])[step.draft_tokens[i]];
        float r = uniform();
        if (r < p_target / step.draft_probs[i]) {
            req.append_token(step.draft_tokens[i]);
            ++accepted;
        } else {
            // Resample from adjusted distribution at position i
            req.append_token(adjusted_sample(target_logits[i], step));
            break;
        }
    }
    // If all K accepted, also sample one extra from target_logits[K]
    if (accepted == K) req.append_token(sample(target_logits[K]));
}
```

In practice, acceptance rates of 60-80% are common. With K=5 and 70% acceptance, you generate ~3.5 tokens per big-model forward pass instead of 1. 3.5x throughput on the same hardware.

### Medusa Heads

Medusa replaces the draft model with extra prediction heads on the target model itself. Each head predicts the i-th-next token. Training is cheap (few hours, only the heads). At inference, you generate a *tree* of candidate tokens, run the target model on the tree's flattened representation, and accept the longest matching path.

The C++ implementation is similar to speculative decoding but the verifier walks a tree instead of a linear sequence. Tree attention masks (each token attends only to its ancestors in the tree) replace the standard causal mask.

### Senior at FAANG: Engine Architecture Decisions

The big architectural decisions you make in a real engine:

1. **Where does the scheduler live?** Per-GPU (each GPU has its own scheduler) or central (one scheduler dispatches to all GPUs)? Central scales to ~10 GPUs, then becomes a bottleneck. Per-GPU plus a top-level router scales further.

2. **Synchronous or async forward?** Sync is simpler. Async (kick off forward, do scheduling for next step in parallel) hides scheduling overhead, gains 5-15%.

3. **Chunked prefill or not?** Yes. Always yes. The TTFT savings for waiting decode requests are large.

4. **Speculative on or off?** Default off, on as a per-deployment switch. Speculative loses on already-batched workloads (the verify pass is slower than just running the bigger batch).

5. **CUDA Graphs for decode?** Yes if your batch sizes are predictable (capture a graph per common batch size). 5-30% speedup. See section 14.

The next section addresses how to scale this engine beyond one GPU.

---
