## Architecture Overview

The ad system follows a pipeline architecture where a single HTTP request from a publisher triggers an auction, parallel bid collection, winner selection, and event logging, all within 100 milliseconds. The diagram below shows how the key components connect: the Ad Exchange receives requests from publishers, fans out bid requests to multiple Demand-Side Platforms (DSPs), selects a winner, and then feeds events into Kafka for downstream processing like billing and fraud detection. Understanding this flow is essential because every component must be optimized for latency, and any bottleneck in the pipeline breaks the 100ms SLA.

```
Publisher (Website/App)
        │  HTTP (< 100ms budget)
        ▼
┌─────────────────────────────────────────────────────┐
│               Ad Exchange (SSP side)                │
│ Auction Server: validates, calls DSPs, picks winner │
└────────────────────────┬────────────────────────────┘
                         │ Bid requests (OpenRTB protocol)
              ┌──────────┴──────────┐
              ▼                     ▼ (parallel)
         DSP 1..N              Ad Selection Engine
         (external bidders)    (own demand)
              │
              ▼
┌─────────────────────────────────────────────────────┐
│                  Ad Serving Layer                   │
│  - Creative retrieval                               │
│  - Impression tracking pixel                        │
└────────────────────────┬────────────────────────────┘
                         │
         ┌───────────────┴──────────────┐
         ▼                              ▼
Event Pipeline (Kafka)           Budget Service
(impression, click, conversion)  (pacing, spend tracking)
         │
         ▼
Reporting & Billing
(Spark batch jobs)
```

---
