## Summary

This chapter built an e-commerce platform from seven microservices and an API gateway, exercising the core patterns from Parts 7 and 8 in a realistic, integrated system.

**Architecture decisions and their rationale:**

1. **Service decomposition by business capability.** Each service (User, Product, Inventory, Cart, Order, Payment, Notification) owns a single domain and can be developed, deployed, and scaled independently.
2. **Database per service.** PostgreSQL for services that need transactional guarantees (users, products, inventory, orders, payments, notifications) and Redis for the cart service, where low-latency access matters more than durability.
3. **Event-driven communication via Kafka.** Services publish domain events (`order.created`, `payment.processed`) and interested services subscribe. This decouples the order service from the notification service, a notification outage does not block order creation.
4. **Saga orchestration for distributed transactions.** The order service coordinates the create-order flow: persist the order, reserve inventory, clear the cart. If inventory reservation fails, the saga compensates by canceling the order. If payment fails later, the saga releases inventory.
5. **Consul for service discovery.** Services register themselves on startup and other services resolve addresses dynamically, enabling horizontal scaling without configuration changes.
6. **Shared event type definitions.** The `pkg/events` package provides a single source of truth for topic names and payload structs, preventing misrouted events from typos and catching schema mismatches at compile time.

**Key trade-offs to remember:**

- The cart service's Redis-only storage trades durability for speed. Production systems should back Redis with a persistent store.
- Inline schema creation (`CREATE TABLE IF NOT EXISTS`) works for development but should be replaced with versioned migrations for production.
- The simulated payment gateway is useful for testing compensation flows but must be replaced with a real provider (Stripe, PayPal) before launch.

### Junior → FAANG: What to Carry Forward From This Chapter

A chapter like this one has a half-life problem: the code is memorable immediately after you build it, but the architecture reasoning fades. These are the three things to internalize that stay useful regardless of which specific technology stack you work in.

**The sequence: boundary first, data ownership second, communication protocol third.** Before writing any service code, establish which bounded context owns which data. Once you know data ownership, you know which service owns which database tables. Once you know that, you can decide which calls must be synchronous (the caller needs data owned by another service to proceed) and which can be async (the caller is reacting to a state change in another service). This sequence prevents the most common microservices mistake: building the services first and discovering the data ownership problems after deployment.

**The saga failure mode checklist.** For every saga you design or review, walk through: what happens if the service crashes between step N and step N+1, for each N? What compensation runs? Is it idempotent? Is there a monitoring alert for sagas that are stuck in intermediate states? This checklist takes five minutes and prevents the most common saga production incidents.

**The event as a contract mindset.** Every time you add a field to an event struct, pause and ask: who are the current consumers? Will this field breaking their deserialization? Is this a backward-compatible change? Treating events with the same care as HTTP API changes, versioned, documented, and coordinated with consumers, is the habit that prevents the "event schema drift" class of production incidents.

For your FAANG preparation, this chapter gives you the technical vocabulary and the code references. The interview practice is: explain the checkout saga from memory in four minutes, draw the service boundary diagram from memory on a whiteboard, and answer "how do you prevent overselling during a flash sale?" in under two minutes.

### Senior @ FAANG: The Chapter as an Architectural Reference Point

This chapter presents one valid architecture for an e-commerce platform at a specific scale and team size. A staff-level reading of the summary is an evaluation of each decision against the constraints that would apply in different contexts.

**The six architectural decisions and their context-dependence.** Service decomposition by business capability is correct at any scale. Database-per-service is correct at the team-per-service scale and should be adopted even before teams exist, to establish the ownership boundary. Event-driven communication via Kafka is correct when the event volume justifies the operational cost of a Kafka cluster. At lower volumes, NATS JetStream or even a database-backed queue is simpler. Saga orchestration is correct for the three-step checkout flow here. A more complex flow with five or more services warrants Temporal. Consul service discovery is correct in a bare-metal or early Kubernetes environment - in a mature Kubernetes environment, the service mesh replaces it. Shared event type definitions are correct and should be governed with an RFC process as the team grows.

**The production graduation checklist.** Before this platform handles real money, it needs: schema migrations replacing the inline `createSchema` calls, a real payment gateway replacing the simulator, refresh token rotation with reuse detection, Redis persistence or database backing for carts, at-least-once delivery enforcement for all event consumers, per-service database users with column-level permissions, distributed tracing with tail-based sampling, a saga reconciliation job with alerting for stuck orders, and Kubernetes manifests for production deployment. Each item is a sprint of work. The staff engineer's contribution is sequencing them by risk: payment gateway and idempotency are first-week concerns, Kubernetes migration is a three-month project.

**Communicating the roadmap to non-technical stakeholders.** The summary above describes technical trade-offs. A staff engineer also frames these for the business: "The simulated payment gateway means we cannot process real money. We need two engineering weeks to integrate Stripe and one week of QA before launch. The Redis-only cart means a database failover during peak traffic could cause a measurable drop in conversion rate. Fixing this is a one-sprint project and should be in the backlog before the first major sale event." This translation from technical trade-off to business risk is the communication pattern that gets architectural work prioritized.

---
