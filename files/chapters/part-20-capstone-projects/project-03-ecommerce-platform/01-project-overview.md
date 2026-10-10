## Project Overview

This is the largest project in this book: a full-featured e-commerce platform built with microservices architecture. This project demonstrates comprehensive Go systems engineering, from syntax fundamentals to advanced distributed patterns.

### What You'll Build
A production-ready e-commerce backend with:
- **Microservices Architecture**: 6+ independent services
- **Payment Processing**: Stripe integration with webhooks
- **Search**: Elasticsearch-powered product search
- **Event-Driven**: Kafka/NATS for async communication
- **Distributed Transactions**: Saga pattern implementation
- **API Gateway**: Unified REST API with gRPC backends
- **High Availability**: Circuit breakers, retries, timeouts
- **Observability**: Distributed tracing, metrics, logging

### Learning Objectives

By completing this project, you will:

1. Design and implement a microservices architecture from scratch
2. Handle distributed transactions with the Saga pattern
3. Integrate third-party payment systems (Stripe)
4. Implement full-text search with Elasticsearch
5. Build an event-driven system with message queues
6. Create an API Gateway for request routing and aggregation
7. Handle inventory management with concurrent purchases
8. Implement production-ready error handling and resilience patterns

### Technology Stack

The technology stack reflects deliberate trade-offs between developer productivity, operational complexity, and performance requirements for each component. PostgreSQL handles relational order and product data while Redis provides sub-millisecond cart reads and caching.

```
Backend:          Go 1.27+
API Protocol:     gRPC (inter-service), REST (client-facing)
Message Queue:    NATS JetStream
Search:           Elasticsearch
Databases:        PostgreSQL (services), Redis (caching)
Payment:          Stripe API
API Gateway:      Custom Go implementation
Observability:    OpenTelemetry, Prometheus, Jaeger
Deployment:       Docker Compose, Kubernetes manifests
```

### Architecture Overview

The system splits into four independent services connected by an API gateway. Each service owns its database and communicates with others through asynchronous events (NATS) for eventual consistency.

```
                                    ┌─────────────────┐
                                    │   API Gateway   │
                                    │   (REST API)    │
                                    └────────┬────────┘
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    │                        │                        │
         ┏━━━━━━━━━━▼━━━━━━━━┓    ┏━━━━━━━━▼━━━━━━━┓    ┏━━━━━━━━▼━━━━━━━┓
         ┃  Product Service  ┃    ┃  User Service   ┃    ┃  Order Service  ┃
         ┃  (gRPC)           ┃    ┃  (gRPC)         ┃    ┃  (gRPC)         ┃
         ┗━━━━━━━━┳━━━━━━━━━┛    ┗━━━━━━━━┳━━━━━━━┛    ┗━━━━━━━━┳━━━━━━━┛
                  │                         │                      │
         ┌────────▼────────┐      ┌────────▼────────┐    ┌────────▼────────┐
         │   PostgreSQL    │      │   PostgreSQL    │    │   PostgreSQL    │
         └─────────────────┘      └─────────────────┘    └─────────────────┘
                  │                         │                      │
                  └─────────────────────────┼──────────────────────┘
                                            │
                                   ┌────────▼────────┐
                                   │  NATS JetStream │
                                   │  (Event Bus)    │
                                   └────────┬────────┘
                                            │
                    ┌───────────────────────┼───────────────────────┐
                    │                       │                       │
         ┏━━━━━━━━━▼━━━━━━━━┓   ┏━━━━━━━━▼━━━━━━━┓   ┏━━━━━━━━▼━━━━━━━━┓
         ┃  Cart Service     ┃   ┃ Payment Service ┃   ┃ Notification Svc ┃
         ┃  (gRPC)           ┃   ┃ (gRPC + Stripe) ┃   ┃ (gRPC)           ┃
         ┗━━━━━━━━┳━━━━━━━━━┛   ┗━━━━━━━━┳━━━━━━━┛   ┗━━━━━━━━━━━━━━━━━━┛
                  │                       │
         ┌────────▼────────┐     ┌───────▼────────┐
         │   Redis Cache   │     │  Stripe API    │
         └─────────────────┘     └────────────────┘

                           ┌──────────────────┐
                           │  Elasticsearch   │
                           │  (Search Index)  │
                           └──────────────────┘
```

### Junior → FAANG: Microservices as a System Design Pattern

The microservices architecture in this project (Product, Order, Payment, Cart, User services communicating over gRPC and an event bus) is the canonical answer to "design an e-commerce system" in FAANG interviews. Be able to draw this diagram, name each service and its responsibility, and describe the data flow for a checkout.

The key insight is that each service owns its own data store. The Product Service owns the product database. The Order Service owns the order database. No service reads another service's database directly. Cross-service data access happens through API calls or events. This boundary prevents the coupling that makes large codebases difficult to change.

For interviews, explain the checkout flow step by step: client sends checkout request to API gateway, gateway calls Order Service, Order Service validates product availability via Product Service (gRPC call), Order Service creates order record, Order Service emits OrderCreated event, Payment Service consumes event and processes payment, Payment Service emits PaymentCompleted event, Fulfillment Service consumes event and triggers shipping. That narrative shows end-to-end systems thinking.

### Senior @ FAANG: Microservices Governance at Scale

At senior level, the overview diagram is a governance document. Each service boundary represents an organizational boundary: the team that owns the service is responsible for its uptime, its API, and its data. When a service fails, the owning team is on-call. When an API needs to change, the owning team negotiates the migration window with dependent teams.

Service mesh (Istio, Linkerd) is the platform layer that makes microservices manageable at scale: mutual TLS between services (no plaintext internal traffic), traffic management (circuit breakers, retries, timeouts), and observability (service-level metrics and traces without application code changes). The decision to adopt a service mesh is a platform governance decision that affects every team simultaneously. The ADR should document the security posture improvement (mTLS), the operational cost (sidecar overhead, proxy debugging complexity), and the migration strategy for existing services.

Distributed tracing across all six services in this project requires that a trace ID is propagated through every gRPC call and every event published to the event bus. Without trace propagation, a slow checkout is diagnosable only to the service level, not to the specific RPC within that service. Standardizing trace propagation (using OpenTelemetry context propagation) across all services is a platform engineering concern that must be solved before the system goes to production.

---
