## 58.2 Scalability

### Vertical vs Horizontal Scaling

Vertical scaling adds resources to a single node, more CPU, RAM, or faster storage, and is operationally simple but has hard physical limits and introduces single points of failure. Horizontal scaling distributes load across multiple identical nodes, enabling near-linear capacity growth and fault tolerance, but requires the application to be stateless or to externalize state to shared systems like Redis or PostgreSQL. Go's lightweight goroutine model and efficient memory footprint make it particularly well-suited for horizontal scaling, as a single node can handle thousands of concurrent connections before scaling out becomes necessary.

```
Vertical Scaling (Scale Up):
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   Before:         After:                                │
│   ┌─────┐         ┌─────────────┐                       │
│   │ 4GB │   →     │    64GB     │                       │
│   │ RAM │         │    RAM      │                       │
│   │ 2CPU│         │   32 CPU    │                       │
│   └─────┘         └─────────────┘                       │
│                                                         │
│   Pros: Simple, no code changes                         │
│   Cons: Hardware limits, single point of failure        │
│                                                         │
└─────────────────────────────────────────────────────────┘

Horizontal Scaling (Scale Out):
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   Before:              After:                           │
│   ┌─────┐              ┌─────┐ ┌─────┐ ┌─────┐          │
│   │     │       →      │     │ │     │ │     │          │
│   │ App │              │ App │ │ App │ │ App │          │
│   │     │              │     │ │     │ │     │          │
│   └─────┘              └─────┘ └─────┘ └─────┘          │
│                              │     │     │              │
│                              └─────┴─────┘              │
│                                   │                     │
│                           ┌───────────────┐             │
│                           │ Load Balancer │             │
│                           └───────────────┘             │
│                                                         │
│   Pros: Unlimited scale, fault tolerant                 │
│   Cons: Complex, requires stateless design              │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Database Scaling Strategies

Application servers can scale horizontally with relative ease, but the database is often the first bottleneck because every node writes to the same storage. Read replicas offload the majority of traffic by directing reads to asynchronously replicated copies while writes go only to the primary, useful when reads dominate, but replication lag means replicas may return stale data. Sharding partitions rows across multiple independent databases using a routing key such as `user_id % n`, enabling writes to scale out, but at the cost of making cross-shard joins expensive or impossible. Federation splits tables by domain rather than by row, so the users, products, and orders tables each live on their own database, allowing independent scaling but complicating any query that needs data from more than one domain.

```
1. READ REPLICAS
┌─────────────────────────────────────────────────────────┐
│                                                         │
│        Writes                  Reads                    │
│           │                    /  |  \                  │
│           ▼                   ▼   ▼   ▼                 │
│       ┌───────┐          ┌───┐ ┌───┐ ┌───┐              │
│       │Primary│    →     │ R │ │ R │ │ R │              │
│       │ (RW)  │  async   │   │ │   │ │   │              │
│       └───────┘  replic  └───┘ └───┘ └───┘              │
│                                                         │
│   Use when: Read-heavy workloads (80%+ reads)           │
│                                                         │
└─────────────────────────────────────────────────────────┘

2. SHARDING (Horizontal Partitioning)
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   user_id % 4 = shard                                   │
│                                                         │
│   ┌───────────────────────────────────────────┐         │
│   │              Shard Router                 │         │
│   └─────────┬───────┬───────┬───────┬─────────┘         │
│             │       │       │       │                   │
│             ▼       ▼       ▼       ▼                   │
│         ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                 │
│         │ S0  │ │ S1  │ │ S2  │ │ S3  │                 │
│         │ %4=0│ │ %4=1│ │ %4=2│ │ %4=3│                 │
│         └─────┘ └─────┘ └─────┘ └─────┘                 │
│                                                         │
│   Sharding strategies:                                  │
│   - Hash-based: user_id % num_shards                    │
│   - Range-based: A-F, G-L, M-R, S-Z                     │
│   - Directory-based: Lookup table                       │
│                                                         │
└─────────────────────────────────────────────────────────┘

3. FEDERATION (Functional Partitioning)
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   Different databases for different functions:          │
│                                                         │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│   │  Users   │  │ Products │  │  Orders  │              │
│   │    DB    │  │    DB    │  │    DB    │              │
│   └──────────┘  └──────────┘  └──────────┘              │
│                                                         │
│   Pros: Independent scaling, isolated failures          │
│   Cons: Cross-function queries complex                  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Stateless Services

A service is stateful when it stores user-specific data, sessions, in-flight request state, cached computation, in its own process memory, which means a load balancer must always route a given user to the same instance (sticky sessions). This creates an uneven distribution of load and makes rolling deployments and instance replacement risky. The fix is to externalize all mutable state to a shared store such as Redis or a database, so any instance can handle any request and instances become fully interchangeable. The contrast below shows exactly what changes: the `sessions` map moves out of the struct and into an injected `SessionStore`, making horizontal scaling a matter of adding instances rather than re-engineering the service.

```go
// Stateless Service Design Pattern
package main

// BAD: Stateful service - stores session in memory
type StatefulService struct {
    sessions map[string]*UserSession // State in memory!
}

func (s *StatefulService) HandleRequest(userID string, r Request) Response {
    session := s.sessions[userID] // Only works on this instance
    return s.process(session, r)
}

// GOOD: Stateless service - stores session externally
type StatelessService struct {
    sessionStore SessionStore // Redis, Memcached, etc.
    db           Database
}

func (s *StatelessService) HandleRequest(userID string, r Request) Response {
    // Get session from external store
    session, err := s.sessionStore.Get(userID)
    if err != nil {
        session = s.sessionStore.Create(userID)
    }

    response := s.process(session, r)

    // Save session back to external store
    s.sessionStore.Set(userID, session)

    return response
}

// With stateless design, any instance can handle any request
// Load balancer can distribute traffic freely
// Easy to scale horizontally
```

### Junior → FAANG: Scaling Vocabulary and Interview Patterns

A common mistake in early-career system design interviews is reaching for horizontal scaling immediately for everything. The right answer is usually: "scale vertically first until a specific, measurable limit is reached, then add horizontal scaling for the tier that is actually the bottleneck."

The stateless service pattern is one of the most important concepts to demonstrate. In an interview, when you say "I would horizontally scale the application tier," the follow-up is always: "how do you handle sessions?" If you have not already explained that sessions are stored externally in Redis, the interviewer will ask. Getting ahead of that question by proactively explaining why your service is stateless and what external store holds each type of mutable state signals engineering maturity.

A concrete prerequisite gap for many junior candidates: understanding why sharding by a user attribute can create hot spots. The canonical example is a celebrity problem, where a small number of accounts (a famous seller, a viral post author) have orders of magnitude more activity than the average user. Hash-based sharding on `user_id` concentrates all of that activity on one shard. Being able to name this problem and at least one mitigation (sharding on a different key, directory-based routing for power users) will differentiate you from candidates who know sharding conceptually but not operationally.

First-job habit: when a new feature is being designed at your current company, ask which scaling strategy is being assumed. Is it read-heavy or write-heavy? Stateless or stateful? Documenting the answer, even in a comment in the design doc, builds the habit of making these decisions explicit rather than leaving them as assumptions that will surface later as incidents.

### Senior @ FAANG: Scaling Architecture Governance and Platform Thinking

At L6 and above, scaling decisions are not made for a single service. They are made for a platform, and the decisions you make for your platform constrain every team that builds on top of it.

**Stateless service enforcement at the platform layer.** A mature engineering organization does not rely on each team to independently remember to externalize session state. Instead, the deployment platform (Kubernetes, internal PaaS) enforces it structurally. Application containers are expected to be killed and replaced at any time without data loss, which surfaces statelessness violations immediately in CI. Sticky-session load balancing is not available in the platform by default, so teams cannot accidentally depend on it. At the staff level, you either own the platform that enforces these constraints, or you design your services so they comply, and you document the compliance so audits are fast.

**Sharding strategy as an ADR with a migration plan.** Every sharding decision should include a documented answer to: what happens when we need to add shards? Hash-based sharding with a fixed modulus is particularly expensive to rescale because every record has to be moved. Consistent hashing avoids most of the redistribution cost, but it requires a routing layer. Directory-based sharding is the most flexible but adds an additional network hop and a new failure point (the directory service itself). At L6, you choose and document the strategy with the migration path included. At L7, you build the tooling that makes the migration executable without downtime.

**Federation and microservice boundary alignment.** Functional partitioning (federation) aligns naturally with microservice ownership: if the Orders team owns the orders database, and the Products team owns the products database, the federation is already in place. The failure mode is when queries span federation boundaries at high frequency, a team that joins orders to products in application code on every request has effectively created a distributed join with N+1 query semantics and the operational complexity of two databases. At the staff level, you identify these patterns during design review, not after the service is in production.

**Read replica replication lag as a capacity planning input.** When a system depends on read replicas, replication lag must be modeled in capacity planning. If a Postgres primary receives 10,000 writes per second and each replica can apply 8,000 writes per second, the replica will fall behind by 2,000 rows per second during peak traffic. After a 30-minute peak, that is 3.6 million rows of lag. The reads from that replica during those 30 minutes are up to 30 minutes stale. This is not a disaster if the data is a social media feed. It is a serious problem if the data is inventory counts or account balances. An L6 engineer builds the monitoring that makes lag visible. An L7 engineer sets the organizational policy that determines which data types are allowed to use replicas at all.

---
