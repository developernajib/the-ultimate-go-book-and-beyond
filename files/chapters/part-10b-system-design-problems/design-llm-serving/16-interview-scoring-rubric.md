## Interview Scoring Rubric

This rubric shows what interviewers expect at each seniority level. An L4 (mid-level) candidate should demonstrate basic end-to-end understanding, while L5 and L6 candidates must show progressively deeper knowledge of GPU-specific optimizations and cost trade-offs. Use this as a self-assessment checklist: if you can explain everything in the L6 row, you have strong command of the topic.

### L4 (Junior/Mid)
- Model on GPU, REST API with SSE streaming, basic rate limiting, request queue
- Can explain that LLM requests are long-lived and require streaming responses
- **Missing at this level (expected):** continuous batching, KV cache management, GPU memory concerns

### L5 (Senior)
- Continuous batching with clear explanation of prefill vs decode phases and why dynamic slot filling is critical
- KV cache management: can calculate memory per request (~320KB/token on a 70B GQA model, so 128K context ≈ 40GB)
- Prompt caching with SHA-256 prefix matching for shared system prompts
- Token-level rate limiting (not request-level) because token count determines actual GPU cost
- Auto-scaling that accounts for 5-7 minute GPU startup times, requiring predictive scaling
- LLM-specific metrics: TTFT (time-to-first-token), TPOT (time-per-output-token), KV cache hit rate
- **Missing at this level (expected):** PagedAttention internals, speculative decoding, tensor parallelism details

### L6 (Staff)
- PagedAttention memory management: can explain virtual memory paging applied to GPU VRAM, elimination of KV cache fragmentation, 2-4x concurrency improvement
- Speculative decoding: draft model generates candidates, oracle verifies in parallel, acceptance/rejection mechanics
- Tensor parallelism (split attention heads across GPUs) + pipeline parallelism (split layers across nodes) for models exceeding single-GPU VRAM
- Multi-tenant fair queuing with weighted fair scheduling to prevent customer starvation
- Smart routing by complexity: classifier routes simple queries to 7B models, complex to 70B
- Quantization trade-offs: int8 vs int4, quality degradation vs memory savings, GPTQ vs AWQ
- Cost optimization strategies: spot instances for batch workloads, model distillation, prompt caching economics

---
