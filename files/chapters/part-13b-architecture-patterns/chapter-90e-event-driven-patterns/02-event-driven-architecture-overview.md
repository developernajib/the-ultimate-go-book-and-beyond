## 90E.1 Event-Driven Architecture Overview

Event-Driven Architecture (EDA) decouples producers from consumers by communicating through immutable events on a shared broker rather than through direct synchronous calls. Producers emit events representing things that happened (for example, "order placed" or "payment processed") without knowing who will react. Consumers subscribe to the events they care about and process them independently, enabling horizontal scalability and resilience to individual service failures. The diagram below shows the three main topologies: simple event queue (point-to-point), pub/sub (fan-out to multiple consumers), and event streaming (durable ordered log with replay capability).

```
┌──────────────────────────────────────────────────────────────────┐
│                 Event-Driven Architecture                        │
│                                                                  │
│  Producer          Event Bus           Consumer                  │
│  ────────          ─────────           ────────                  │
│  Publishes event   Kafka / NATS        Subscribes                │
│  Fire-and-forget   RabbitMQ            Processes                 │
│  No coupling       Pulsar              At-least-once             │
│                                        Idempotent                │
│                                                                  │
│  Patterns:                                                       │
│  ┌────────────────────────────────────────────────────────┐      │
│  │ Event Notification: "something happened"               │      │
│  │ Event-Carried State: "here's the full new state"       │      │
│  │ Event Sourcing: "events ARE the system of record"      │      │
│  │ CQRS + Events: write side emits, read side projects    │      │
│  └────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────┘
```

---
