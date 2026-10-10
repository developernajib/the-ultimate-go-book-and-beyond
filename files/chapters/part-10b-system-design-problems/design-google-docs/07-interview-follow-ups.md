## Interview Follow-Ups

**Q: How does the transform function ensure convergence?**

OT requires: `apply(apply(S, A), transform(B, A)) == apply(apply(S, B), transform(A, B))`. This property (called CP1/TP1) ensures both parties reach the same final state regardless of operation order. The transform function handles all combinations: insert vs insert, insert vs delete, delete vs delete.

**Q: How do you handle a document server crash?**

1. All applied operations are persisted to the operation log (Kafka/Cassandra) before acknowledgment.
2. Consistent hashing routes doc to a new server.
3. New server loads latest snapshot + replays ops from log to reconstruct state.
4. Clients reconnect and receive the ops they missed.
Target recovery time: < 5 seconds.

**Q: How does Google handle 50 simultaneous editors?**

Each edit is a small delta (typically 1-10 characters). The OT engine serializes operations in order. With 50 editors at 3 ops/sec each, that is 150 ops/sec per document, trivially fast for one server. The bottleneck is network fan-out: broadcasting each op to 49 other clients.

---
