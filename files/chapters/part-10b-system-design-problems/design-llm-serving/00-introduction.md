# System Design: LLM Serving Infrastructure

> Serving a 70B parameter model to millions of users requires rethinking every assumption about request routing, caching, and resource allocation. Tokens are not HTTP responses.

LLM serving breaks nearly every assumption that traditional web infrastructure relies on. A typical REST API handles a request in 1-50ms, a single LLM inference request can occupy a GPU costing several dollars an hour for 10-60 seconds while generating tokens one at a time. Requests are stateful (each generated token depends on the KV cache of all preceding tokens), responses are variable-length streams rather than fixed-size JSON, and the bottleneck is GPU memory bandwidth rather than CPU or network I/O.

At 10 million requests per day processing a trillion tokens (and generating about 10 billion of them), the 70B tier alone requires roughly 625 A100 GPUs running continuously. The KV cache costs about 320KB per token on a 70B model, so a single request with a full 128K context consumes roughly 40GB of VRAM, the GPU pair that serves the model weights cannot hold even one full-length cache alongside them. GPU compute costs represent over 80% of total operating expense, which makes utilization optimization the single most important engineering problem.

The three hardest challenges are: (1) continuous batching, dynamically inserting new requests into in-flight generation batches to keep GPUs busy rather than waiting for static batches to fill, which yields 5-10x better utilization, (2) KV cache memory management using PagedAttention to eliminate GPU memory fragmentation and fit 2-4x more concurrent requests, and (3) auto-scaling GPU instances with a 5-7 minute cold start time, requiring predictive scaling that anticipates traffic spikes before they arrive.

This chapter walks through the full design:

- **Problem Statement** defines the requirements for a production inference platform.
- **Capacity Estimation** translates request volumes into GPU counts and memory budgets.
- **Architecture Overview** shows the layered design separating Go routing from Python/CUDA inference.
- **Core Components** implements the request router, continuous batching engine, prompt cache, and auto-scaler in Go.
- **GPU Memory Management** explains PagedAttention and how it solves KV cache fragmentation.
- **Database Schema** covers request logging, model registry, and user quotas.
- **Key Design Decisions** explains continuous batching, KV prefix sharing, speculative decoding, and priority queues.
- **Interview Follow-Ups** addresses cold start, 405B model serving, streaming reliability, and cost optimization.
- **Deep Dives** cover token-level rate limiting, GPU memory pools, speculative decoding, request routing by complexity, and billing.
- **Scaling Strategy, Failure Handling, and Cost Analysis** complete the production picture.
