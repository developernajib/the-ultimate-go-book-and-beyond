## 90D.1 Architecture Pattern Landscape

The diagram below maps six foundational architecture patterns along two axes: complexity and data model. Understanding where each pattern sits helps you choose the right tool for the problem at hand. Simple CRUD is correct for most features. You reach for CQRS, Event Sourcing, or the Saga pattern only when read/write asymmetry, audit requirements, or distributed transactions justify the additional complexity.

```
┌──────────────────────────────────────────────────────────────────┐
│                  Architecture Pattern Map                        │
│                                                                  │
│  Simple CRUD          CQRS                Event Sourcing         │
│  ────────────         ────                ─────────────          │
│  Single model         Command → Write     Commands → Events      │
│  Read = Write         Query  → Read       State = replay(events) │
│  Easy to start        Optimize each       Full audit trail       │
│                                                                  │
│  Hexagonal            Saga                Outbox                 │
│  ─────────            ────                ──────                 │
│  Domain at center     Multi-step tx       Atomic publish         │
│  Ports: interfaces    Compensations       No dual-write race     │
│  Adapters: impl       Orchestration       Eventual consistency   │
└──────────────────────────────────────────────────────────────────┘
```

---
