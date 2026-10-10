## System Architecture

Before writing any code, it is important to understand how all the pieces of GoCache fit together. The system follows a sharded architecture where each node owns a portion of the key space, determined by consistent hashing. Clients connect over TCP using the RESP protocol, and each master node can have one or more replicas for fault tolerance. A sentinel process monitors node health and triggers failover when a master becomes unreachable.

### High-Level Design

```
┌─────────────────────────────────────────────────────────┐
│                        Clients                          │
│           (Go Client, Redis CLI, any RESP client)       │
└───────────────────┬─────────────────────────────────────┘
                    │ RESP Protocol (TCP)
                    │
    ┌───────────────┼───────────────┐
    │               │               │
┌───▼────┐    ┌────▼────┐    ┌────▼────┐
│ Node 1 │    │ Node 2  │    │ Node 3  │
│ (Shard)│    │ (Shard) │    │ (Shard) │
│ Master │    │ Master  │    │ Master  │
└───┬────┘    └────┬────┘    └────┬────┘
    │              │              │
    │ Replicate    │ Replicate    │ Replicate
    │              │              │
┌───▼────┐    ┌────▼────┐    ┌────▼────┐
│Replica │    │Replica  │    │Replica  │
│   1    │    │   2     │    │   3     │
└────────┘    └─────────┘    └─────────┘

         ┌────────────────┐
         │  Sentinel      │
         │  (Health Check)│
         └────────────────┘
```

### Component Breakdown

1. **RESP Server**: TCP server handling RESP protocol
2. **Key-Value Store**: Thread-safe in-memory storage with LRU
3. **Consistent Hash Ring**: Distributes keys across nodes
4. **Replication Manager**: Async master-replica replication
5. **Expiration Manager**: Background goroutine for TTL cleanup
6. **Client Library**: Connection pooling, retries, failover
7. **Cluster Coordinator**: Node discovery and health checks

---

### Junior → FAANG: Architecture Components as Interview Vocabulary

The seven components of GoCache's architecture each have a distinct responsibility and a distinct failure mode. For an interview, being able to name each component, state its responsibility, and describe its failure mode shows genuine architecture thinking.

The sentinel process (cluster coordinator) is the most interesting component for interview discussion: it is the source of truth for cluster membership. When a master node fails, the sentinel elects a new leader from the replicas. This is the distributed consensus problem, simplified. Know that sentinel requires a quorum (majority of sentinel instances must agree) to avoid split-brain scenarios where two sentinels simultaneously elect different leaders.

The client library with connection pooling and failover is the client-side complement to server-side fault tolerance. A client that pools connections reduces per-request connection setup overhead. A client that implements failover (automatically routing to a replica when the primary is unavailable) shields application code from transient server failures. This separation of concern (server provides replicas, client provides failover logic) is a key distributed systems pattern.

### Senior @ FAANG: Architecture as a Failure Domain Analysis

At senior level, the architecture diagram should be analyzed as a failure domain map. Each component is a potential failure point. The question is: when this component fails, what is the impact on the rest of the system?

RESP server failure: clients lose their connections. If the client implements retry with connection failover, impact is limited to in-flight requests. If not, the client fails until the server recovers or the client reconnects to a replica. This makes client-side retry logic a correctness requirement, not an optimization.

Consistent hashing failure (incorrect ring state after partial topology change): keys route to the wrong shard. This is the hardest failure to detect because it is silent: the request succeeds but returns the wrong data. The mitigation is atomic ring updates (all nodes must see the new ring state before any request is routed using it), which requires a distributed coordination primitive (ZooKeeper, etcd).

Sentinel quorum failure (more than half of sentinels unavailable simultaneously): the cluster cannot elect a new leader. This means a master failure becomes a full availability outage rather than a brief failover window. The operational mitigation is deploying sentinels across multiple availability zones, ensuring no single zone failure can eliminate quorum.

---
