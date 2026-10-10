## Architecture Overview

The architecture separates concerns into distinct layers: an API gateway for authentication and rate limiting, a request router that selects the right model and checks caches, and a GPU-backed inference cluster that performs the actual token generation. This layered design allows the Go service layer to handle routing, caching, and billing while the Python-based inference engine (vLLM or TGI) manages GPU-optimized model execution. The async pipeline ensures that clients receive tokens as they are generated, rather than waiting for the entire response to complete.

```
Client (API consumer)
         │  HTTPS streaming (SSE / WebSocket)
         ▼
┌────────────────────────────────────────────────────────┐
│              API Gateway                               │
│  (auth, rate limiting, routing, model versioning)      │
└──────────────────────┬─────────────────────────────────┘
                       │
    ┌──────────────────▼──────────────────────────┐
    │           Request Router                    │
    │  (model selection, queue, prompt cache)     │
    └──────────────┬──────────────────────────────┘
                   │
      ┌────────────┴─────────────────┐
      ▼                              ▼
Model Serving Cluster          Prompt Cache
(vLLM / TGI workers)           (Redis / disk KV cache)
GPU-optimized inference
      │
      ▼
Token Stream → SSE response

Async pipeline:
  Request → Queue → Model Worker → Token Stream → Client
  (with request priority, context management, batching)
```

---
