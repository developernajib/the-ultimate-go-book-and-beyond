## 62.2 High-Level Architecture

The architecture separates concerns into three horizontal layers: intake (API Gateway + Notification Service), queuing (priority-partitioned Kafka topics), and delivery (per-channel worker pools). This separation means a surge in low-priority marketing emails cannot starve critical security alerts, each priority level gets its own topic and independently scaled consumer group. The Preference Service and Template Engine are consulted synchronously at intake time so that workers receive fully resolved, channel-ready payloads and can focus purely on delivery without needing to re-query user data.

```
                              ┌─────────────────┐
                              │   API Gateway   │
                              └────────┬────────┘
                                       │
                              ┌────────▼────────┐
                              │  Notification   │
                              │    Service      │
                              └────────┬────────┘
                                       │
         ┌─────────────────────────────┼─────────────────────────────┐
         │                             │                             │
         ▼                             ▼                             ▼
┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
│  Priority Queue │          │   Preference    │          │    Template     │
│    (Kafka)      │          │    Service      │          │     Engine      │
└────────┬────────┘          └─────────────────┘          └─────────────────┘
         │
         ├─────────────────────────────┬─────────────────────────────┐
         │                             │                             │
         ▼                             ▼                             ▼
┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
│  Email Worker   │          │   SMS Worker    │          │  Push Worker    │
└────────┬────────┘          └────────┬────────┘          └────────┬────────┘
         │                             │                             │
         ▼                             ▼                             ▼
┌─────────────────┐          ┌─────────────────┐          ┌─────────────────┐
│   SendGrid /    │          │  Twilio / AWS   │          │   FCM / APNs    │
│     SES         │          │      SNS        │          │                 │
└─────────────────┘          └─────────────────┘          └─────────────────┘
```

### Junior -> FAANG: Reading Architecture Diagrams Like an Engineer

The three-layer architecture (intake, queue, delivery) is the canonical pattern for event-driven notification systems, and FAANG interviewers expect you to be able to reproduce and explain it from memory. The key insight is that each layer has a single responsibility: intake validates and enriches, the queue decouples and prioritizes, delivery handles provider-specific concerns.

A common junior mistake is collapsing these layers. "The API just calls SendGrid directly" works in a demo but fails in production because: the API is now blocked on a synchronous network call to an external provider, a SendGrid outage makes the API unavailable, there is no retry mechanism, and the API has no way to prioritize critical vs marketing traffic.

Interviewers look for the ability to name each layer and justify why it exists. Practice explaining: "The Preference Service is consulted synchronously at intake so that workers receive fully resolved payloads and never need to re-query user data. This keeps the hot delivery path simple and prevents preference store latency from affecting delivery throughput."

The Template Engine being at the intake layer (rather than in the worker) is a deliberate choice worth explaining: templates are rendered once, before queuing, so the worker's only job is delivery. This also means the rendered content is what gets persisted to the database, providing a complete audit record of exactly what was sent.

### Senior @ FAANG: Architectural Trade-offs That Require Explicit Justification

The decision to consult the Preference Service synchronously at intake is an ADR worth documenting. The alternative is to pass a raw notification payload through the queue and have each worker apply preferences at delivery time. That alternative has a hidden cost: if a user opts out between the time the notification is queued and the time it is delivered (which can be seconds to minutes at high queue depth), the preference change is ignored. Intake-time preference enforcement guarantees compliance at the cost of a synchronous database round trip on every notification.

**The Kafka topic topology is an architectural commitment**

Choosing Kafka with per-priority topics is a decision with long-term implications. You commit to Kafka's operational burden (broker cluster, ZooKeeper or KRaft, topic management), its retention model (messages stay in the topic for a configurable time, not until consumed), and its rebalance behavior when consumer group membership changes. The alternative (a simpler in-process priority queue or a Redis stream) is cheaper operationally but does not survive process restarts without a write-ahead log. At FAANG scale, the Kafka commitment is justified. At a startup with 50K notifications per day, it is likely premature.

**Regional deployment and multi-region considerations**

The architecture diagram shows a single-region design. At FAANG, this becomes a multi-region design immediately, because data sovereignty requirements (GDPR mandates that EU user data stays in EU) and latency requirements (Uber's 200ms end-to-end target requires the notification to originate from a region close to the provider's infrastructure) drive regional topology decisions. A staff-level candidate proposes a regional notification service per data center, with a global preference store replicated via CRDTs for eventual consistency, and a central audit log aggregated cross-region for compliance reporting.

**Dependency injection as a testability signal**

The `Dependencies` struct passed to `NewNotificationService` is not just a convenience. It is a testability commitment. Every external dependency (queue, preferences, templates, rate limiter, deduplication) is injectable, which means the service can be tested with fakes for each dependency independently. Senior candidates notice this pattern and call it out: "The dependency injection here means we can test the preference filtering logic without a running Kafka cluster."

---
