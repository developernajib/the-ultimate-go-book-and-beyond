## Architecture Overview

The architecture follows a stateful server model where each document is owned by exactly one server at a time. This is the key insight: by routing all edits for a given document to the same server using consistent hashing, you avoid the need for distributed locking or consensus protocols. The WebSocket gateway accepts client connections and forwards them to the correct document server, which runs the OT engine in memory for low-latency conflict resolution. Persistent storage (operation log and document snapshots) ensures durability without slowing down the real-time editing path.

```
User Browser (Editor)
        │  WebSocket (bidirectional ops)
        ▼
┌─────────────────────────────┐
│   Collab Gateway            │   (routes to doc server by doc_id)
└──────────────┬──────────────┘
               │ consistent hash on doc_id
        ┌──────▼──────────┐
        │  Doc Server     │   (stateful, owns doc in memory)
        │  (OT engine)    │
        └────┬────────────┘
             │
     ┌───────┴──────────┐
     ▼                  ▼
Operation Log        Document Store
(Kafka/Cassandra)    (Spanner/CockroachDB)
                          │
                          ▼
                    Version History
                    (S3 snapshots)
```

---
