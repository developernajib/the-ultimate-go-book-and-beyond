# Chapter 64H: Multi-Region Architecture - Active-Active, Global Load Balancing, Data Replication

> *"A system that runs in a single region is not highly available - it is a single point of failure with a good uptime record. True resilience requires geography: spreading state, compute, and traffic across regions in a way that no single data center failure can bring down the service."*

Multi-region architecture is the point where distributed systems theory meets geopolitical and business reality. Users in Tokyo should not wait for round trips to Virginia. Regulatory requirements may mandate that European user data never leave EU data centers. Business continuity planning requires that a full regional outage - data center fire, submarine cable cut, cloud provider zone failure - results in seconds of degraded service rather than hours of downtime. Meeting these requirements simultaneously requires careful decisions about topology, data replication strategy, and conflict resolution - decisions that have direct implications for the consistency guarantees your application can provide to its users.

The fundamental choice is between active-active and active-passive topologies. In an active-passive setup, one region handles all writes while others serve reads from a replica, simplifying consistency but creating a single write bottleneck and requiring DNS-based failover during a primary region outage. In an active-active setup, all regions accept writes simultaneously, eliminating the bottleneck and reducing write latency for geographically distributed users - but introducing the possibility of concurrent conflicting writes that must be detected and resolved. The conflict resolution strategy you choose - last-write-wins, application-level merge, or CRDT-based convergence - must match your application's data semantics and acceptable data loss window, typically expressed as Recovery Point Objective (RPO).

Global load balancing adds another layer of complexity. GeoDNS routes users to the nearest region based on their DNS resolver's IP address, but DNS TTLs mean that failover is slow and resolver-cached routing decisions can persist long after a region becomes unhealthy. Anycast routing solves the speed-of-failover problem by advertising the same IP prefix from multiple regions and letting BGP route users to the topologically nearest healthy announcement, but it requires control over BGP routing infrastructure that most application teams do not have. CDN-layer global load balancers - Cloudflare Load Balancing, AWS Global Accelerator, GCP Cloud Load Balancing - combine both approaches with active health checking and sub-minute failover, and integrating with them from a Go service requires understanding their health check protocols, header propagation conventions, and sticky session mechanisms.

**What you'll learn in this chapter:**

- Designing and implementing active-active vs active-passive multi-region topologies with explicit RPO/RTO trade-off analysis
- Building GeoDNS and Anycast-aware global load balancing with latency-based routing and health-check-driven failover
- Implementing cross-region data replication in Go: async replication pipelines, lag monitoring, and replication slot management
- Conflict resolution strategies for multi-leader writes: last-write-wins, vector-clock-based detection, and CRDT merging
- Managing distributed session state across regions with consistency guarantees and cross-region session affinity
- Automating regional failover: health-check-driven traffic shifting, DNS TTL management, and circuit-breaker-based region isolation
- Multi-region PostgreSQL patterns: Citus sharding, Patroni failover automation, and logical replication topologies
- Chaos engineering for regional resilience: injecting region-level failures and validating RTO/RPO targets with automated runbooks

**Why this matters at scale:**

Netflix's active-active multi-region architecture across AWS regions was designed so that a full regional failure causes no user-visible outage - a design validated repeatedly during AWS region incidents. Cloudflare operates in 300+ cities using Anycast routing to direct every user to the nearest data center, making their global network inherently multi-region at its core. GitHub's multi-region architecture, documented after the 2018 database incident, directly informed their investments in CRDT-based conflict resolution for repository metadata. Stripe processes payments across multiple AWS regions with strict consistency requirements enforced through a combination of Raft consensus and multi-region PostgreSQL replication, ensuring that a charge is never both declined and processed.

**Prerequisites:** Completion of Chapters 64D (Advanced Consistency and Replication) and 64E (Distributed Primitives) is strongly recommended. Familiarity with PostgreSQL replication concepts, DNS fundamentals, and basic cloud networking (VPCs, subnets, routing) is assumed.

---

### Junior -> FAANG: Bridging Theory to Multi-Region Architecture Interviews

The biggest prerequisite gap for engineers new to multi-region work is conflating "high availability" with "multi-region." A single-region setup with three availability zones gives you HA against hardware failures. Multi-region gives you resilience against a full data center or cloud region loss. These are different threat models with different architecture implications, and interviewers expect you to distinguish them cleanly.

Start with a worked example: if AWS us-east-1 goes completely offline (as it did in December 2021), a system deployed only in that region is unavailable to all users regardless of how many AZs it uses. A multi-region system continues serving traffic from eu-west-1 or ap-east-1 while us-east-1 recovers. The price is the complexity of keeping those remote regions synchronized.

For entry-level system design interviews, practice explaining the GeoDNS flow: a user in Singapore makes a DNS query, Route 53 sees the resolver IP is from Singapore, and returns the endpoint of the ap-southeast-1 region. The user connects to that region and gets low latency. When ap-southeast-1 fails, Route 53 health checks detect it and stop returning that endpoint, routing traffic to the next closest region. Know the failure mode: DNS TTL means failover can take 30-60 seconds even with Route 53's low-TTL health-checked records.

First-job habit: look up your company's actual RTO and RPO commitments in the SLA documentation before building any feature that touches data. These numbers constrain every architectural decision and your manager will expect you to know them.

### Senior @ FAANG: Chapter-Level Architecture Governance and Trade-off Ownership

This chapter covers the full stack of a multi-region control plane: region registry, geo-routing, traffic shifting, health scoring, CRDTs, replication, PostgreSQL failover, session management, and chaos engineering. At a senior level, each of these is not just an implementation concern but a domain with its own failure modes, operational burden, and organizational ownership questions.

**Active-active write conflict is an organizational problem, not just a technical one.** When two regions both accept writes to the same entity, the conflict resolution strategy (LWW, CRDT, domain merge) must be agreed upon by product engineering, not just platform engineering. Product engineers need to understand that LWW can silently drop writes from users who updated a field milliseconds before another user in another region. At L6+, your role is to bring this trade-off to the product owner as a concrete business question: "If two users update the same shopping cart item within 50ms, which update wins, and is that acceptable?" and then encode the answer as an ADR.

**Health scoring composites require ownership agreements.** The composite health score in this chapter combines HTTP liveness, replication lag, and queue depth. Each weight assignment is a policy decision: how much does replication lag matter compared to HTTP errors? This policy must be owned by an SRE lead and reviewed quarterly, not embedded in code as magic constants. At staff level, you build the framework and write the policy document. You do not silently choose the weights yourself.

**Topology transitions are high-risk change events.** Switching from active-passive to active-active in a running production system is one of the highest-risk changes in platform engineering. It requires a gradual migration: run in shadow mode (active-active routing, active-passive writes) to validate conflict detection before enabling multi-master writes. Document the rollback procedure before starting. The bar-raiser pattern here is proposing a phased plan with explicit validation criteria at each phase, not a big-bang cutover.

**L7 platform concern: topology as a service contract.** At the principal level, the region registry and topology configuration are not internal implementation details. They are a platform API that other teams consume. Any change to topology semantics (adding a region, changing roles) requires a versioned change with downstream consumer notification. Treat the topology as a breaking change surface, the same way you treat a gRPC API.
