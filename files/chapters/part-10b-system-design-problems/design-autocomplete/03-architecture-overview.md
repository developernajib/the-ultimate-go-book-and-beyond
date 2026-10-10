## Architecture Overview

This diagram shows the high-level flow of the autocomplete system. User requests hit a horizontally scaled service layer backed by an in-memory trie for fast lookups and a Redis cluster for distributed caching. Behind the scenes, a query aggregator powered by Kafka and Flink continuously processes search events to keep term frequencies and trending data up to date.

```
User Browser / App
        │  HTTP/REST or WebSocket
        ▼
┌────────────────────────────────┐
│  Autocomplete Service          │
│  (in-memory trie + Redis)      │
│  Horizontally scaled           │
└──────────────┬─────────────────┘
               │
    ┌──────────┴──────────────┐
    ▼                         ▼
Redis Cluster              Query Aggregator
(top-K per prefix)         (Kafka → Flink)
                                │
                                ▼
                           Term Frequency Store
                           (PostgreSQL / Cassandra)
```

---
