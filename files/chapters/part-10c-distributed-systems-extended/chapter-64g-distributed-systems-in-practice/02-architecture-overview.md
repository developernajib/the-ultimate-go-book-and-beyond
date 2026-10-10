## Architecture Overview

The following diagram provides a system-level view of the distributed system reference architecture used throughout this chapter, showing the relationships between service mesh, consensus store, observability pipeline, and client-facing load balancer. This structural context makes the failure scenarios and anti-patterns discussed in later sections easier to reason about concretely.

```
┌──────────────────────────────────────────────────────────────────────────┐
│              Distributed Systems Decision Map                            │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │                    CAP Triangle                                 │     │
│  │                                                                 │     │
│  │              Consistency                                        │     │
│  │                  /\                                             │     │
│  │                 /  \                                            │     │
│  │                / CP \  etcd, ZooKeeper, CockroachDB             │     │
│  │               /------\                                          │     │
│  │              / CA  AP \                                         │     │
│  │             /  (rare)  \  Cassandra, DynamoDB, CouchDB          │     │
│  │            /____________\                                       │     │
│  │       Availability    Partition Tolerance                       │     │
│  │                                                                 │     │
│  │  P always happens → choose: C or A, not both                    │     │
│  └─────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │                  Production Incident Patterns                   │     │
│  │                                                                 │     │
│  │  Cascading Failure: A→B→C→D → all queues fill → total outage    │     │
│  │  Thundering Herd: cache miss → all N replicas hit DB at once    │     │
│  │  Split Brain: leader A and leader B both accept writes          │     │
│  │  Clock Skew: event B appears before A in logs, causality wrong  │     │
│  └─────────────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading Architecture Diagrams in Interviews

System design interviews frequently start with a blank whiteboard and "design a distributed key-value store" or a similar open-ended prompt. Candidates who have internalized the structure shown in this diagram move faster because they have a checklist: where is the consensus store, how does the service mesh enforce timeouts, where does the observability pipeline attach, and what does the load balancer do during a partition?

When drawing your own architecture in an interview, use this decision map as a skeleton. Explicitly label each component with its CAP choice. If you draw a caching layer, state whether it is CP or AP and what happens when the cache is unavailable. Interviewers at FAANG reward candidates who surface trade-offs proactively rather than waiting to be asked.

A first-job habit worth building: for every new service you read about internally, draw this diagram for it. Identify the CP and AP components, the synchronous chains, and the places where backpressure is or is not implemented. Doing this for five or ten internal services builds the pattern recognition that makes system design interviews feel natural.

### Senior @ FAANG: Architecture Review as Governance Practice

At L6 and above, the architecture overview diagram is not a deliverable: it is the opening artifact of a governance process. The diagram makes the structure auditable. An architecture without a diagram cannot be reviewed efficiently, cannot be handed off safely, and cannot be compared to the design review checklist in a systematic way.

**Platform-level standardization of reference architectures.** Staff engineers at FAANG define and maintain reference architectures for common service patterns: a stateless API service, a stateful worker with a queue, a data pipeline with at-least-once delivery. Each reference architecture embeds the correct defaults: circuit breakers configured, tracing enabled, backpressure implemented, partition behavior documented. New services start from a reference architecture rather than from scratch, which means the default is correct rather than the default being missing.

**Identifying blast-radius boundaries.** The decision map in this diagram makes blast radius visible. If the consensus store fails (etcd quorum lost), which services are affected? If the observability pipeline drops messages, which failure modes become invisible? If the load balancer's health check is misconfigured, what does the client experience? Staff-level design reviews enumerate blast-radius scenarios explicitly and assign mitigations or accepted risks to each. An architecture diagram without blast-radius analysis is incomplete for production at FAANG scale.

**Maturity signal: are failure modes in the diagram?** A junior engineer's architecture diagram shows the happy path. A senior engineer's diagram annotates each component with its failure mode and degraded behavior. A staff engineer's diagram shows the blast radius of each failure, the detection mechanism, and the remediation path. This escalating specificity is a clear signal in design review panels about the depth of operational thinking behind a proposal.

---
