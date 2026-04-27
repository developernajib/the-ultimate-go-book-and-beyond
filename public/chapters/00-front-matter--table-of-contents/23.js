export default `## Recommended Reading Paths

This book is big. You don't need to read it all in order. Pick the path below that matches your current goal. Each path builds on the previous one, so you can jump mid-path if you already have the prerequisites.

---

### Go Beginner → Intermediate
*New to Go or coming from another language*

**Path:** Parts I → II → III → IV

| Step | Part | What You'll Learn |
|------|------|-------------------|
| 1 | Part I: Go Mastery | Language fundamentals, types, pointers, interfaces, generics, error handling, idioms |
| 2 | Part II: Concurrency Mastery | Goroutines, channels, sync primitives, context, production concurrency patterns |
| 3 | Part III: Production-Ready Go | Project structure, testing, profiling, observability, deployment, resilience |
| 4 | Part IV: Real-World Applications | Building CLIs, web services, background workers, and file processors end-to-end |

**Time estimate:** 8-12 weeks at 1 hour/day
**Start with:** Chapter 1 → Chapter 2 (Syntax Essentials) if you've never written Go

---

### Backend Engineer
*Build production backend services in Go*

**Path:** Parts I → II → III → V → VI → VII → VIII

| Step | Part | What You'll Learn |
|------|------|-------------------|
| 1 | Part I | Go fundamentals and modern features (iterators, Swiss tables, Green Tea GC) |
| 2 | Part II | Concurrency for high-throughput services |
| 3 | Part III | Production patterns, testing, profiling, and observability |
| 4 | Part V | PostgreSQL, Redis, query builders, migrations, connection pooling |
| 5 | Part VI | REST API design, authentication, validation, rate limiting, versioning |
| 6 | Part VII | gRPC fundamentals, streaming, interceptors, gateway |
| 7 | Part VIII | Microservices, service mesh, event-driven architecture, sagas, API gateway |

**Bonus:** Part V-B (MongoDB/Cassandra/Elasticsearch) and Part V-C (caching strategies) for data-heavy systems
**Build alongside:** Project 1 (URL Shortener), Project 2 (Chat App), Project 3 (E-commerce)

---

### System Design Interview Prep
*Targeted preparation for system design rounds*

**Path:** Part X → Part X-B → Part X-C

| Step | Part | What You'll Learn |
|------|------|-------------------|
| 1 | Part X: System Design | Fundamentals, distributed patterns, consensus, capacity planning |
| 2 | Part X-B: System Design Problems | 20 industry designs (Uber, WhatsApp, Twitter, Netflix, Google Docs, etc.) |
| 3 | Part X-C: Distributed Systems Extended | Advanced consistency, replication, distributed primitives |

**Prerequisite:** Solid understanding of databases, caching, and networking basics (Parts V, VII)
**Time estimate:** 4-8 weeks depending on depth
**Daily practice:** One design problem per day from Part X-B, writing out architecture + trade-offs

---

### Industry Interview Complete
*Full interview preparation: DSA + system design + behavioral*

**Path:** Part XI → Part XII → Part X → Part X-B

| Step | Part | What You'll Learn |
|------|------|-------------------|
| 1 | Part XI: DSA | All major data structures and algorithms in Go, with 150 LeetCode solutions |
| 2 | Part XII: Interview Mastery | Technical interview prep, behavioral, offer negotiation |
| 3 | Part X: System Design | System design fundamentals, distributed patterns, consensus, capacity planning |
| 4 | Part X-B: System Design Problems | 20 industry-scale design problems with complete solutions |

**Time estimate:** 12-16 weeks at 2 hours/day
**Emergency prep:** See the 4-week plan in Chapter 83F

---

### Senior → Staff Engineer
*Grow from senior IC to staff/principal level*

**Path:** Part XIII → Part XIII-B → Part XVI → Part X-C → Part X-D

| Step | Part | What You'll Learn |
|------|------|-------------------|
| 1 | Part XIII: Senior Engineer Mindset | Technical leadership, code reviews, RFCs, ADRs, staff playbook |
| 2 | Part XIII-B: Architecture Patterns | Advanced architecture patterns, event-driven systems |
| 3 | Part XVI: Observability & SRE | Production reliability, SLOs, on-call, incident management |
| 4 | Part X-C: Distributed Systems Extended | Consensus algorithms, CRDTs, advanced distributed patterns |
| 5 | Part X-D: Multi-Region & Disaster Recovery | Global systems, failover, data sovereignty, DR strategies |

**Complementary:** Part XIV (Career Guide) for performance/promotion and negotiation strategy

---

### Already Senior or Staff (Depth Reference)
*You're here for production depth, not interview prep.*

**Path (pick by quarter, not linear):** Part III-B + III-C → Part V-B + V-C → Part VIII-B + VIII-C + VIII-D → Part X-B + X-C + X-D → Part XIII + XIII-B → Part XIV-B

| Step | Part | What You'll Learn |
|------|------|-------------------|
| 1 | Parts III-B, III-C | Million-RPS patterns, Green Tea GC internals, memory and CPU tuning, testing in production, continuous profiling, flight recorder traces |
| 2 | Parts V-B, V-C | Database internals (B+tree / LSM / HNSW), MongoDB / Cassandra / Elasticsearch / DynamoDB / Spanner, caching strategy, CDN invalidation, ETL and data architecture (Kappa, Data Mesh) |
| 3 | Parts VIII-B, VIII-C, VIII-D | DDD bounded contexts, CQRS and event sourcing (honestly scoped), Kafka / RabbitMQ / NATS / Redis Streams, Temporal workflow orchestration |
| 4 | Parts X-B, X-C, X-D | 20 real designs (Uber, WhatsApp, Stock Exchange, LLM Serving), strict serializability vs snapshot isolation, CRDT vs OT, multi-region RPO/RTO |
| 5 | Parts XIII, XIII-B | ADRs at org scale, RFC authoring, staff archetypes, technical strategy |
| 6 | Part XIV-B | Strangler fig, anti-corruption layers, live migration playbooks |

**Skip if pressed for time:** Parts XI (DSA), XII (Interview Mastery), most of Part XIV (career growth is covered through XIII if you're already senior).

**Complementary:** Part XVI-B (observability extended), Part XVII-B (compliance), Part XXI (AI/ML) for LLM-native product surfaces, Part XVIII (C++) if your fleet is polyglot.

---

### Performance / Systems Engineer
*Squeeze latency and cost out of Go services*

**Path:** Part I (6B, 7, 7B, 7D, 10B) → Part II (13, 15) → Part III-B → Part III-C → Part XV-C → Part XX (optional)

| Step | Part | What You'll Learn |
|------|------|-------------------|
| 1 | Part I deep-dive chapters | Modern Go features, scheduler, GC internals, compiler, CGO and SIMD, Go 1.23-1.26 runtime changes |
| 2 | Part II | Sync primitives internals, lock-free structures, memory model |
| 3 | Part III-B: High Performance | Million-RPS Go, Green Tea GC, memory/CPU optimization, PGO, benchmarking with \`b.Loop()\` |
| 4 | Part III-C: Testing at Scale | Testing in production, continuous profiling, flight recorder, flaky-test triage |
| 5 | Part XV-C: Networking | HTTP/2/3, QUIC, mTLS, protocol-level tuning |
| 6 | Part XX: eBPF & Linux Internals | Kernel-level observability, \`bpftrace\`, runtime-level tracing |

---

### DevOps / Platform Engineer
*Infrastructure, observability, and platform engineering with Go*

**Path:** Part XV → Part XV-B → Part XV-C → Part XVI → Part XX (optional)

| Step | Part | What You'll Learn |
|------|------|-------------------|
| 1 | Part XV: Cloud & Infrastructure | Docker, Kubernetes, CI/CD, cloud providers, Terraform, IaC |
| 2 | Part XV-B: DevOps & Platform | GitOps, Helm, platform engineering, container security |
| 3 | Part XV-C: Networking & Protocols | WebSocket, HTTP/2/3, QUIC, protocol internals, network debugging |
| 4 | Part XX: eBPF & Linux Internals | Kernel-level observability, performance, container internals |
| 5 | Part XVI: Observability & SRE | Metrics, tracing, logging, alerting, APM, SRE practices |

**Build alongside:** Project 8 (Kubernetes Controller), Project 9 (Observability Platform), Project 10 (API Gateway)

---

### Security Engineer
*Secure-by-default systems and compliance engineering*

**Path:** Part XVII → Part XVII-B → Part III → Part VIII

| Step | Part | What You'll Learn |
|------|------|-------------------|
| 1 | Part XVII: Security | Application security, cryptography, secrets management, zero-trust, auth |
| 2 | Part XVII-B: Compliance & Regulatory | SOC2, GDPR, PCI-DSS compliance engineering |
| 3 | Part III: Production-Ready Go | Resilience patterns, chaos engineering, graceful degradation |
| 4 | Part VIII: Microservices | Service mesh, mTLS, API gateway security |

---

### AI / ML Engineer
*Integrate ML systems and LLMs into Go services*

**Path:** Part I → Part II → Part XXI

| Step | Part | What You'll Learn |
|------|------|-------------------|
| 1 | Part I + II | Go fundamentals and concurrency (required baseline) |
| 2 | Part XXI: AI & Machine Learning | ML pipelines, LLM integration, vector DBs, AI agents, MCP/A2A protocols |

**Build alongside:** Project 12 (ML Platform) for hands-on model serving and feature stores

---

### Capstone Track
*Learn by building, pick based on your interests*

| Project | Tech Stack | Level |
|---------|-----------|-------|
| 1. URL Shortener | REST, PostgreSQL, Redis | Beginner |
| 2. Real-Time Chat | WebSockets, Redis, PostgreSQL | Intermediate |
| 3. E-Commerce Platform | gRPC, Saga pattern, Elasticsearch | Intermediate |
| 4. Distributed Cache | Consistent hashing, replication | Intermediate |
| 5. Search Engine | Inverted index, BM25, HTTP API | Advanced |
| 6. Social Network | Feed fan-out, Neo4j, Elasticsearch | Advanced |
| 7. CI/CD Platform | Docker, pipelines, artifact storage | Advanced |
| 8. Kubernetes Operator | controller-runtime, CRDs | Advanced |
| 9. Observability Platform | Metrics ingestion, PromQL | Advanced |
| 10. API Gateway | Reverse proxy, rate limiting, plugins | Advanced |
| 11. Data Pipeline | ETL, streaming, Kafka | Advanced |
| 12. ML Platform | Model serving, A/B testing | Expert |
| 13. Trading System | Order matching, WebSocket feeds | Expert |
| 14. SaaS Platform | Multi-tenancy, billing, RBAC | Expert |
| 15. Search Engineering | BM25, learning-to-rank, NDCG | Expert |

Each project includes a step-by-step guide, build one project after every 2-3 parts of reading.

---

*"The only way to learn a new programming language is by writing programs in it."*, Dennis Ritchie

---
`;
