## Architecture Overview

The following diagram illustrates the dual-layer architecture of NATS: the core pub/sub plane that provides at-most-once delivery with microsecond latency, and the JetStream persistence layer that adds durable streams, consumer groups, and key-value storage on top. Understanding which layer a given use case belongs to prevents over-engineering simple notification pipelines with unnecessary persistence overhead.

```
NATS JetStream Architecture
═══════════════════════════
┌──────────────────────────────────────────────────────────────────┐
│                        NATS Server Cluster                       │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐                    │
│  │ Server 1 │◄──►│ Server 2 │◄──►│ Server 3 │  (Raft consensus)  │
│  │ JetStream│    │ JetStream│    │ JetStream│                    │
│  └────┬─────┘    └──────────┘    └──────────┘                    │
│       │                                                          │
│  ┌────▼──────────────────────────────────────┐                   │
│  │              Stream: ORDERS                │                  │
│  │  Subject: orders.>                         │                  │
│  │  Retention: WorkQueue | Storage: File      │                  │
│  │  Seq: [1][2][3][4][5][6][7]...            │                   │
│  └────┬──────────────────────────────────────┘                   │
│       │                                                          │
│  ┌────▼────────────┐  ┌───────────────────┐                      │
│  │ Pull Consumer   │  │  Push Consumer    │                      │
│  │ "order-proc"    │  │  "order-notify"   │                      │
│  │ Fetch(10, ...)  │  │  DeliverSubject   │                      │
│  └─────────────────┘  └───────────────────┘                      │
└──────────────────────────────────────────────────────────────────┘

Redis Streams Architecture
══════════════════════════
┌──────────────────────────────────────────────────────────────────┐
│                     Redis (Standalone/Cluster)                   │
│                                                                  │
│  Stream Key: "events:orders"                                     │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ ID              │ Fields                                 │    │
│  │ 1699000000001-0 │ type=created, amount_cents=9999        │    │
│  │ 1699000000002-0 │ type=updated, status=paid              │    │
│  │ 1699000000003-0 │ type=shipped, tracking=ABC123          │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Consumer Group: "billing-service"                               │
│  ├── Consumer "worker-1"  → PEL: [1699000000001-0]               │
│  └── Consumer "worker-2"  → PEL: [1699000000002-0]               │
│                                                                  │
│  Consumer Group: "shipping-service"                              │
│  ├── Consumer "worker-1"  → PEL: []                              │
│  └── Consumer "worker-2"  → PEL: [1699000000003-0]               │
└──────────────────────────────────────────────────────────────────┘

NATS Core vs JetStream
══════════════════════
  NATS Core (at-most-once)          JetStream (at-least-once / exactly-once)
  ─────────────────────             ────────────────────────────────────────
  Publisher ──► Subject             Publisher ──► Subject ──► Stream (disk)
  Subscriber misses? Lost.          Consumer offline? Replayed on reconnect.
  Sub-millisecond latency           ~1-5ms latency (disk I/O)
  No state, no persistence          Raft-replicated, survives cluster restart
```

### Junior -> FAANG: Reading Architecture Diagrams Before Writing Code

Architecture diagrams like the ones above are designed to answer two questions: where does data live, and who owns it? Practice reading each diagram by tracing a single message from publisher to final acknowledgment, naming every component it passes through and the protocol used at each hop.

For the NATS JetStream diagram, trace: publisher calls `js.Publish` on Server 1, message is written to the ORDERS stream, Raft replicates to Server 2 and Server 3, quorum is reached, `PubAck` returns to the publisher. Now trace the same message to the pull consumer: consumer calls `Fetch`, server marks message in-flight, consumer processes and calls `Ack`, server removes from consumer's outstanding list.

For the Redis Streams diagram, trace: producer calls `XADD events:orders`, entry lands in the stream with an auto-generated ID, consumer in the `billing-service` group calls `XREADGROUP`, message enters that consumer's PEL, processing succeeds, `XACK` removes it from the PEL.

If any step in either trace is unclear, that is the part of the chapter to read most carefully. The diagrams are a prerequisite check, not decoration.

### Senior @ FAANG: Evaluating the Architecture at Failure Boundaries

The diagrams show steady-state operation. Staff-level engineers evaluate architectures by examining what happens at each component boundary when it fails.

For NATS JetStream, the critical failure boundaries are: what happens when the stream leader fails during a write (the publisher gets a timeout or connection error and must retry, making idempotency via `Nats-Msg-Id` mandatory for correct exactly-once behavior), what happens when a pull consumer crashes between `Fetch` and `Ack` (the server's AckWait timer expires and redelivers, making consumer-side idempotency necessary), and what happens when an entire AZ fails in a 2+1 node layout across two AZs (the surviving AZ has only one node, which is below Raft quorum for a 3-replica stream, so the stream loses write availability until the failed AZ recovers or the cluster is reconfigured).

For Redis Streams, the critical failure boundaries are: what happens when a consumer crashes between `XREADGROUP` and `XACK` (messages stay in PEL indefinitely until `XAUTOCLAIM` reclaims them, with no automatic timeout), what happens when the Redis primary fails in standalone mode (any unwritten write is lost unless AOF `always` sync is configured, and even then there is a replication lag window), and what happens when the stream grows faster than `MAXLEN` trimming can keep up with (the oldest unacknowledged messages in a slow group's PEL reference entries that no longer exist in the stream, making redelivery impossible and silent data loss certain).

The architecture diagram for a mature platform should annotate each boundary with its failure mode and the code-level mitigation. That annotation is what separates an architecture diagram used in an ADR from one used as a slideware illustration.

---
