## High-Level Architecture

The architecture splits Twitter into three main services: one for writing tweets, one for building and reading timelines, and one for search. A Kafka-based fan-out service sits between the tweet writer and the timeline cache, distributing new tweets to followers asynchronously. This separation lets each service scale independently based on its own traffic pattern, tweet writes are bursty, timeline reads are constant, and search indexing can tolerate a few seconds of lag.

```
                    ┌─────────────────────────────┐
   Clients ────────►│ API Gateway + Load Balancer │
                    └──────────────┬──────────────┘
                                   │
           ┌───────────────────────┼───────────────────────┐
           │                       │                       │
           ▼                       ▼                       ▼
 ┌───────────────────┐   ┌───────────────────┐   ┌───────────────────┐
 │   Tweet Service   │   │ Timeline Service  │   │  Search Service   │
 │    Post / Read    │   │ Build / Read Feed │   │ Full-Text Search  │
 └─────────┬─────────┘   └─────────┬─────────┘   └─────────┬─────────┘
           │                       │                       │
           │             ┌─────────┴─────────┐             │
           │             │  Fan-Out Service  │             │
           │             │  (Kafka workers)  │             │
           │             └─────────┬─────────┘             │
           │                       │                       │
 ┌─────────▼─────────┐   ┌─────────▼─────────┐   ┌─────────▼─────────┐
 │     Tweet DB      │   │    Redis Cache    │   │   Elasticsearch   │
 │ (MySQL / sharded) │   │ (Timelines/Trends)│   │(Tweet idx, 7d hot)│
 └───────────────────┘   └───────────────────┘   └───────────────────┘
```

---
