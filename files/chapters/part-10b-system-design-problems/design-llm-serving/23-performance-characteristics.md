## Performance Characteristics

Understanding these numbers is essential for capacity planning and setting realistic SLAs. The key takeaway is that batching transforms LLM economics: a single request on a 70B model takes about 30 seconds to generate 1K tokens, and batching 32 requests together barely changes that per-request latency (40ms per token instead of 30ms) while the worker now completes 32 requests in the same window. Throughput per worker rises 24x, which cuts the effective GPU time billed to each request from 30 seconds to about 1.3 seconds. The cost analysis shows that at $5 per million output tokens (a common market rate), the infrastructure achieves roughly 44% gross margin on A100 on-demand pricing.

```
Inference Latency (70B model, 2x A100):
  - TTFT (prefill, 1K prompt tokens): 200ms
  - TTFT (prefill, 32K prompt tokens): 2.5s
  - TTFT (with prompt cache hit): 50ms
  - TPOT (decode, batch=1): 30ms/token
  - TPOT (decode, batch=32): 40ms/token (batching overhead)
  - 1K output tokens: 200ms + 30s = ~30.2s (batch=1)
  - 1K output tokens: 200ms + 40s = ~40.2s (batch=32, but 32 requests
    finish in that window → ~1.3s of GPU time per request)

Throughput:
  - Per 2xA100 worker (70B): 800 tokens/sec at batch=32
  - Per A100 worker (7B): 3000 tokens/sec at batch=64
  - 625 GPUs for 70B: 312 workers x 800 = 250K tokens/sec
  - Effective requests/sec (avg 1K output): ~250 req/sec

Cost:
  - A100 80GB: ~$2/hour (spot), ~$4/hour (on-demand)
  - 70B inference cost: 625 x $4 = $2,500/hour
  - Per 1M output tokens: $2,500 / (250K * 3600 / 1M) = ~$2.78/1M tokens
  - Margin at $5/1M tokens: ~44% gross margin

Memory:
  - 70B model weights (fp16): 140GB across 2x A100
  - KV cache: ~320KB/token → 4K ctx ≈ 1.3GB, 128K ctx ≈ 40GB
  - With PagedAttention: fit 8-16 concurrent 4K-context requests per worker
  - Prompt cache on NVMe: 1TB, holds ~2500 cached prompt KV states (~400MB each, ≈1,200-token prompts)
```


---
