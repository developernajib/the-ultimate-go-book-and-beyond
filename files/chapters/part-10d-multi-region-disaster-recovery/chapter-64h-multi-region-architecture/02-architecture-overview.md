## Architecture Overview

The diagram below shows how all the components in a multi-region system fit together. At the top sits a global tier responsible for routing users to the right region using GeoDNS, Anycast BGP, and a health controller that scores each region's readiness. Below that, each region runs its own application cluster, load balancer, PostgreSQL database, and Redis session store. At the bottom, a cross-region replication bus powered by Kafka, CRDTs, and vector clocks keeps data synchronized across all regions while resolving conflicts that arise from concurrent writes.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     GLOBAL MULTI-REGION ARCHITECTURE                         │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐    │
│   │                      GLOBAL TIER                                    │    │
│   │                                                                     │    │
│   │   ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │    │
│   │   │   GeoDNS     │    │   Anycast    │    │  Global Health       │  │    │
│   │   │   Resolver   │    │   BGP Router │    │  Controller          │  │    │
│   │   │  (Route 53)  │    │  (Cloudflare)│    │  (Region Scoring)    │  │    │
│   │   └──────┬───────┘    └──────┬───────┘    └──────────┬───────────┘  │    │
│   │          │                   │                        │             │    │
│   └──────────┼───────────────────┼────────────────────────┼─────────────┘    │
│              │                   │                        │                  │
│   ┌──────────▼───────────────────▼────────────────────────▼─────────────┐    │
│   │                    REGIONAL TIER                                     │   │
│   │                                                                      │   │
│   │  ┌─────────────────────────┐   ┌─────────────────────────────────┐  │    │
│   │  │     REGION: us-east-1   │   │      REGION: eu-west-1          │  │    │
│   │  │  (PRIMARY / ACTIVE)     │   │      (ACTIVE)                   │  │    │
│   │  │                         │   │                                 │  │    │
│   │  │  ┌─────────────────┐    │   │  ┌─────────────────────────┐    │ │     │
│   │  │  │  App Cluster    │    │   │  │  App Cluster            │    │ │     │
│   │  │  │  (3x instances) │    │   │  │  (3x instances)         │    │ │     │
│   │  │  └────────┬────────┘    │   │  └──────────┬──────────────┘    │ │     │
│   │  │           │             │   │             │                   │  │    │
│   │  │  ┌────────▼────────┐    │   │  ┌──────────▼──────────────┐    │ │     │
│   │  │  │  Regional LB    │    │   │  │  Regional LB            │    │ │     │
│   │  │  │  (Envoy/NGINX)  │    │   │  │  (Envoy/NGINX)          │    │ │     │
│   │  │  └────────┬────────┘    │   │  └──────────┬──────────────┘    │ │     │
│   │  │           │             │   │             │                   │  │    │
│   │  │  ┌────────▼────────┐    │   │  ┌──────────▼──────────────┐    │ │     │
│   │  │  │  PostgreSQL     │◄───┼───┼──│  PostgreSQL             │    │ │     │
│   │  │  │  Primary        │───►│   │  │  Replica (Patroni)      │    │ │     │
│   │  │  │  (Patroni)      │    │   │  │                         │    │ │     │
│   │  │  └────────┬────────┘    │   │  └─────────────────────────┘    │ │     │
│   │  │           │             │   │                                 │  │    │
│   │  │  ┌────────▼────────┐    │   │  ┌─────────────────────────┐    │ │     │
│   │  │  │  Redis Cluster  │◄───┼───┼──│  Redis Cluster          │    │ │     │
│   │  │  │  (Session Store)│    │   │  │  (Session Store)        │    │ │     │
│   │  │  └─────────────────┘    │   │  └─────────────────────────┘    │ │     │
│   │  └─────────────────────────┘   └─────────────────────────────────┘  │    │
│   │                                                                      │   │
│   │  ┌─────────────────────────┐   ┌─────────────────────────────────┐  │    │
│   │  │   REGION: ap-east-1     │   │   REGION: ap-southeast-1        │  │    │
│   │  │   (ACTIVE)              │   │   (ACTIVE / DR Standby)         │  │    │
│   │  │   [Mirror of eu-west]   │   │   [Mirror of ap-east]           │  │    │
│   │  └─────────────────────────┘   └─────────────────────────────────┘  │    │
│   └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   ┌──────────────────────────────────────────────────────────────────────┐   │
│   │              CROSS-REGION REPLICATION BUS                            │   │
│   │                                                                      │   │
│   │  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐   │   │
│   │  │  Kafka       │  │  CRDTs       │  │  Vector Clock             │   │   │
│   │  │  (MSK Global)│  │  Conflict    │  │  Conflict Resolution      │   │   │
│   │  │              │  │  Resolution  │  │                           │   │   │
│   │  └──────────────┘  └──────────────┘  └───────────────────────────┘   │   │
│   └──────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

### Junior -> FAANG: Reading Architecture Diagrams Strategically

Architecture diagrams in FAANG interviews are communication tools, not blueprints. When you draw one on a whiteboard, the interviewer is looking for three things: does the candidate know which components belong at the global tier versus the regional tier, do they show data flow arrows in both directions (not just the happy path), and do they call out where consistency boundaries are.

In the diagram above, the critical boundary is between the global tier and the regional tier. The global tier makes routing decisions. The regional tier executes them. The cross-region replication bus is the consistency mechanism. Each of these boundaries is a potential failure point that an interviewer will probe: "What happens if the Kafka replication bus is partitioned?" "What happens if the health controller disagrees with GeoDNS about which region is healthy?"

A worked practice drill: reproduce this diagram from memory on paper, then annotate each arrow with the failure mode if that arrow is severed. This exercise teaches you to reason about failure domains rather than just success paths, which is what senior FAANG engineers actually do when reviewing architecture.

### Senior @ FAANG: Architecture as a Living Document with Ownership

The diagram in this section shows the ideal steady-state architecture. At L6+, you are responsible for keeping the actual architecture aligned with the documented one. That alignment decays naturally as teams make tactical changes without updating the diagram. A staff engineer's job includes periodic architecture audits that compare running infrastructure against the canonical diagram.

**Global tier ownership is platform, not application.** The GeoDNS resolver, Anycast BGP routing, and health controller shown in the global tier are typically owned by a platform or SRE team, not application teams. Application teams consume the routing decisions via headers injected by the load balancer. This separation of ownership prevents individual application teams from misconfiguring global routing to fix their local problem and inadvertently breaking routing for everyone else.

**The replication bus is the correctness critical path.** Every consistency guarantee the system offers depends on the Kafka MirrorMaker or MSK Global Replication bus being healthy and current. A staff engineer builds monitoring around replication bus lag as a primary SLA metric, not a secondary one. If the bus is 60 seconds behind, the system's effective RPO is 60 seconds regardless of what the SLA document says. The health controller should factor replication bus lag into its regional health score.

**Cross-region Redis session replication deserves its own diagram.** The session store shown at the regional tier with cross-region replication has a separate consistency model from the application data. Session data has different conflict semantics (last-login-region wins), different TTL management, and different failure modes (session loss forces re-authentication, not data corruption). A principal engineer documents the session consistency model separately from the application data consistency model and maintains both.

**Diagram versioning as a change governance tool.** At platform scale, every topology change (adding a region, changing Redis cluster size, modifying replication lag thresholds) should produce a new version of the architecture diagram committed alongside the infrastructure change. This creates an auditable history of how the system evolved, which is essential during postmortems when you need to know what the topology looked like at the time of an incident.
