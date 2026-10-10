## 52D.1 Why CQRS?

### The Fundamental Tension

Every significant application eventually faces a contradiction. The model that is optimal for writing data is not the same model that is optimal for reading data.

Consider a bank account. For writing, you need strong consistency, transactional guarantees, and domain rule enforcement. When money is transferred, you need to verify the sender has sufficient funds, debit the sender, credit the recipient, and record both operations atomically. The aggregate - the `Account` - is the right model. It enforces invariants. It uses optimistic concurrency.

For reading, a customer opening their banking app wants to see:
- Current balance (a single number)
- Recent transactions (a chronological list)
- Monthly spending by category (an aggregation)
- Pending transactions (a filtered subset)

Loading the full `Account` aggregate and computing all this information on every request is wasteful. The aggregate is designed for consistency, not for query flexibility. A well-designed aggregate is small - it only contains what it needs to enforce invariants. But a well-designed read model for a banking dashboard is denormalized, aggregated, and pre-computed.

**CQRS - Command Query Responsibility Segregation** - resolves this tension by splitting the system into two models:

- The **Command Model** (write side): the DDD domain model with aggregates, repositories, and domain events. Optimized for correctness and consistency.
- The **Query Model** (read side): denormalized read models optimized for specific query patterns. Can be rebuilt from domain events at any time.

### The CQRS Spectrum

CQRS is not binary. There is a spectrum of implementation:

**Level 1: Separate methods, shared model.** Commands and queries use different code paths but the same underlying data model. The simplest form - just ensure read methods don't mutate state (enforced by naming convention or interface separation).

**Level 2: Separate code, shared database.** Commands use the aggregate/repository model. Queries use direct SQL against the same database, optimized with views or denormalized tables. The database is still shared.

**Level 3: Separate models and separate stores.** Commands write to the primary store (PostgreSQL). A projection process reads events and populates a separate read store (PostgreSQL read replicas, Elasticsearch, Redis). The read and write stores are different databases optimized for their respective workloads.

Level 3 is what most people mean when they say "CQRS". It is the most powerful but also the most complex. Start with Level 2 and evolve to Level 3 when you have clear evidence you need it.

### When to Use CQRS (and When It Is Overkill)

**Use CQRS when:**

- Read and write workloads have very different scale characteristics (e.g., 100x more reads than writes)
- Query patterns are complex, diverse, or change frequently
- You need to expose the same data in fundamentally different shapes for different consumers
- You are already using Event Sourcing (they compose naturally)
- You need a complete audit trail and the ability to replay history
- You are working in a collaborative domain where multiple users change the same data concurrently

**Do NOT use CQRS when:**

- The application is primarily CRUD with simple queries
- The team is small and the additional complexity would slow development
- Eventual consistency would violate a hard business requirement (e.g., the user must see their own write immediately)
- You are in the early stages of a product and the domain is still being discovered

### CQRS Without Event Sourcing

A critical framing that most tutorials skip: CQRS and Event Sourcing are separate decisions. You can adopt CQRS without ever touching an event store. The write side keeps current-state storage (a normalized Postgres schema, updated in place), and a projector maintains denormalized read tables driven by domain events emitted on commit. This covers the overwhelming majority of "my reads and writes want different shapes" use cases at a fraction of the operational cost: no replay-time bugs, no snapshots, no event schema evolution, no temporal queries. Greg Young has made this point repeatedly in recent talks, CQRS is not Event Sourcing, and treating them as a package deal is how teams end up with Event Sourcing they do not need.

The decision tree is: do you need CQRS? (yes if read/write shapes diverge, no otherwise). Independently: do you need Event Sourcing? (yes if history-of-decisions is a business asset: ledgers, audit, clinical records, trading. No otherwise). Most systems land on "CQRS yes, ES no", and that is a perfectly valid endpoint.

> **Senior track**: Oskar Dudycz (event-driven.io) argues that the real failure mode is adopting Event Sourcing as a default architecture rather than as a solution to a specific problem. His pragmatic position: start with current-state storage, split read and write models when the shapes diverge, and only reach for Event Sourcing when you can point to a regulator, a reconciliation team, or a product requirement that needs the full history. Anything else is paying upfront complexity for a feature you will never use.

### CQRS + DDD Synergy

CQRS and DDD reinforce each other powerfully:

- DDD aggregates are the command model: small, focused, consistency-enforcing
- Domain events produced by aggregates are the source of truth for the query model
- The Ubiquitous Language appears in command names (`PlaceOrder`, `CancelOrder`) and in query model names (`OrderSummaryView`, `CustomerDashboardView`)
- Bounded contexts naturally separate into command-heavy services (order processing) and query-heavy services (reporting, search)

### Junior → FAANG: Understanding the Motivation Before You Touch Code

The "why" section is the most important part of any pattern chapter. If you understand why CQRS exists, you can derive the implementation yourself. If you only memorize the implementation, you will misapply it.

The bank account example is worth internalizing completely. Take a piece of paper and write out two lists: everything the write side needs (invariant enforcement, transaction boundaries, optimistic concurrency, domain rule validation) and everything the read side needs (fast response, denormalized data, flexible filtering, no joins). The lists share almost nothing. That mismatch is why CQRS exists.

The CQRS spectrum (Level 1, 2, 3) is your interview anchor. Most interview candidates describe Level 3 as if it is the only version. Interviewers at FAANG-level companies expect you to know all three levels and to reason about when each is appropriate. A common interview question is: "where on the CQRS spectrum would you start for a new greenfield service?" The correct answer is: Level 2 (shared database, separate models) until you have empirical evidence that you need Level 3. Starting at Level 3 adds operational overhead before you understand your actual query patterns.

The "when not to use" list is your protection against over-engineering. Memorize it and apply it honestly. In your first job, you will encounter teams that want to apply CQRS to every service because it feels sophisticated. Being the engineer who asks "what query patterns actually diverge from write patterns?" is the right instinct, not timidity.

For entry-level FAANG interviews, you should be able to explain the difference between the command model and the query model, give a concrete example of a read model that would be hard to produce from a normalized write schema, and name the trade-off you accept when you split them (eventual consistency).

### Senior @ FAANG: Governing the "When to Use" Decision Across an Organization

The "when to use" lists in this section are easy to nod at but hard to apply consistently across teams. Senior engineers make these decisions for their own systems. Staff engineers make them across systems and put governance in place so that teams do not have to reinvent the decision every time.

The CQRS spectrum is also a maturity spectrum for your organization. Teams that have never done CQRS should start at Level 2, gain experience with projection patterns, understand projection lag in production, and earn their way to Level 3 when they have a concrete scaling problem. An organization that mandates Level 3 for all new services regardless of traffic patterns has confused architectural sophistication with business value.

The Dudycz position deserves operational grounding. "CQRS without Event Sourcing" means: write side uses a normalized schema with in-place updates, domain events are emitted in the same transaction via the outbox pattern, a projector reads those events and maintains denormalized read tables. This is significantly simpler than full Event Sourcing: no replay-time bugs, no snapshot strategy, no event schema upcasting, no temporal query correctness concerns. The operational surface area is a projector process and a few extra tables, not a full event store. For the 80% of systems that need read/write shape separation but not full audit history, this is the correct answer.

Bar-raiser interview signal: a staff candidate describing CQRS should be able to explain the read-your-writes problem concretely (what breaks when a user reads from a lagging projection immediately after their own write), name at least two mitigation strategies (return the new state from the command response, version tokens for causal consistency), and discuss which mitigation their team actually implemented and why. Generic answers about "eventual consistency is acceptable" without product context are a yellow flag at L6.

The DDD synergy point has a governance implication: bounded context boundaries and CQRS boundaries often coincide, but they are not the same thing. A single bounded context may have multiple CQRS read models. Multiple bounded contexts may share a query-side infrastructure. Conflating these boundaries creates confusion about ownership: who is responsible for a projection when it aggregates data from two bounded contexts? This is a team topology question as much as an architecture question, and it belongs in the ADR.

---
