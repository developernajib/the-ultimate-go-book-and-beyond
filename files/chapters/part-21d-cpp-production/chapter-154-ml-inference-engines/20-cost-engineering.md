## Cost Engineering

Inference cost is the math that decides whether your product survives. A single H100 costs \$25,000 to buy or \$2 to \$5 / hour to rent. A 70B-parameter model serving 100 RPS at 200 output tokens per request needs roughly 8 H100s per replica. The dollars per million tokens is the number that determines pricing, gross margin, and which workloads close as customers.

This section walks the math from GPU pricing to \$/1k tokens, then through the knobs that move the cost.

### The Hardware Pricing Reality (2026)

Cloud rental prices, mid-2026:

| GPU | VRAM | Hourly (on-demand, top tier) | Hourly (reserved 3yr) |
|-----|------|------------------------------|------------------------|
| H100 80GB SXM | 80 GB | \$4.50 | \$1.80 |
| H200 141GB | 141 GB | \$6.00 | \$2.50 |
| B200 192GB | 192 GB | \$8.50 | \$3.80 |
| MI300X 192GB | 192 GB | \$5.00 | \$2.20 |
| L40S | 48 GB | \$1.40 | \$0.65 |
| GH200 (Grace + H200) | 480 GB unified | \$7.50 | \$3.20 |

Owning the hardware (capex) gets you to about \$0.50 to \$1 / GPU-hour fully loaded (depreciation, power, cooling, rack, networking). Hyperscalers run at this number internally and rent at the on-demand price.

### Throughput Math

Per-GPU throughput depends on model size, batch size, context length, and quantization. Llama 3 70B on H100 NVL TP=8 (so 1 replica = 8 GPUs):

| Setup | Tokens/s (replica) | Tokens/s (per GPU) |
|-------|-------------------|---------------------|
| FP16, batch 32, 4k context | ~1100 | 138 |
| FP8 weights, batch 64, 4k | ~2200 | 275 |
| FP8 weights, FP8 KV, batch 128, 4k | ~3500 | 438 |
| MXFP4 weights (B200), batch 256 | ~7500 | 938 |

Now \$/1M tokens at on-demand H100 (\$4.50/h, FP8 W+KV):

```
GPU-hours per 1M tokens = 1_000_000 / (438 tok/s * 3600 s/h * 8 GPUs)
                        = 1_000_000 / 12_614_400
                        = 0.0793 GPU-hours
$/1M tokens             = 0.0793 * $4.50 * 8 GPUs
                        = $2.85
```

At reserved pricing (\$1.80/h):

```
$/1M tokens = 0.0793 * $1.80 * 8 = $1.14
```

Move to MXFP4 on B200:

```
GPU-hours per 1M tokens = 1_000_000 / (938 * 3600 * 8) = 0.037
$/1M tokens (B200 reserved $3.80) = 0.037 * $3.80 * 8 = $1.13
```

The B200 hits the same \$/M as H100 reserved at FP8 because B200 hourly is higher but throughput is also higher. The win is when you do not have reserved capacity, or for new deployments where MXFP4 is the only path that fits the model on a given GPU count.

### TTFT Cost (Prefill)

Prefill is compute-bound. A 4096-token prompt on Llama 3 70B TP=8 H100 takes ~250 ms (rough). That is 2 GPU-seconds of compute per prefill, regardless of subsequent output length.

At 100 prefills/sec with 4k prompts, prefill alone consumes 2 H100s of capacity *per second*. For a 200-output-token average response, prefill is ~50% of total compute.

Reducing prefill cost: prefix caching (system prompts cached, only the user-specific tail is computed), chunked prefill (interleave with decode for higher throughput).

### Knobs That Move Cost

Ranked by typical impact in production:

**1. Quantization.** FP16 -> FP8 (weights + KV) is roughly 2x cost reduction. FP8 -> MXFP4 weights is another 1.5-2x. INT4 W4A16 is 1.5x compared to FP16.

**2. Batch size.** Going from batch 8 to batch 128 doubles to triples throughput. Limited by KV cache fit and SLOs.

**3. Continuous batching.** vs static / dynamic batching, 3-5x throughput improvement on variable-length workloads.

**4. Prefix caching.** For chat with system prompts, 30-70% prefill reduction.

**5. Speculative decoding.** 1.5-3x decode throughput when acceptance is good. Off when batch is already large.

**6. Tensor parallel within node.** Lets you fit bigger models, often slightly increases per-token cost (the all-reduces). Use TP only when needed.

**7. CUDA Graphs.** 5-15% throughput on decode by killing kernel launch overhead.

**8. Disaggregated prefill / decode.** 1.2-2x effective throughput by running each phase on its best-fit pool.

**9. Hardware tier.** H100 -> H200 for memory-bound workloads is a real win because of more HBM. B200 is faster than H100 per dollar at MXFP4.

**10. Kernel fusion.** Fused MLP, fused RoPE, fused attention all add 5-20% per kernel saved.

A baseline FP16 vLLM deployment going to a tuned FP8 + prefix caching + speculative decoding deployment moves \$/M tokens from \$5 to \$1. That is the prize.

### Idle Cost

GPUs cost the same whether they are saturated or idle. A serving fleet running at 30% average use is two-thirds wasted. The countermeasures:

1. **Autoscaling.** Spin replicas up and down based on load. Hard for stateful workloads (KV cache must drain) but doable with graceful drain.

2. **Multi-tenant.** Run multiple models on one cluster, route by demand. A small model fills the cracks left by a big model.

3. **Shadow batch jobs.** Off-peak, run batch inference workloads (embeddings, summarization) on the underused GPUs. Shadow at 95% use off-peak.

4. **Spot capacity.** Take spot GPUs for batch work. Cheaper but preemptible.

5. **Lower priority traffic.** Free-tier or async traffic at a lower SLO fills the off-peak.

### Throughput / Latency / Cost Tradeoff

You are picking an operating point on a 3D surface. Push throughput up by raising batch size or output length: latency goes up, cost / token goes down. Lower latency by lowering batch size: cost / token goes up. Quantize: both improve (free lunch within the accuracy budget).

A premium consumer chat product: TTFT p95 <300 ms, TPOT p99 <30 ms, accept higher \$/token. A batch summarization product: tolerate seconds per request, push batch to 256, \$/token at the floor.

The right operating point is the *cheapest* one that meets the SLO. Optimizing past the SLO is wasted engineer-effort.

### Cost Modeling in C++

A simple cost monitor in your engine:

```cpp
class CostMeter {
public:
    void record_completion(uint64_t input_tokens, uint64_t output_tokens,
                           double ttft_ms, double tpot_ms,
                           int gpus_used) {
        // Approximate duration: TTFT + (output - 1) * TPOT
        double duration_s = (ttft_ms + (output_tokens - 1) * tpot_ms) / 1000.0;
        double gpu_seconds = duration_s * gpus_used;
        gpu_seconds_total_.fetch_add(static_cast<uint64_t>(gpu_seconds * 1e6));
        input_tokens_total_.fetch_add(input_tokens);
        output_tokens_total_.fetch_add(output_tokens);
    }

    // Periodic export (gpu_hourly_cost_cents: e.g. 450 for $4.50/h)
    void export_metrics(uint64_t gpu_hourly_cost_cents) {
        uint64_t gpu_us = gpu_seconds_total_.load();
        uint64_t out = output_tokens_total_.load();
        if (out == 0) return;
        // Compute cost in microcents (1/10,000 cent) to avoid floating-point drift
        uint64_t cost_microcents = (gpu_us / 1000) * gpu_hourly_cost_cents / 3600;
        double gauge_value = static_cast<double>(cost_microcents) * 1e6 / (out * 10000.0);
        publish_gauge("inference.cost.cents_per_million_output_tokens",
                      gauge_value);
    }

private:
    std::atomic<uint64_t> gpu_seconds_total_{0};
    std::atomic<uint64_t> input_tokens_total_{0};
    std::atomic<uint64_t> output_tokens_total_{0};
};
```

This is approximate (does not account for shared batch costs precisely) but gives you an actionable \$/M tokens dashboard updated in real time.

### Senior at FAANG: The Cost Negotiation

When you propose a new model deployment, the cost question is unavoidable. The conversation:

1. What is the expected RPS? The output length distribution? The TTFT and TPOT SLOs?
2. What is the cheapest hardware tier that meets the SLO?
3. What is the cost per request and per user? Is there a margin?
4. What knobs (quant, batch, speculative, caching) are on the table?
5. What is the rollback plan if accuracy drops?

A senior engineer comes to that meeting with a Pareto frontier curve from a load test, three quantization variants, and a clear recommendation. A junior engineer comes with one number and gets sent back. Be the senior.

The next section looks at the frontiers being explored in 2026.

---
