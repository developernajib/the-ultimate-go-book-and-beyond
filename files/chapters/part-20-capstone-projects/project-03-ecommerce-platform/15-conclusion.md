## Conclusion

This e-commerce platform is a reference implementation for production-grade distributed systems in Go, covering:

- Microservices architecture and communication patterns
- Distributed transaction management with sagas
- Event-driven architecture with message queues
- Full-text search with Elasticsearch
- Payment processing with Stripe
- Caching and performance optimization
- Observability and monitoring
- Testing strategies for distributed systems
- Deployment with Docker and Kubernetes

This project showcases staff engineer-level skills: system design, distributed systems patterns, production operations, and the ability to make informed trade-offs.

**Remember**: Building distributed systems is about managing complexity through careful decomposition, clear boundaries, and thorough error handling. Every design decision has trade-offs - the key is understanding and documenting them.

## FAANG Interview Questions

**Q: How would you design an inventory system that prevents overselling during a flash sale?**

A: Use optimistic reservation with a dedicated inventory service backed by Redis for hot SKUs. On add-to-cart, decrement the atomic counter with a Lua script that checks stock and creates a 15-minute reservation. On checkout, the reservation converts to a committed order via a transactional write to the primary datastore (Postgres with SELECT FOR UPDATE, or DynamoDB with a conditional update). Async reconciliation reverts unconfirmed reservations. For extreme concurrency (drops, console launches), use a queue-based admission controller that admits N users per second into the checkout flow.

**Q: How do you implement idempotent payment processing?**

A: Every payment request carries a client-generated idempotency key. The payment service stores (idempotency_key, request_hash, response) in a Postgres table with the key as primary key. On retry, the service returns the cached response if the key matches. Reject requests where the key matches but the hash differs (replay attack or client bug). Expire keys after 24 hours. Wrap the external gateway call and local state update in a saga with compensating actions, since two-phase commit across Stripe and your database is not possible.

**Q: How would you scale product search across 100M SKUs?**

A: Elasticsearch with 20 primary shards replicated 2x. Index documents with denormalized fields (category path, brand, attributes) to avoid join queries. Use function_score for relevance tuning (BM25 plus business signals like sales velocity and margin). Cache the top 1000 queries in Redis since search traffic follows a Zipf distribution. For filters (faceted navigation), use Elasticsearch aggregations with post_filter to decouple filter counts from result filtering. Pre-compute personalized re-ranking features nightly.

**Q: How do you handle distributed transactions across cart, inventory, and payment services?**

A: Saga pattern with choreography or orchestration. A checkout saga emits events: ReserveInventory, ChargePayment, CreateOrder, ConfirmShipment. Each step has a compensating action (ReleaseInventory, RefundPayment). Use an orchestrator service (Temporal, AWS Step Functions) to track saga state. Each service owns its local transaction, no cross-service 2PC. Idempotency keys on every step handle retries. Outbox pattern ensures events are published atomically with local state changes.

**Q: How would you build a recommendation system for a new user with no history?**

A: Use a multi-stage fallback. (1) Popular items globally for the cold-start user. (2) Demographic-based recommendations from signup data (country, stated interests). (3) Session-based recommendations after 2-3 clicks using a sequence model (GRU4Rec or Transformer trained on click sequences). (4) Collaborative filtering kicks in after the user has 10-plus interactions. Run all stages in parallel and blend with a learned weighting. A/B test the blend via session success rate, not click-through rate alone.

### Junior → FAANG: Converting E-Commerce Experience into Interview Confidence

This is the most interview-relevant project in the book. "Design an e-commerce platform" is a top-5 FAANG system design question. You have now built one. Before your interview, pick the three most interesting technical decisions you made in this project and be able to discuss each for three minutes: the problem, the options you considered, the decision you made, and what you would do differently now.

The Saga pattern discussion alone can fill a productive 10-minute conversation in a senior interview. Know the choreography versus orchestration tradeoff, know how idempotency is maintained across retries, and know what monitoring is needed to detect stuck Sagas. That depth demonstrates distributed systems maturity.

### Senior @ FAANG: The E-Commerce Conclusion as an ADR Template

At senior level, the conclusion of this project should prompt you to write the ADRs you did not write while building it. Each major decision (gRPC over REST for internal communication, NATS JetStream over Kafka, PostgreSQL with soft reservations over Redis-first inventory) deserves a documented rationale. Writing these ADRs retroactively is a useful exercise: if you find you cannot articulate the rationale, the decision may have been made on intuition rather than analysis.

The bar-raiser interview scenario for an e-commerce platform focuses on exactly the decisions documented in the conclusion: how do you handle a payment provider outage, how do you prevent double charging on retries, how do you scale the inventory check under a flash sale, and how do you ensure data consistency when a Saga step fails midway? If you can answer each of those with reference to your own implementation, you are demonstrating engineering judgment, not just knowledge.

Staff-level impact for an e-commerce platform goes beyond building it. A staff engineer extracts the reusable patterns (Saga orchestration, idempotent payment integration, event-driven inventory management) into platform primitives that other teams can use without re-solving the same problems. That extraction and documentation work is the organizational multiplier that justifies the staff engineer title.

---

## Navigation & Cross-References

| [Project 2: Real-Time Chat Application](../project-02-chat-application/00-introduction.md) | [Part XX: Capstone Projects](../00-part-intro.md) | [Project 4: Distributed Cache](../project-04-distributed-cache/00-introduction.md) |
| :--- | :---: | ---: |
| ◀ Previous Project | Table of Contents | Next Project ▶ |
