## Common Mistakes and How to Avoid Them

These are the most frequent pitfalls candidates encounter when designing LLM serving infrastructure. Each mistake stems from applying traditional web-serving assumptions to a fundamentally different workload. Understanding why each one is wrong will help you avoid them in both interviews and production systems.

1. **Treating like REST serving.** Traditional REST APIs hold a CPU for 1-50ms. LLM requests hold an $8/hour GPU for seconds to minutes, producing streaming output. Candidates who design a stateless load balancer with short timeouts will fail because connections are long-lived and GPU-aware scheduling is required. Request timeouts must accommodate full generation time (up to 60 seconds for long outputs), not just network RTT.

2. **Static batching.** Waiting for N requests before processing wastes GPU cycles every time the batch is not full. Continuous batching adds new requests to the decode batch as slots open, the GPU processes one decode step for all active sequences simultaneously, and new requests are inserted during that cycle. This yields 5-10x better GPU utilization. Candidates who propose static batching show they have not considered the cost implications.

3. **Ignoring KV cache memory.** A 128K context window on a 70B model requires roughly 40GB of GPU VRAM per request just for the KV cache (about 320KB per token). Naive allocation (one contiguous block per request) causes severe fragmentation because requests have different context lengths. PagedAttention solves this by dividing GPU VRAM into fixed-size pages and allocating KV cache one page at a time, just like virtual memory paging in an operating system.

4. **No prompt caching.** Many API consumers share identical system prompts (the same instructions repeated on every request). Without prefix caching, the system recomputes the KV state for these identical prefixes on every request, wasting 30-50% of GPU compute. Caching the precomputed KV state and loading it from NVMe (12ms for 400MB) is dramatically cheaper than recomputing it on the GPU.

5. **Request-level rate limiting.** A request with 1K tokens and a request with 100K tokens consume vastly different GPU resources, the same "1 request" may cost 100x more to serve. Rate limiting must be token-based, not request-based, counting prompt + completion tokens against a per-tenant quota enforced atomically in Redis.

6. **No model routing.** Routing every request to the largest model (70B) wastes GPU resources on simple queries that a 7B model handles equally well. A lightweight classifier (trained on prompt complexity features) can route half or more of production traffic to the smaller model (this design assumes 50%), cutting the GPU fleet from 1,250 to under 700 A100s with minimal quality impact.

---
