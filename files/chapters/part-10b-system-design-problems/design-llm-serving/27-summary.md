## Summary

The following table maps each component in the LLM serving infrastructure to its technology choice and purpose. Notice how the system cleanly separates the Go service layer (routing, caching, billing, rate limiting) from the Python/CUDA inference backend (GPU-optimized model execution). This separation lets each layer scale independently and use the best-suited language for the job.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Request routing | Go HTTP + gRPC | API gateway and model routing |
| Inference backend | vLLM / TGI (Python+CUDA) | GPU-optimized LLM serving |
| Continuous batching | PagedAttention scheduler | Maximize GPU utilization |
| Prompt cache | Redis + NVMe disk | Avoid redundant KV computation |
| Token streaming | SSE (Server-Sent Events) | Real-time token delivery |
| Queue management | Redis priority queues | Fair scheduling |
| Auto-scaling | Cloud GPU instances | Handle bursty demand |
| Billing | Token counting + PostgreSQL | Per-token usage tracking |
| Rate limiting | Redis fixed-window token counter | User quota enforcement |


---
