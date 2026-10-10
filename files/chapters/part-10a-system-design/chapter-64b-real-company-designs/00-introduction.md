# Chapter 64B: Real Company Designs

*Good engineering is not about writing clever code. It is about building systems that scale, survive failure, and can be understood by the next engineer who inherits them.*

Learning system design patterns in isolation is straightforward. Combining them under real business constraints, user growth, and production incidents is where the difficulty lies. This chapter examines how Netflix, Uber, Slack, Discord, Stripe, and Twitter built their architectures, the iterative systems shaped by outages, trade-offs, and hard lessons rather than the polished versions from conference talks. Netflix adopted chaos engineering after discovering that resilience cannot be verified in staging. Uber rebuilt their dispatch system three times as real-time geospatial matching requirements evolved. Discord replaced their message fanout architecture when it could no longer sustain 19 million concurrent users.

The specific technology choices, Cassandra at Discord, Kafka at Uber, Zuul at Netflix, matter less than the reasoning behind them. What problem was each team solving? What constraints ruled out simpler solutions? What did the first version get wrong, and how did the redesign fix the root cause? These questions make architectural case studies worth studying. You will see how patterns from previous chapters, consistent hashing, event sourcing, CQRS, rate limiting, caching, message queues, combine in production systems handling billions of daily requests.

Go plays an increasing role in these architectures. Uber rewrote core dispatch services in Go for goroutine-based concurrency. Discord runs its gateway on Erlang but uses Go for the API tier. Stripe relies on Go for infrastructure tooling and internal services. Understanding where and why these companies choose Go, and where they do not, provides a practical perspective on language selection as an architectural decision.

**What you'll learn in this chapter:**

- How Netflix decomposed their monolith into microservices and built chaos engineering practices to verify resilience at scale
- Uber's real-time driver-rider matching architecture - geospatial indexing, supply-demand forecasting, and the dispatch service evolution across three major rewrites
- Slack's message fanout architecture for large workspaces and how they solved the "active channel" problem with selective delivery and presence aggregation
- Discord's transition from a MongoDB-based message store to Cassandra and the data modeling decisions that enabled sub-10ms read latency at 100+ billion stored messages
- Stripe's payment processing architecture - idempotency keys, exactly-once charge semantics, and how they designed for correctness-first under distributed failure
- Twitter's timeline architecture - the push-on-write (fanout-on-write) model for most users, the pull-on-read model for celebrities, and the hybrid system that handles both
- Common failure patterns across all six companies - thundering herd, cascading failures, hot partitions, and the architectural safeguards each team deployed in response
- Practical Go implementation sketches for the most instructive components: a WebSocket gateway, a geospatial dispatch index, and an idempotency-key store

**Why this matters at scale:**

These six companies collectively serve billions of users and process trillions of events annually. Their engineering blogs, talks, and published papers form the richest public source of practical distributed systems knowledge. The patterns they developed apply at smaller scales too, because the underlying constraints of networks, disks, and concurrent processes are universal.

**Prerequisites:** Chapters 58-64 (all system design patterns and case studies in this part), plus a strong foundation in distributed systems fundamentals, Go concurrency, and database internals.

---

### Junior -> FAANG: How to Use Company Case Studies in Interviews

The six company architectures in this chapter are frequently referenced in FAANG system design interviews, but rarely in the way candidates expect. Interviewers do not want you to recite Netflix's architecture. They want you to apply the reasoning behind each architectural decision to the problem they have given you.

The correct habit is to extract the pattern behind each technology choice and practice applying that pattern to new problems. Netflix's EVCache teaches multi-zone write-through caching for read-heavy data with AZ-level failover. Uber's S2-cell dispatch teaches spatial indexing as a partitioning strategy for geographically distributed queries. Twitter's hybrid fan-out teaches the write-amplification vs read-latency trade-off that appears in any social graph problem.

When preparing, for each company, be able to answer: what was the problem the original monolith could not solve? What trade-off did the redesign accept to solve it? What failure mode does the new design introduce? Being able to answer the third question without prompting demonstrates a level of understanding that distinguishes candidates who have studied these systems from those who have merely read about them.

### Senior @ FAANG: Why Company Architectures Are ADRs in Disguise

Every major architectural decision in these case studies was made under constraints that are visible in the historical record. Netflix adopted chaos engineering after discovering that resilience could not be tested in staging environments with far fewer nodes than production. Uber rebuilt dispatch three times not because the previous versions were wrong, but because the business requirements changed (new cities, new vehicle types, new matching objectives) faster than the original design could accommodate.

The staff-level skill is reading a current architecture and identifying which constraints it was designed for, and whether those constraints still apply. Netflix's Open Connect CDN was designed when ISP peering agreements made third-party CDN costs prohibitive. Uber's S2-cell-based dispatch was designed when driver density was low enough that a grid-based index was sufficient. Twitter's hybrid fan-out was designed when the threshold between "regular user" and "celebrity" was fixed. As the business evolves, each of these assumptions can change, and the architecture must evolve with them.

The discipline at L6/L7 is institutionalizing this evolutionary awareness: writing ADRs that document not just the decision but the constraints that made it correct, and scheduling periodic reviews of those ADRs to check whether the constraints have changed. An architecture that was correct three years ago under different load, different team size, and different business requirements may be technical debt today.
