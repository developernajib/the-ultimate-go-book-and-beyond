## Architecture Overview

This diagram maps the full runtime topology of a Go microservices system: client requests flow through an API gateway that handles authentication, rate limiting, and routing, then fan out to independent services each with its own database. An event bus (Kafka or NATS) decouples asynchronous workflows, while platform services (Consul for discovery, Vault for secrets, Prometheus/Jaeger for observability) provide the operational substrate. Understanding this layout is essential before writing a single line of service code, because architectural decisions made here (database-per-service, choreography vs. orchestration) determine where Go's concurrency primitives and error propagation patterns must be applied.

```
Microservices Architecture
==========================

High-Level Architecture:
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Web App    │  │  Mobile App  │  │  Partner API │  │  Admin Panel │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
└─────────│─────────────────│─────────────────│─────────────────│─────────────┘
          │                 │                 │                 │
          └─────────────────┴────────┬────────┴─────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            API GATEWAY LAYER                                │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         API Gateway (Kong/Envoy)                      │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────────┐  │  │
│  │  │   Auth &    │ │    Rate     │ │   Request   │ │    Load         │  │  │
│  │  │   AuthZ     │ │  Limiting   │ │   Routing   │ │   Balancing     │  │  │
│  │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
           ┌─────────────────────────┼─────────────────────────┐
           │                         │                         │
           ▼                         ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SERVICE LAYER                                      │
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐   │
│  │    User     │    │    Order    │    │   Payment   │    │  Inventory  │   │
│  │   Service   │◄──►│   Service   │◄──►│   Service   │◄──►│   Service   │   │
│  │             │    │             │    │             │    │             │   │
│  │  ┌───────┐  │    │  ┌───────┐  │    │  ┌───────┐  │    │  ┌───────┐  │   │
│  │  │ gRPC  │  │    │  │ gRPC  │  │    │  │ gRPC  │  │    │  │ gRPC  │  │   │
│  │  │ + REST│  │    │  │ + REST│  │    │  │ + REST│  │    │  │ + REST│  │   │
│  │  └───────┘  │    │  └───────┘  │    │  └───────┘  │    │  └───────┘  │   │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    └──────┬──────┘   │
│         │                  │                  │                  │          │
│         ▼                  ▼                  ▼                  ▼          │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐   │
│  │  User DB    │    │  Order DB   │    │ Payment DB  │    │Inventory DB │   │
│  │ (PostgreSQL)│    │ (PostgreSQL)│    │ (PostgreSQL)│    │   (Redis)   │   │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       MESSAGING LAYER                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    Event Bus (Kafka/NATS)                             │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐                   │  │
│  │  │ user.events  │ │ order.events │ │payment.events│                   │  │
│  │  └──────────────┘ └──────────────┘ └──────────────┘                   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     PLATFORM SERVICES                                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐         │
│  │   Service    │ │   Config     │ │   Secrets    │ │   Logging    │         │
│  │  Discovery   │ │   Store      │ │   Manager    │ │   (ELK)      │         │
│  │  (Consul)    │ │  (Consul)    │ │   (Vault)    │ │              │         │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘         │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐         │
│  │   Metrics    │ │   Tracing    │ │  Alerting    │ │   Service    │         │
│  │ (Prometheus) │ │   (Jaeger)   │ │(PagerDuty)   │ │    Mesh      │         │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘         │
└──────────────────────────────────────────────────────────────────────────────┘

Service Communication Patterns:
┌──────────────────────────────────────────────────────────────────────────────┐
│                    SYNCHRONOUS COMMUNICATION                                 │
│                                                                              │
│  Request-Response (REST/gRPC):                                               │
│  ┌─────────────┐    Request     ┌─────────────┐                              │
│  │  Service A  │ ─────────────► │  Service B  │                              │
│  │             │ ◄───────────── │             │                              │
│  └─────────────┘    Response    └─────────────┘                              │
│                                                                              │
│  Use cases: Queries, real-time data, simple workflows                        │
│  Trade-offs: Coupling, latency, failure propagation                          │
├──────────────────────────────────────────────────────────────────────────────┤
│                   ASYNCHRONOUS COMMUNICATION                                 │
│                                                                              │
│  Event-Driven:                                                               │
│  ┌─────────────┐  Publish Event  ┌─────────────┐  Consume   ┌─────────────┐  │
│  │  Service A  │ ──────────────► │  Event Bus  │ ─────────► │  Service B  │  │
│  │             │                 │             │            │             │  │
│  └─────────────┘                 └─────────────┘            └─────────────┘  │
│                                         │         Consume   ┌─────────────┐  │
│                                         └─────────────────► │  Service C  │  │
│                                                             └─────────────┘  │
│  Use cases: Notifications, eventual consistency, decoupling                  │
│  Trade-offs: Complexity, debugging, message ordering                         │
├──────────────────────────────────────────────────────────────────────────────┤
│                    CHOREOGRAPHY vs ORCHESTRATION                             │
│                                                                              │
│  Choreography (Each service knows what to do):                               │
│  ┌────┐  order.created  ┌─────────┐  payment.completed  ┌──────────┐         │
│  │ A  │ ───────────────►│ Payment │ ───────────────────►│ Shipping │         │
│  └────┘                 └─────────┘                     └──────────┘         │
│                                                                              │
│  Orchestration (Central coordinator):                                        │
│  ┌────────────────┐                                                          │
│  │  Orchestrator  │                                                          │
│  └───────┬────────┘                                                          │
│          │                                                                   │
│    ┌─────┴─────┬─────────────┐                                               │
│    ▼           ▼             ▼                                               │
│ ┌──────┐  ┌─────────┐  ┌──────────┐                                          │
│ │ User │  │ Payment │  │ Shipping │                                          │
│ └──────┘  └─────────┘  └──────────┘                                          │
└──────────────────────────────────────────────────────────────────────────────┘

Domain-Driven Design:
┌──────────────────────────────────────────────────────────────────────────────┐
│                    BOUNDED CONTEXTS                                          │
│                                                                              │
│  ┌─────────────────────────────┐    ┌─────────────────────────────┐          │
│  │       User Context          │    │       Order Context         │          │
│  │  ┌─────────────────────┐    │    │  ┌─────────────────────┐    │          │
│  │  │      User           │    │    │  │      Order          │    │          │
│  │  │  - ID               │    │    │  │  - ID               │    │          │
│  │  │  - Email            │◄───┼────┼──┤  - CustomerRef      │    │          │
│  │  │  - Name             │    │    │  │  - Items            │    │          │
│  │  │  - Preferences      │    │    │  │  - Total            │    │          │
│  │  │  - AuthCredentials  │    │    │  │  - Status           │    │          │
│  │  └─────────────────────┘    │    │  └─────────────────────┘    │          │
│  │                             │    │                             │          │
│  │  User = Full Entity         │    │  CustomerRef = Reference    │          │
│  │  (owns all user data)       │    │  (minimal user info needed) │          │
│  └─────────────────────────────┘    └─────────────────────────────┘          │
│                                                                              │
│  Anti-Corruption Layer:                                                      │
│  ┌───────────────┐                  ┌───────────────┐                        │
│  │ Order Service │ ──ACL──────────► │ User Service  │                        │
│  │               │    Translates    │               │                        │
│  │ CustomerRef   │◄── User to ─────│    User       │                         │
│  └───────────────┘    CustomerRef   └───────────────┘                        │
└──────────────────────────────────────────────────────────────────────────────┘

Service Discovery:
┌──────────────────────────────────────────────────────────────────────────────┐
│                    CLIENT-SIDE DISCOVERY                                     │
│                                                                              │
│  ┌─────────┐                         ┌─────────────────┐                     │
│  │ Service │ ◄─────────────────────► │ Service Registry│                     │
│  │   A     │      Register/Query     │    (Consul)     │                     │
│  └────┬────┘                         └─────────────────┘                     │
│       │                                      ▲                               │
│       │ Route directly to instance           │                               │
│       │ (client chooses)                     │ Watch for changes             │
│       ▼                                      │                               │
│  ┌─────────────────────────────────────────┐ │                               │
│  │              Service B Instances        │ ─┘                              │
│  │  ┌──────┐  ┌──────┐  ┌──────┐           │                                 │
│  │  │ B-1  │  │ B-2  │  │ B-3  │           │                                 │
│  │  └──────┘  └──────┘  └──────┘           │                                 │
│  └─────────────────────────────────────────┘                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│                    SERVER-SIDE DISCOVERY                                     │
│                                                                              │
│  ┌─────────┐                  ┌──────────────┐                               │
│  │ Service │ ────────────────►│ Load Balancer│                               │
│  │   A     │                  │  (Router)    │                               │
│  └─────────┘                  └───────┬──────┘                               │
│                                       │                                      │
│                                       ▼                                      │
│  ┌─────────────────────────────────────────┐                                 │
│  │              Service B Instances        │                                 │
│  │  ┌──────┐  ┌──────┐  ┌──────┐           │                                 │
│  │  │ B-1  │  │ B-2  │  │ B-3  │           │                                 │
│  │  └──────┘  └──────┘  └──────┘           │                                 │
│  └─────────────────────────────────────────┘                                 │
└──────────────────────────────────────────────────────────────────────────────┘

Data Management Patterns:
┌──────────────────────────────────────────────────────────────────────────────┐
│                DATABASE PER SERVICE                                          │
│                                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                       │
│  │ User Service│    │Order Service│    │ Inv Service │                       │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘                       │
│         │                  │                  │                              │
│         ▼                  ▼                  ▼                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                       │
│  │  PostgreSQL │    │  PostgreSQL │    │    Redis    │                       │
│  │   (Users)   │    │  (Orders)   │    │ (Inventory) │                       │
│  └─────────────┘    └─────────────┘    └─────────────┘                       │
│                                                                              │
│  Benefits:                                                                   │
│  ✓ Independent scaling and deployment                                        │
│  ✓ Right database for the job                                                │
│  ✓ Strong encapsulation                                                      │
│                                                                              │
│  Challenges:                                                                 │
│  ✗ Data consistency (eventual)                                               │
│  ✗ Cross-service queries                                                     │
│  ✗ Data duplication                                                          │
└──────────────────────────────────────────────────────────────────────────────┘

Resilience Patterns:
┌─────────────────────────────────────────────────────────────────────────────┐
│  Circuit Breaker:                    │  Bulkhead:                           │
│  ┌─────────┐                        │  ┌─────────────────────────────┐      │
│  │ Closed  │◄──Success──┐           │  │ Service A                   │      │
│  └────┬────┘            │           │  │  ┌─────────┐ ┌─────────┐    │      │
│       │ Failure         │           │  │  │ Pool 1  │ │ Pool 2  │    │      │
│       ▼        Recovery │           │  │  │ (Svc B) │ │ (Svc C) │    │      │
│  ┌─────────┐   Timeout  │           │  │  └─────────┘ └─────────┘    │      │
│  │  Open   │────────────┤           │  └─────────────────────────────┘      │
│  └────┬────┘            │           │  If Svc B fails, Svc C unaffected     │
│       │ Half-Open       │           │                                       │
│       ▼                 │           │  Retry with Backoff:                  │
│  ┌─────────┐            │           │  Attempt 1 ──► Wait 100ms             │
│  │HalfOpen │────────────┘           │  Attempt 2 ──► Wait 200ms             │
│  └─────────┘                        │  Attempt 3 ──► Wait 400ms             │
│                                     │  Attempt 4 ──► Wait 800ms             │
│                                     │  Give up after max retries            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading Architecture Diagrams in Interviews

System design interviews at FAANG companies frequently begin with the interviewer asking you to draw or describe a high-level architecture. The topology in this diagram is a direct template for that conversation.

The key habit is to describe each layer's responsibility in one sentence before going deeper. Client layer: multiple client types with different protocols and latency requirements. API gateway: single entry point, cross-cutting concerns, no business logic. Service layer: each service owns its own data and communicates over defined APIs. Messaging layer: asynchronous decoupling for cross-service workflows. Platform layer: shared operational infrastructure.

Junior engineers often skip the messaging and platform layers in interviews because they feel less familiar. This is a mistake. Interviewers at mid-level and above expect you to mention observability, configuration management, and at least the concept of service discovery, even if you do not detail the implementation.

When describing communication patterns: name the pattern first (synchronous request-response or asynchronous event-driven), then name the use cases, then name the tradeoffs. Do not open with the technology. Saying "I'd use Kafka" without first explaining "for async workflows where the caller does not need an immediate response" signals that you are technology-first rather than problem-first.

On the resilience patterns diagram: circuit breaker and bulkhead are the two most commonly tested patterns at entry-level system design. Know the three states of a circuit breaker (closed, open, half-open) and be able to explain the state transition without a diagram.

### Senior @ FAANG: Platform Topology Governance and Control Plane Ownership

The architecture overview diagram represents a target state. The staff-level challenge is governance: how does the organization ensure that every new service conforms to this topology rather than introducing ad-hoc variations?

**Control plane ownership.** The platform team owns the API gateway configuration, the service mesh control plane (Istio pilot or Linkerd proxy-injector), the Consul catalog or Kubernetes endpoint registry, and the OTel collector fleet. Application teams own their services. The contract between them is a published platform interface: a Helm chart template with mandatory fields, a required health check endpoint spec, a mandatory OTel initialization path, and a required Consul/Kubernetes registration format. Services that bypass this interface must submit a design exception, reviewed by the platform team, before deploying to production.

**Topology anti-patterns at scale.** The most common governance failure in large organizations is the "shadow gateway": a team builds a bespoke service that itself routes traffic to backend services, effectively creating an undocumented second gateway with no rate limiting, no auth enforcement, and no observability. The fix is not technical but organizational: make the canonical gateway easy enough to use that teams do not feel the need to route around it. Envoy Gateway with Kubernetes Gateway API resources is the 2026 answer to this, because teams can self-service route declarations without touching the gateway's core configuration.

**Cell-based architecture as a blast-radius control.** Amazon's cell-based architecture partitions services into cells (typically per-region, per-AZ, or per-customer-shard) so that a failure in one cell cannot propagate to others. Implementing this requires the router layer to be cell-aware and requires that services do not maintain state that crosses cell boundaries. In Go, this means designing service clients that are cell-scoped: the `ServiceRegistry` or gRPC resolver knows which cell it is in and prefers local endpoints. Cross-cell calls go through a dedicated cross-cell API with explicit SLA degradation, not the standard request path.

**Data plane observability at L7.** The topology diagram shows Prometheus and Jaeger as platform services, but the operational reality at scale is that L7 traffic observability requires either a service mesh (Istio/Linkerd inject per-request metrics without application code) or eBPF-based instrumentation (Cilium, Pixie) that captures HTTP/gRPC attributes at the kernel level. Staff engineers evaluate these options along three axes: per-request overhead (eBPF wins, typically under 1% CPU), cardinality risk (mesh sidecar metrics are scoped per pod, Prometheus with unbounded label values is a common incident cause), and operational complexity (running an Istio control plane at 10,000+ pods is a non-trivial platform engineering project).

---
