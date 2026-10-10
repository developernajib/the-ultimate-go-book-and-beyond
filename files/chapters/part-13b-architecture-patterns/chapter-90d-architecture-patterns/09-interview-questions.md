## 90D.8 Architecture Interview Questions

**Q: When should you use Event Sourcing vs traditional CRUD?**

A: Event Sourcing is justified when: (1) you need a complete audit trail (financial transactions, medical records), (2) the business needs "as of date" queries (what was the balance on Jan 1st?), (3) events are first-class business concepts, (4) you need to replay history to rebuild projections. Avoid it for: simple CRUD entities, when the event history is unimportant, or when team expertise is limited. The additional complexity is significant.

**Q: What's the difference between choreography and orchestration in sagas?**

A: **Choreography** - each service listens for events and reacts without a central coordinator. Pros: loosely coupled, no SPOF. Cons: hard to understand the overall flow, complex debugging. **Orchestration** - a central saga orchestrator calls each service and handles compensation. Pros: flow is explicit and visible, easier to debug. Cons: orchestrator is coupled to all services. For complex workflows with many steps, orchestration is usually clearer.

**Q: How does the Outbox pattern solve the dual-write problem?**

A: The dual-write problem: writing to DB and publishing to message queue are two separate operations - if the process crashes between them, you get inconsistency. The Outbox pattern writes both the domain change AND the event to the DB in a single transaction (atomicity guaranteed). A separate relay process reads the outbox table and publishes events. If the relay crashes, it retries. The message bus gets at-least-once delivery, and consumers should be idempotent.

---
