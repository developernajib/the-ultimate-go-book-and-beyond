## Comprehensive Architecture Diagram

The following diagram shows the end-to-end request flow through the LLM serving architecture: from API consumers through the gateway and complexity router, into model pools with continuous batching and PagedAttention, and back out via the token streaming layer. Understanding the role of each layer and the latency implications at each stage is essential for reasoning through both normal operation and degraded states during peak traffic or hardware failure.

```
API Consumers (SaaS apps, developers)
                            │
    ┌───────────────────────▼───────────────────────┐
    │                  API Gateway                  │
    │  - API key authentication                     │
    │  - Token-level rate limiting (Redis)          │
    │  - Request validation (context length)        │
    │  - Model version routing                      │
    └───────────────────────┬───────────────────────┘
                            │
    ┌───────────────────────▼───────────────────────┐
    │               Complexity Router               │
    │  (classify: simple / medium / complex)        │
    └───────┬───────────────┬───────────────┬───────┘
            │               │               │
      ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
      │  7B Pool  │   │ 70B Pool  │   │ 405B Pool │
      │ (50 GPUs) │   │(625 GPUs) │   │(200 GPUs) │
      │45% traffic│   │50% traffic│   │5% traffic │
      └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
            │               │               │
    ┌───────▼───────────────▼───────────────▼───────┐
    │              GPU Workers (vLLM)               │
    │  ┌─────────────────────────────────────────┐  │
    │  │       Continuous Batching Scheduler     │  │
    │  │  - Prefill queue (new requests)         │  │
    │  │  - Decode batch (generating)            │  │
    │  │  - PagedAttention memory manager        │  │
    │  └─────────────────────────────────────────┘  │
    │  ┌─────────────────────────────────────────┐  │
    │  │       Prompt Cache (NVMe)               │  │
    │  │  - KV states for shared prefixes        │  │
    │  │  - 40% compute savings                  │  │
    │  └─────────────────────────────────────────┘  │
    └───────────────────────┬───────────────────────┘
                            │ Token stream
    ┌───────────────────────▼───────────────────────┐
    │             Token Streaming Layer             │
    │  - SSE (Server-Sent Events) to client         │
    │  - Token buffer (Redis) for reconnection      │
    │  - Billing meter (count tokens)               │
    └───────────────────────────────────────────────┘
```

---
