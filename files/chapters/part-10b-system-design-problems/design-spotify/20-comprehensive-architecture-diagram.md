## Comprehensive Architecture Diagram

This diagram shows how all the components fit together end-to-end, from client devices through the API layer to backend services and the background data pipeline. Pay special attention to the separation between the real-time serving path (top half) and the batch processing pipeline (bottom half). The serving path must be fast and highly available, while the batch pipeline prioritizes throughput and correctness for tasks like recommendation model training and royalty calculation.

```
┌──────────────────────────────────────────────────────────────┐
│                        Client Devices                        │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────────┐  ┌──────────┐    │
│  │ iOS  │  │Droid │  │ Web  │  │ Desktop  │  │  Smart   │    │
│  │ App  │  │ App  │  │Player│  │   App    │  │ Speaker  │    │
│  └──┬───┘  └──┬───┘  └──┬───┘  └────┬─────┘  └────┬─────┘    │
└─────┼─────────┼─────────┼───────────┼─────────────┼──────────┘
      │         │         │           │             │
      └─────────┴─────────┴─────┬─────┴─────────────┘
                                │ HTTPS
                     ┌──────────▼──────────┐
                     │     API Gateway     │
                     │ (auth, rate limit)  │
                     └──────────┬──────────┘
                                │
     ┌──────────────────────────┼─────────────────────────┐
     ▼                          ▼                         ▼
┌─────────────┐      ┌─────────────────┐      ┌────────────────┐
│  Streaming  │      │     Catalog     │      │ Recommendation │
│   Service   │      │     Service     │      │    Service     │
│ (CDN URLs)  │      │ (Elasticsearch) │      │ (User vectors) │
└──────┬──────┘      └─────────────────┘      └───────┬────────┘
       │                                              │
  ┌────▼────────┐                              ┌──────▼───────┐
  │     CDN     │                              │    Redis     │
  │   (audio    │                              │  (vectors,   │
  │  segments)  │                              │    state,    │
  └─────────────┘                              │   activity)  │
                                               └──────────────┘
┌──────────────────────────────────────────────────────────────┐
│                     Background Pipeline                      │
│                                                              │
│  Play Events ──► Kafka ──► Spark ──► Feature Store           │
│                    │                     │                   │
│                    ├──► Royalty Calc     ├──► ALS Model      │
│                    ├──► Analytics        └──► User Vecs      │
│                    │    (ClickHouse)                         │
│                    └──► Real-time Recs                       │
└──────────────────────────────────────────────────────────────┘
```

---
