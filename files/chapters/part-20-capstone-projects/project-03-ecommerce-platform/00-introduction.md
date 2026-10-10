# Capstone Project 3: Microservices E-Commerce Platform

**Difficulty**: Advanced
**Estimated Time**: 3-4 weeks
**Target**: Production-grade, distributed microservices e-commerce platform with event-driven architecture
**Tech Stack**: Go 1.27+, PostgreSQL, NATS JetStream, Redis, Elasticsearch, Docker Compose, Stripe API

---

### Project Overview & Architecture

Modern e-commerce platforms represent one of the most demanding challenges in software engineering. They must maintain strict financial accuracy and transactional consistency during checkout, provide sub-millisecond inventory reservations under flash-sale traffic spikes, deliver fuzzy product search across millions of SKUs, and gracefully coordinate asynchronous fulfillment across independent microservices.

In this capstone project, you will architect and build a production-grade, distributed E-Commerce platform in Go. The system is decomposed into specialized, decoupled microservices—Product Catalog, Cart Service, Order Management, and Payment Gateway—communicating asynchronously via NATS JetStream event streams and exposing a unified API Gateway.

```
┌──────────────────────────────────────────────────────────────┐
│                    Clients (Web / Mobile)                    │
└──────────────────────────────┬───────────────────────────────┘
                               │ HTTP / JSON
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                  API Gateway & Auth Proxy                    │
└──────┬───────────────────────┬───────────────────────┬───────┘
       │                       │                       │
       ▼                       ▼                       ▼
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│Product Catalog│       │ Cart Service │       │ Order Engine │
│  (Postgres & │       │(Redis Cache &│       │(State Machine│
│Elasticsearch)│       │ Session Sync)│       │ & Saga Coord)│
└──────┬───────┘       └──────┬───────┘       └──────┬───────┘
       │                      │                      │
       └──────────────────────┼──────────────────────┘
                              │ NATS JetStream Events
                              ▼
               ┌──────────────────────────────┐
               │   Payment & Billing Worker   │
               │  (Stripe Idempotent Gateway) │
               └──────────────────────────────┘
```

### What You Will Build and Learn Across Sections

Throughout this project, you will build each microservice component from scratch:

- **Part 1 (Foundation & Setup)**: Establish the multi-service monorepo structure, shared domain models, database migrations, and Docker Compose orchestration.
- **Part 2 (Product Service & Search)**: Build high-performance product catalog APIs backed by PostgreSQL and sync product documents into Elasticsearch for full-text search.
- **Part 3 (Cart Service & Session Management)**: Implement low-latency cart operations backed by Redis with TTL expiration and atomic item incrementation.
- **Part 4 (Order Service & State Machine)**: Model the order lifecycle (Pending, Payment Authorized, Processing, Shipped, Cancelled) using an explicit, verifiable state machine.
- **Part 5 (Payment Gateway & Stripe Integration)**: Integrate Stripe's payment APIs using idempotent request keys, secure webhook signature verification, and automated refunds.
- **Part 6 (Event Bus & Asynchronous Messaging)**: Connect services via NATS JetStream publish-subscribe topics to handle order placement events, payment confirmations, and inventory decrements.
- **Part 7 & 8 (API Gateway & System Integration)**: Route external client traffic through an API Gateway with JWT validation, rate limiting, and centralized error logging.
- **Part 9 & 10 (Testing & Production Deployment)**: Write end-to-end integration tests with testcontainers-go and package the complete system for Kubernetes deployment.

---

### Junior → FAANG: Why E-Commerce Is the Premier System Design Interview Domain

E-commerce system design appears in FAANG interviews more than almost any other domain because it touches every fundamental distributed systems problem: inventory management (distributed counters with consistency requirements), payment processing (exactly-once semantics with financial accuracy requirements), product catalog (high-read-throughput with search), and order management (state machines with rollback). Working through this project gives you concrete implementation experience with all of them.

For entry-level roles, the key is to describe the system in terms of its microservices and their responsibilities, then walk through the data flow for one complete user journey (add to cart, checkout, payment, fulfillment). That narrative demonstrates end-to-end understanding.

### Senior @ FAANG: E-Commerce as a Platform Maturity Model

At senior level, building an e-commerce platform is an exercise in managing shared infrastructure and clear service ownership. Each microservice (Product, Order, Payment, Cart) must have a defined SLA, a clear API contract, and an owner who is responsible for on-call response when it fails.

The event bus (NATS JetStream in this project) is the coupling mechanism between services. Every event schema is a contract: downstream services depend on specific fields. Adding a field is safe. Removing a field requires a deprecation process with a migration window. Staff engineers govern the event schema registry and enforce this discipline across all producer and consumer teams.
