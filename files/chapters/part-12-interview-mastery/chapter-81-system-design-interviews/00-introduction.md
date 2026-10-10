# Chapter 81: System Design Interviews

> *"All architecture is design but not all design is architecture. Architecture represents the significant design decisions that shape a system, where significance is measured by cost of change."*
> - Grady Booch

System design interviews are the great equalizer in the FAANG hiring process. Unlike coding interviews where a correct solution is objectively verifiable, system design interviews are open-ended explorations where there is no single right answer - only better and worse trade-offs, more and less complete coverage, and stronger and weaker justifications. For senior engineers (L5/L6 at Google and Meta, SDE II/III at Amazon), system design is often the most heavily weighted interview in the loop. A candidate who aces every coding problem but struggles to design a scalable URL shortener or a distributed notification system will not receive an offer at these levels. Conversely, a strong system design round can overcome a mediocre coding performance, particularly at staff-level and above.

Go engineers have a natural advantage in system design interviews - if they use it. Go is the language of distributed systems infrastructure: Docker, Kubernetes, Prometheus, etcd, CockroachDB, and Consul are all written in Go. When you discuss microservices, gRPC, service meshes, or distributed consensus in a system design interview, you can speak from genuine experience with the tooling rather than abstract theory. You understand goroutine-based concurrency models and can reason about how they affect service design. You have likely worked with Go's `net/http`, `context`, and `sync` packages in ways that inform your thinking about connection pools, request cancellation, and rate limiting. This chapter teaches you to make that experience visible and credible during the interview.

This chapter provides a structured, repeatable framework for system design interviews: the ACED framework (Architecture → Components → Extensibility → Deep Dive). Applied to the canonical system design problems - URL shortener, Twitter feed, WhatsApp, Uber, Netflix, Google Search, distributed key-value store - this framework ensures you cover the required ground (requirements, capacity estimation, API design, data modeling, component architecture, scalability, reliability, observability) without getting lost in a single rabbit hole. Each section connects abstract design principles to concrete Go implementation choices, making your design discussions grounded and specific rather than generic and hand-wavy.

**What you'll learn in this chapter:**

- The ACED framework for structuring any system design interview in 45 minutes: requirements → capacity → architecture → deep dive
- Back-of-envelope estimation: QPS, storage, bandwidth calculations using the 10x powers-of-ten method interviewers expect
- Designing the data layer: SQL vs NoSQL selection criteria, sharding strategies (range, hash, directory), and replication patterns
- Scaling the application layer: stateless services, horizontal scaling, load balancing algorithms, and session management
- Caching strategies: cache-aside vs write-through vs write-behind, eviction policies, CDN integration, and cache stampede prevention
- Message queues and event-driven architecture: when to use Kafka vs RabbitMQ vs SQS, partition strategies, at-least-once delivery
- Consistency and availability trade-offs: CAP theorem applied, eventual consistency patterns, distributed transactions (saga, 2PC)
- Go-specific design discussion: how goroutine pools, gRPC, and Go's concurrency primitives influence service architecture decisions

**How to use this chapter:**

Start with the ACED framework section and commit it to memory - this is your scaffolding for every design interview. Then work through each canonical system design problem using the framework, timing yourself to complete the full design in 40-45 minutes. After each practice run, score yourself against the rubric provided at the end of each problem section. Pay special attention to the "what interviewers are listening for" callout boxes, which document the specific signals (trade-off articulation, failure mode awareness, scalability reasoning) that distinguish pass from fail at each FAANG company. Use the Go-specific integration sections to prepare 2-3 concrete examples from your own experience that you can reference naturally in the interview. Aim for five complete timed practice runs before your first system design screen.

**Prerequisites:** Chapter 80 (Technical Interview Prep), working knowledge of REST APIs and databases from Parts 7-9 of this book, and familiarity with at least one cloud provider (AWS, GCP, or Azure) at the services level.

---

### Junior → FAANG: What System Design Actually Tests

The single biggest misconception junior candidates have about system design interviews is that the interviewer is looking for the correct answer. There is rarely a single correct answer in a 45-minute design session. The interviewer is evaluating your reasoning process: how you decompose a large problem, how you handle ambiguity, how you justify decisions, and whether you recognize trade-offs without being told to look for them.

Prerequisites gap: before practicing system design, make sure you have solid concrete knowledge of the following components, not just their names: how consistent hashing distributes load, what a message queue buys you over direct HTTP calls, the difference between a read replica and a primary database, and why a CDN reduces latency for static assets. Candidates who name components without being able to explain their mechanics get stuck when interviewers probe with "why did you choose that?"

First interview habit: for every component you draw in a design, be ready to answer "why this and not X?" where X is a reasonable alternative. Practice this explicitly by drawing a design, listing three components, and forcing yourself to generate the "why not the alternative" answer for each one.

### Senior @ FAANG: System Design as Organizational Architecture

For senior candidates, system design interviews are a proxy for how you will approach real architecture decisions at the company. The bar is not "can you design a URL shortener" but "do you design with the cost of change in mind," which is exactly what the Grady Booch quote at the top of this chapter signals.

At L5/L6, the interviewer is watching for: do you scope the problem before designing (or do you start drawing immediately), do you acknowledge what you are leaving out and why (scope management), do you discuss the operational implications of your design (monitoring, deployment, rollback), and do you consider the data model as a first-class design concern rather than an afterthought.

ADR framing applied to system design: treat the design session as a real-time ADR. "I am choosing Cassandra here for its write throughput and multi-region replication. The trade-off is eventual consistency for reads, which is acceptable because the requirement is read-your-writes within a session, not global consistency. The alternative would be a PostgreSQL cluster with a read replica, but that limits write throughput to a single primary." This framing demonstrates that you make decisions with documented reasoning, which is the L6 production engineering standard.

Platform thinking at L7: staff engineers think beyond the single system being designed to ask "how does this system integrate with the platform's existing reliability patterns, security controls, and observability infrastructure?" A staff-level answer to a system design question includes a comment about service mesh integration, standard SLO definition, and how new components will be onboarded to the existing incident management system.
