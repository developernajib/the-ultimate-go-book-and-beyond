## 105E.1 Distributed Tracing Architecture

A distributed trace is composed of spans (individual units of work) linked by a shared trace ID that propagates across service boundaries via HTTP headers or gRPC metadata. Each span records its own start time, duration, parent span ID, and any attributes or events relevant to that operation. The hierarchy of spans forms a directed acyclic graph (DAG) that reveals the critical path, concurrency patterns, and latency contributions of every service involved in fulfilling a single request.

```
┌───────────────────────────────────────────────────────────────────────┐
│              DISTRIBUTED TRACE ANATOMY                                │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Trace ID: a1b2c3d4e5f6...  (16 bytes, globally unique)               │
│                                                                       │
│  ├── Span: "POST /checkout"  [frontend]   0ms ─────────────────┐      │
│  │   Span ID: 1234                                               │    │
│  │   Parent ID: none (root)                                      │    │
│  │                                                               │    │
│  │   ├── Span: "validate cart"  [orders]   10ms ──────────┐    │      │
│  │   │   Span ID: 5678                                      │    │    │
│  │   │   Parent ID: 1234                                    │    │    │
│  │   │                                                      │    │    │
│  │   │   ├── Span: "db.SELECT carts"  50ms ─────┐          │    │     │
│  │   │   │                                       │ 15ms     │    │    │
│  │   │   │   Events: "query.plan"  ──────────────┘          │    │    │
│  │   │   │                                                   │ 35ms   │
│  │   ├── Span: "charge payment"  [payments]  120ms ─────────┘    │    │
│  │   │                                                            │   │
│  │   │   ├── Span: "stripe.charge"  (external)  100ms           │     │
│  │   │                                                            │   │
│  │   └── Span: "send confirmation"  [notifications]  30ms       │     │
│  │                                                                │   │
│  └─────────────────────────────────────────────────────────────┘      │
│                                                                       │
│  Total trace duration: 180ms                                          │
│  Critical path: validate → charge (bottleneck at Stripe)              │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading the Waterfall Before You Touch the Code

The first skill a junior engineer must develop with distributed tracing is reading the waterfall diagram fluently before touching any code. When a trace appears in Jaeger or Tempo, identify these four things in order: the root span (the entry point), the critical path (the longest sequential chain from root to leaf), the widest gap between a parent span ending and child spans beginning (scheduling or serialization overhead), and any span with an error status. That four-step scan takes under 60 seconds and replaces 30 minutes of log correlation.

The most common mistake at the junior level is treating spans as debug print statements, adding them to every function regardless of whether the function represents a meaningful work boundary. A span should represent an operation that could independently be slow, fail, or be replaced. Database queries, external HTTP calls, cache lookups, and queue publishes are canonical spans. A helper function that formats a string is not.

### Senior @ FAANG: Trace Architecture as a System Design Constraint

At L6, the distributed trace architecture diagram above is not just an explanation of how tracing works. It is a system design constraint that governs how services are decomposed. When a trace's critical path always passes through service X, that service is a synchronous bottleneck regardless of its internal latency. The correct architectural response is not to optimize service X but to ask whether its work can be moved off the critical path entirely through async delegation, speculative pre-computation, or client-side caching.

The span hierarchy encodes implicit coupling. When the frontend span directly parents a payment span, the frontend is blocked on payment. When the notification span is a sibling of the payment span rather than a child of the root, it was made async. These relationships are architectural decisions, and they should be captured in an ADR that references the trace diagram as evidence. A trace is a more honest architecture diagram than any box-and-arrow drawing because it reflects actual runtime behavior rather than intended design.

At platform scale, the trace data model also determines cost structure. Each span is typically 1-2 KB of storage. At 10,000 requests per second with an average of 20 spans per trace, that is 200,000 spans per second, roughly 300-400 MB per second before compression. Tail-based sampling is not optional at this scale. The senior engineer designs the sampling policy as an explicit system component with its own SLO: "100% of error traces and p99-latency outliers are retained, all others sampled at 1%." This policy is documented, version-controlled, and reviewed when traffic patterns change.

---
