## Core Concepts Recap

This chapter implemented three BFF services (web, mobile, and admin), each with distinct response shapes, caching strategies, and authorization requirements, all built on shared downstream service clients with circuit breakers and parallel fan-out.

### Key Takeaways

1. **One BFF Per Frontend Type**: Create dedicated backends for web, mobile, admin, etc.

2. **Aggregate and Transform**: BFFs aggregate data from multiple services and transform responses for their specific client.

3. **Shared Clients, Custom Logic**: Share service clients across BFFs but implement client-specific aggregation.

4. **Cache Strategically**: Different TTLs for different data types (static, semi-static, user-specific).

5. **Graceful Degradation**: Return partial data when some services fail rather than complete failure.

6. **Team Ownership**: Frontend teams can own their BFF, enabling faster iteration.

### When to Use BFF

- Multiple distinct frontend applications
- Different data shape requirements
- Mobile apps needing bandwidth optimization
- Different authentication per client
- Frontend teams wanting API autonomy

### Trade-offs

| Benefit | Cost |
|---------|------|
| Client-optimized responses | More services to maintain |
| Frontend team autonomy | Code duplication risk |
| Independent deployment | Coordination overhead |
| Tailored caching | More infrastructure |

### Junior -> FAANG: Consolidating the Mental Model

The summary above is the BFF cheat sheet. If you can speak to each takeaway fluently in an interview, you have covered the pattern at the entry level.

The most important single sentence from the summary for interviews is: "Frontend teams can own their BFF, enabling faster iteration." This captures the organizational benefit that makes BFF worth its operational cost. BFF is not just a technical pattern. It is a team topology decision that aligns service ownership with client knowledge.

For your first technical interview at a FAANG company, prepare to draw the architecture diagram (client, API gateway, BFFs, downstream services), explain what logic lives in each layer, and describe the parallel fan-out with partial failure tolerance. Practice this until you can do it on a whiteboard in under five minutes without hesitation.

The trade-offs table above is the honest version of BFF. When asked "what are the downsides of BFF?", use it. Interviewers are testing whether you can think critically about patterns, not just recite their benefits.

### Senior @ FAANG: Evaluating BFF Maturity in an Existing System

At senior level, the summary becomes an evaluation rubric for an existing BFF deployment, not just a description of what good looks like.

When joining a team that already uses BFFs, audit the system against these takeaways in the first week. Are BFFs genuinely one per frontend type, or have they drifted into shared services with multiple teams committing to the same codebase? Are shared service clients actually shared, or has each BFF team written their own version of the product client? Is caching applied at the correct granularity, or are there endpoints that cache user-specific data at shared keys? Is graceful degradation implemented consistently, or do some aggregators still return 500 on first upstream failure?

The answers to these questions define the technical debt backlog for the BFF platform. Prioritize the work by reliability impact: N+1 service calls (high impact, often fixable in a sprint), missing circuit breakers (high impact, usually a shared library fix), incorrect cache key granularity (medium impact, requires careful migration), and missing partial failure handling (medium-to-high impact depending on which services are involved).

At L7, the summary's trade-offs table is the input to a quarterly architecture review. The "more services to maintain" cost should be quantified: how many BFF deployments exist, what is the total p99 latency of the BFF tier, what fraction of incidents involve BFF logic versus upstream services? These metrics tell you whether the BFF architecture is paying for itself in terms of delivery speed and reliability, or whether consolidation, elimination of thin BFFs, or migration to GraphQL Federation would improve the overall system. The trade-off is not static. It changes as the product and team evolve. Senior engineers revisit it deliberately rather than treating the initial BFF adoption decision as permanent.

---
