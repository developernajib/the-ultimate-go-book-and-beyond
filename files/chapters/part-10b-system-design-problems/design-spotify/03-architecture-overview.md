## Architecture Overview

The high-level architecture separates concerns into three main paths: audio streaming (the hot path that serves actual music), catalog and search (how users find content), and the recommendation pipeline (how the system learns what users enjoy). The API Gateway acts as the single entry point for all client requests, handling authentication and rate limiting before routing to the appropriate backend service. Notice that actual audio data flows through the CDN, not through your application servers. That split is what lets a modest fleet of API nodes handle millions of concurrent streams.

```
Client (iOS/Android/Web/Desktop)
         │  HTTP/HTTPS
         ▼
┌─────────────────────────────────────────┐
│            API Gateway                  │
└───────┬────────────────┬────────────────┘
        │                │
 ┌──────▼──────┐   ┌─────▼──────┐
 │  Streaming  │   │  Catalog   │
 │  Service    │   │  Service   │
 │  (CDN URLs) │   │ (Elastic)  │
 └──────┬──────┘   └────────────┘
        │
  ┌─────▼───────────────────────────┐
  │           CDN Edge Nodes        │
  │   (Cloudflare / Akamai)         │
  └─────────────────────────────────┘

Recommendation Pipeline (Spark):
  Play events → Feature engineering → ALS matrix factorization → User/track vectors
```

---
