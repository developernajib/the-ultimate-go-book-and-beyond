## Core Concepts Recap

### Key Design Principles

1. **Design for failure**: Every network call, disk write, and dependency will eventually fail. Build retries, timeouts, circuit breakers, and fallback paths from the start.
2. **Prefer stateless services**: When no request depends on local process state, any instance can handle any request, and horizontal scaling becomes a configuration change.
3. **Cache with a plan**: Caching improves latency and throughput, but every cached value needs an explicit invalidation strategy, TTL, write-through, or event-based, or stale data will cause subtle bugs.
4. **Decouple through queues**: Message queues let producers and consumers scale independently, absorb traffic bursts, and survive transient downstream failures.
5. **Match consistency to the data**: Financial balances need strong consistency, while social media feeds tolerate eventual consistency. Applying the wrong model wastes latency or risks correctness.

### Quick Reference

The table below condenses the core decision framework from this chapter into a single lookup guide. Each row maps a workload characteristic to the architectural lever that most directly addresses it, read replicas for read-heavy load, sharding for write-heavy load, CQRS when both are under pressure, and circuit breakers plus graceful degradation as the universal safety net when upstream dependencies fail. Use this as a first-pass checklist during system design interviews or early-stage architectural reviews to ensure no major axis (scaling, consistency, latency, availability) is left unaddressed.

```
┌──────────────────────────────────────────────────────────┐
│              SYSTEM DESIGN QUICK REFERENCE               │
├──────────────────────────────────────────────────────────┤
│                                                          │
│ SCALING:                                                 │
│   Read-heavy → Read replicas, caching                    │
│   Write-heavy → Sharding, async processing               │
│   Both → Separate read/write paths (CQRS)                │
│                                                          │
│ CONSISTENCY:                                             │
│   Financial → Strong consistency                         │
│   Social → Eventual consistency                          │
│   Mixed → Tune per operation                             │
│                                                          │
│ LATENCY:                                                 │
│   Static → CDN                                           │
│   Dynamic → Caching, edge computing                      │
│   Real-time → WebSockets, push                           │
│                                                          │
│ AVAILABILITY:                                            │
│   Redundancy at every layer                              │
│   Graceful degradation                                   │
│   Circuit breakers                                       │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Using the Quick Reference in Practice

The quick reference table in this section maps workload type to architectural lever. It is a starting point for interview answers, not a complete design. Use it to get to the right area quickly, then add depth.

For example: "This is a read-heavy workload with high cache hit potential, so my starting point is read replicas and a distributed cache. The cache hit rate I would target is 90% for static data and 70% for dynamic data, which means I need to think carefully about cache invalidation because write-through will add latency to every write." That is a better interview answer than "read-heavy workloads should use caching."

The five design principles in this section are worth memorizing as a checklist to run through before you conclude any system design answer:
- Design for failure: have I named a circuit breaker, retry policy, and fallback for each external call?
- Prefer stateless services: have I said where each piece of mutable state lives?
- Cache with a plan: have I named the invalidation strategy for every cache I proposed?
- Decouple through queues: have I moved any long-running work off the synchronous request path?
- Match consistency to the data: have I said which consistency model each data type uses and why?

Running through this checklist at the end of your design will surface gaps that interviewers would otherwise surface as follow-up questions, and surfacing them yourself is a stronger signal.

### Senior @ FAANG: Summary as a Governance Checklist

At staff level, the quick reference in this section is not a personal interview tool. It is the basis for a team-level architectural review checklist that you apply to every new service or significant feature in your domain.

**Architectural review checklist for distributed systems.** A useful L6/L7 design review asks:
- What is the read/write ratio and has the scaling strategy been matched to it? Is the team planning read replicas for a write-heavy workload, which will not help?
- What is the consistency model for each data type, and is it documented? Is financial data on an eventually-consistent store without explicit justification?
- What is the cache invalidation strategy, and is it tested? Has the team load-tested the cache cold-start behavior?
- Which operations are on the synchronous request path and which are deferred to a queue? Is there a long-running operation that should be async but is not?
- What are the failure modes for each external dependency? Is there a circuit breaker, a timeout, and a fallback?

Running this checklist consistently on every significant design in your domain, not just the ones that feel risky, is one of the single most useful activities a staff engineer performs. It prevents entire categories of incidents rather than responding to them.

**Consistency of principle application across a team.** The hardest part of operating at L7 is not knowing the principles: it is ensuring that every engineer on every team in your domain applies them consistently without you being in every design review. This requires: clear written standards that engineers can reference, tooling that makes violations detectable (linting, policy engines, observability dashboards), and a culture of design review that is educational rather than gatekeeping. A staff engineer who is the only person applying these principles has created a dependency, not a platform.

---
