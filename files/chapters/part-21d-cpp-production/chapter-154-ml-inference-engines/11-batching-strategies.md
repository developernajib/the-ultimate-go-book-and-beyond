## Batching Strategies

A GPU is fast on big tensors and bad on small ones. Tensor Cores need at least 16 rows of M to reach peak throughput. Below that, you waste silicon. Batching is the technique to convert many small concurrent requests into one big tensor that uses the GPU well.

For inference there are three regimes (static, dynamic, continuous), and within continuous batching there are sub-strategies (chunked prefill, in-flight batching, prefill / decode split). This section walks them with the throughput / latency tradeoffs each makes.

### Static Batching

Wait for B requests, batch them, run forward once, return all B responses. Used in the original TensorFlow Serving and early Triton.

Latency for the first request to arrive: `wait_for_full_batch + forward_time`. If requests arrive at rate R and the batch size is B, average wait is `B / (2R)` plus the variance. For a chat workload at 10 RPS with B=32, the wait alone is 1.6 seconds. Unacceptable for any latency-sensitive use.

Static batching is dead for LLMs. It survives in offline batch inference (image classification of a million photos), where you do not care about latency.

### Dynamic Batching

Wait until either B requests have queued *or* T milliseconds have passed, whichever comes first. Then run the batch.

The Triton implementation:

```cpp
// Triton dynamic batcher pseudo-config
{
    "max_batch_size": 32,
    "dynamic_batching": {
        "preferred_batch_sizes": [4, 8, 16, 32],
        "max_queue_delay_microseconds": 5000
    }
}
```

The scheduler waits up to 5 ms or 32 requests, then dispatches. Latency floor is `max_queue_delay + forward_time`. Throughput improves over single-request because forward is amortized.

For non-streaming workloads with similar request shapes (image classification, sentence embedding, ranking models), dynamic batching is the right answer. For LLMs with variable output length, dynamic batching is still wrong: you have to wait for the longest request in the batch to finish before any of the responses go out.

### Continuous Batching (a.k.a. In-Flight Batching)

The breakthrough that made high-throughput LLM serving viable. Coined by Orca (2022), popularized by vLLM.

The idea: at every decode iteration, the batch can change. New requests join, finished requests leave. Each request stays in the batch only while it has tokens left to generate.

```
iter t:    R1 (decode), R2 (decode), R3 (prefill 100 tokens)
iter t+1:  R1 (decode), R2 (decode), R3 (decode)               <- R3 finished prefill, now decode
iter t+2:  R1 (decode), R2 (finished, dropped), R3 (decode), R4 (prefill 50 tokens)
iter t+3:  R1 (decode), R3 (decode), R4 (decode), R5 (prefill 200)
```

Requests do not wait for siblings. Each finishes when *its* output is done. TTFT depends only on when the prefill chunk runs.

The C++ implementation requires:

1. **Per-iteration scheduling.** Section 9's scheduler.
2. **PagedAttention.** So a batch of requests with different lengths can share the KV cache pool without padding.
3. **Variable-length attention kernel.** Flash-attn varlen, or cuDNN's segmented SDPA.
4. **Per-request sampling state.** Each request has its own temperature, top-k, top-p, etc.

Triton calls this "in-flight batching" in their TensorRT-LLM backend. vLLM and TGI call it "continuous batching." Same thing.

### Chunked Prefill

The single longest blocker in continuous batching is a long prefill. If a request arrives with 10000 input tokens, processing them all in one iteration takes hundreds of ms during which no decode tokens go out for any other request.

Chunked prefill splits the prompt into chunks (typically 512 or 1024 tokens). Each iteration runs one chunk plus the decode tokens of running requests:

```
iter t:    R1 decode (1 token), R2 decode (1), R3 prefill chunk 0 (512 tokens)
iter t+1:  R1 decode, R2 decode, R3 prefill chunk 1 (512 tokens)  <- R1, R2 still get tokens
iter t+2:  R1 decode, R2 decode, R3 prefill chunk 2 (512 tokens)
...
iter t+19: R1 decode, R2 decode, R3 prefill chunk 19 (rest)
iter t+20: R1 decode, R2 decode, R3 decode (1 token)               <- R3 first output token
```

The TTFT for R3 is now `20 * iter_time` instead of `prefill_full_time`, slightly worse for R3 alone but the decode TPOT for R1 and R2 stays steady. Net throughput goes up, p99 TPOT drops dramatically.

Chunk size is a knob. Too small means too many iterations to finish a long prefill. Too large means decode latency starvation. 512 to 2048 is the typical range. vLLM's default in 2026 is dynamic: chunk size = `max_batched_tokens - active_decode_count`.

### In-Flight Batching (Triton Terminology)

Triton's TensorRT-LLM backend uses "in-flight batching" for continuous batching with chunked prefill. The C++ API exposes this through the `tensorrt_llm::executor::Executor` (section 4):

```cpp
tle::ExecutorConfig cfg;
cfg.setSchedulerConfig(tle::SchedulerConfig{
    tle::CapacitySchedulerPolicy::kMAX_UTILIZATION,
    tle::ContextChunkingPolicy::kFIRST_COME_FIRST_SERVED
});
cfg.setKvCacheConfig(tle::KvCacheConfig{
    /*enableBlockReuse=*/true,
    /*maxTokens=*/1<<20,
    /*maxAttentionWindow=*/std::nullopt,
    /*sinkTokenLength=*/std::nullopt,
    /*freeGpuMemoryFraction=*/0.9f
});

tle::Executor exec("engine_dir", tle::ModelType::kDECODER_ONLY, cfg);
```

`enableBlockReuse=true` turns on prefix caching: identical system prompts reuse the same KV blocks across requests.

### Batch Size vs Latency vs Throughput

The fundamental triangle. You can have any two:

- **Low latency, high throughput**: requires low batch size *and* high batch size at the same time. Impossible.
- **Low latency, low cost (low throughput)**: B=1, fast per-request, expensive per-token.
- **High throughput, high latency**: B=128, slow per-request, cheap per-token.
- **Low latency, high throughput**: only achievable through algorithm-level wins (FlashAttention, speculative decoding, FP8) that change the underlying curve.

A typical Llama 3 70B at TP=8 on H100 NVL hits something like:

| Batch | TPOT (ms) | TTFT (ms, 1k tokens prompt) | tokens / GPU / s |
|-------|-----------|----------------------------|------------------|
| 1 | 12 | 50 | 10 |
| 8 | 18 | 60 | 56 |
| 32 | 28 | 90 | 142 |
| 128 | 60 | 200 | 267 |
| 256 | 110 | 350 | 290 |

The curve is sub-linear: doubling batch does not double throughput, because attention's KV cache I/O grows with both batch and context. Around B=128 to 256 the per-token throughput plateaus.

The right batch is the one where TPOT meets your SLO. If your product needs TPOT <30 ms, your max batch is around 32. If your batch product is "summarize this transcript, return when done" you can run B=256 and tolerate seconds.

### Prefill / Decode Split

Inside one engine, both phases are running. Prefill is compute-bound, decode is memory-bound. They have very different optimal batch sizes:

- Prefill optimal batch: 1 to 4 requests * thousands of tokens = high M. Already plenty of work for the GPU.
- Decode optimal batch: 64 to 256 requests, each contributing 1 token. Small per-request, large batch makes the GEMV tolerable.

When you mix them in one batch, you compromise on both. Section 12 covers disaggregating them into separate GPU pools.

### Senior at FAANG: Tuning Batch Limits

The knobs you tune in production:

1. `max_batched_tokens`: the soft cap on `sum(prefill chunk sizes) + decode count` per iteration. Higher = better throughput, worse decode latency. Tune to your TPOT SLO.
2. `max_running`: cap on concurrent requests. Each request consumes blocks, so this caps memory.
3. `max_queue_size`: how many waiting requests to admit before rejecting. Fail fast under overload.
4. `chunk_prefill_size`: prefill chunk granularity.
5. `block_size`: KV block size. 16 is the standard in 2026, smaller wastes ref-count overhead, larger wastes memory at request boundaries.

In any inference cluster you should be running synthetic load tests every release, sweeping these knobs against your production traffic distribution, and picking the operating point on the Pareto frontier that maximizes throughput at the latency SLO.

The next section drops into prefill / decode disaggregation in detail.

---
