# Chapter 52: Microservices Project - E-Commerce Platform

*The best way to learn microservices is to build a complete system from scratch, experiencing the challenges and trade-offs firsthand.*

Reading about microservices patterns and building them are different activities. The patterns are straightforward in isolation: a service boundary here, an event there, a saga coordinator for the distributed transaction. The difficulty is integration, discovering that your service boundaries were drawn in the wrong place only after you implement a feature that spans three of them, or realizing that your event schema does not carry enough context for downstream consumers when you are six services deep. These lessons only emerge when all the pieces run together.

This chapter synthesizes Part 7 and Part 8 into a single end-to-end project: an e-commerce platform with eight services communicating through gRPC and Kafka, a saga orchestrator managing distributed order transactions, an API gateway handling external traffic, and an observability stack. The domain is deliberately familiar so you can focus on architectural decisions rather than domain modeling. Each service follows the structure used in production systems: owned database, gRPC interface for synchronous calls, Kafka consumer for event-driven reactions, and Prometheus metrics for operational visibility.

The project is structured for incremental completion. Each section adds a new service or cross-cutting capability, and the system is testable at every stage. By the end, you will have a running microservices system that demonstrates the major patterns covered in this book, and you will understand the trade-offs behind each decision because you will have made them yourself.

**What you'll learn in this chapter:**
- Designing service boundaries for a realistic e-commerce domain: User, Product, Inventory, Cart, Order, Payment, and Notification services
- Wiring synchronous gRPC communication between services with proper error handling and deadline propagation
- Building an event-driven backbone with Kafka for order lifecycle events across all downstream services
- Implementing a saga orchestrator in Go to manage the distributed Order → Inventory → Payment → Fulfillment transaction
- Deploying all services with Docker Compose, including PostgreSQL, Redis, Kafka, and Consul
- Registering services with Consul and implementing client-side load balancing with health check filtering
- Adding structured logging, Prometheus metrics, and distributed tracing across all services from a shared observability library
- Writing integration tests that spin up the full service graph in-process using Docker test containers

**Why this matters at scale:**
Amazon's service decomposition, driven by the famous two-pizza-team mandate, is the founding case study for the architectural principles you will apply in this chapter: each domain (storefront, checkout, payments, fulfillment) independently deployable and owned end to end. (Shopify, by instructive contrast, processes millions of orders per day on a deliberately modular monolith, proof that the boundaries matter more than the deployment topology.)

**Prerequisites:** All chapters in Part 7 (gRPC, chapters 42-45) and Part 8 (chapters 46-50), plus Docker and Docker Compose installed locally

### Junior → FAANG: Why a Full Project Matters More Than Isolated Tutorials

Reading individual pattern chapters builds vocabulary but not muscle memory. When you sit down to design a system in an interview, the interviewer is not asking you to recite the saga pattern. They are watching whether you reach for the right pattern at the right moment, whether you think about service boundaries before code, and whether you anticipate failure modes without prompting.

Working through this chapter end-to-end trains those instincts. Specific habits to build now:

**Draw the architecture before writing any code.** Sketch which services exist, which communicate synchronously (gRPC), and which communicate via events (Kafka). Identify where shared state lives. This habit, practiced here, becomes the whiteboard skill that opens the FAANG loop.

**Name the failure mode in every design choice.** The cart service stores data in Redis. What happens during a Redis failover? The saga clears the cart after reserving inventory. What if cart-clear fails? Asking "what fails here?" for each step is the mental model FAANG interviewers reward.

**Trace a request end-to-end manually.** Before running the system, walk through: user clicks "place order," API gateway routes to order service, order service reads cart, cart service reads Redis, order service calls inventory service, inventory service locks a row, order service publishes event, payment service consumes event. Following this chain reveals dependency coupling that diagrams hide.

**Read the event schema as a contract.** The `events` package defines what each event looks like. Get used to asking: if the payment service adds a new field to `PaymentProcessedEvent`, do consumers break? This is schema evolution thinking, a real concern in every production system.

For first-job interviews, prepare to explain one service boundary choice in detail. "Why is the cart separate from the order service?" is a common warm-up question. Have a data ownership and transaction boundary answer ready.

### Senior @ FAANG: Platform Thinking, Governance, and the Decisions Behind the Decisions

This project is a teaching scaffold. At FAANG scale, the decisions behind each component choice are the interview content. A bar-raiser is not checking that you know what a saga is. They are checking whether you understand the organizational and operational consequences of choosing orchestration over choreography, or Consul over a service mesh.

**ADR framing for every major choice.** Each architectural decision in this chapter should live in an Architecture Decision Record. The format that holds up in bar-raiser reviews covers: context (what forces are at play), decision (what we chose), consequences (what becomes easier, what becomes harder), and alternatives considered (and why rejected). For this platform, decisions worth an ADR include: database-per-service vs shared schema, outbox polling vs Debezium CDC, Consul vs Kubernetes-native service discovery, hand-written saga vs Temporal, and Redis-only cart vs database-backed cart.

**Conway's Law alignment.** The eight-service decomposition only delivers its promise if team ownership aligns with service boundaries. A single team owning both the order service and the payment service will eventually collapse the boundary because cross-service refactoring is faster than cross-team coordination. At FAANG, service boundary proposals are evaluated against the org chart, not just the domain model. When asked to design service boundaries in an interview, demonstrating awareness of team topology signals L6/L7 readiness.

**Maturity model for the saga implementation.** The hand-written saga here is at maturity level 1. Level 2 adds the transactional outbox so events are published atomically with the state change. Level 3 adds a saga log table so in-flight sagas survive process crashes. Level 4 replaces the custom machinery with Temporal, where durability, retry, and observability are platform features rather than application code. A staff-level candidate names these levels and identifies which tradeoffs justify each jump.

**Platform thinking for observability.** The shared `pkg/tracing` and `pkg/events` packages are the embryo of a platform library. At scale, this library becomes a team responsibility: it must be versioned, its deprecations communicated, and its consumers tracked. Platform teams at FAANG own the decision of what belongs in this library (tracing bootstrap, structured logging, health check conventions, Kafka consumer wrappers) and what stays in individual services. Defining those boundaries, and governing them through RFC processes rather than ad-hoc PRs, is the staff-level contribution.

**Bar-raiser signals.** In a system design interview for this domain, the signals that distinguish L5 from L6 are: L5 names the components correctly and reasons about the happy path. L6 identifies failure modes before the interviewer prompts them, quantifies the blast radius of each failure, proposes observability to detect each failure mode, and ties every technical choice to a business or organizational constraint. L7 connects the system design to the product roadmap ("this boundary makes sense now, but when we add B2B wholesale ordering, the inventory service will need to split").

---
