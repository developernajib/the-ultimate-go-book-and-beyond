## Capacity Estimation

Before designing any component, you need to understand the scale of the problem. Capacity estimation for LLM serving differs fundamentally from traditional web services because GPU memory and compute throughput are the bottleneck, not CPU or network bandwidth. The numbers below translate the high-level requirements into concrete hardware needs, helping you determine how many GPUs to provision and how much memory each request consumes.

```
Requests/day:       10M → 115/sec avg, 500/sec peak
Tokens/request:     100K context + 1K output = ~101K tokens
Total tokens/day:   10M × 101K = 1 trillion tokens/day
GPU memory (70B):   70B params × 2 bytes (fp16) = 140GB → 2× A100 80GB
Throughput per GPU: 70B model on 2×A100: ~50 tokens/sec at batch=1
                    With batching (batch=32): ~800 tokens/sec
GPUs needed:        naive: 500 req/sec ÷ 0.8 req/sec per 2×A100 worker = 1,250 GPUs
                    with ~50% routed to a 7B tier → ~312 workers = 625 A100s
KV cache:           ~320KB/token (2 × 80 layers × 8 KV heads × 128 dim, fp16)
                    → 128K ctx ≈ 40GB/request
Prompt caching:     Shared system prompts → cache KV across requests
```

The GPU count estimate (625 A100s for the 70B tier) assumes two things working together: complexity routing that sends roughly half of all requests to a cheap 7B tier, and continuous batching at batch size 32, which yields roughly 800 output tokens per second per 2-GPU worker. Without batching (batch=1), throughput drops to 50 tokens/sec and the fleet grows 16x. This is why continuous batching is the single most important optimization in the entire system. At $4/hour on-demand per A100, the batched 625-GPU fleet costs about $1.8M per month, unbatched serving of the same load would run toward $30M.

The KV cache calculation deserves close attention because it determines how many concurrent requests fit in GPU memory. For a 70B model with 80 layers and 8 grouped-query KV heads of dimension 128, the cache costs about 320KB per token in fp16, so a full 128K context consumes roughly 40GB for a single request, half an A100. The 2×A100 pair that serves the fp16 weights (140GB) has only about 20GB left after activations, not enough for even one full-length request, which is why long-context replicas span more GPUs and why PagedAttention plus KV cache quantization or offloading are critical. Shorter contexts change the picture completely: a 4K-token request needs about 1.3GB, so a pair sustains a batch of a dozen mid-length requests. With 4-bit weight quantization the model fits on a single GPU, freeing 40+ GB for KV cache and enabling 100+ concurrent short-context requests.

Prompt caching targets the observation that many API consumers share identical system prompts. If 40% of requests share a common prefix, caching those KV computations saves roughly 400 billion tokens worth of redundant GPU work per day.

---
