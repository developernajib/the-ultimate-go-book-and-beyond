## Scaling Strategy

Scaling a collaborative editor requires different strategies for different components because each has a unique access pattern. The gateway layer is stateless and scales horizontally behind a load balancer. Document servers are stateful but partitioned by document ID, so adding more servers increases the number of documents you can handle simultaneously. The operation log must handle extremely high write throughput, making partitioning by `doc_id` essential for distributing the load evenly.

| Component | Scaling Strategy | Target |
|-----------|-----------------|--------|
| Collab Gateway | Stateless WS proxies | ~2.5M concurrent connections |
| Doc Servers | Consistent hash ring | 200K live docs at peak |
| Operation Log | Partitioned by doc_id | ~2M ops/sec peak |
| Document Store | PostgreSQL + S3 | 1B documents |
| Version History | S3 snapshots | Unlimited |
| Redis (permissions) | Redis Cluster | Sub-ms checks |

The single-owner-per-document model is the key architectural constraint that makes this scaling approach work. Because each document's OT engine runs on exactly one server, there is no need for distributed locking, consensus protocols, or cross-server coordination for real-time edits. The consistent hash ring determines ownership, and when a server fails, the ring redistributes its documents to surviving servers, each of which rebuilds state from the snapshot + operation log. The operation log is the highest-throughput component at roughly 2M ops/sec peak, partitioning it by `doc_id` ensures that writes for a single document are sequential (required for OT correctness) while distributing the aggregate load across many partitions.

---
