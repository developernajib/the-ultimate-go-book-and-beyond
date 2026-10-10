## 52D.5 What Is Event Sourcing?

### Events as the Source of Truth

In a traditional application, the database stores the **current state** of the domain. When an order is canceled, you `UPDATE orders SET status = 'canceled'`. The previous state - that the order was once "pending", then "confirmed" - is gone.

**Event Sourcing** inverts this model. Instead of storing current state, you store the **sequence of events** that led to the current state. The event store contains only `INSERT` operations - no `UPDATE`, no `DELETE`. The current state is derived by replaying the event stream.

```
Traditional Database (stores current state):
  orders table: { id: "order-1", status: "fulfilled", ... }

Event Store (stores history):
  events table:
    { order_id: "order-1", event: "OrderPlaced",    position: 1, data: {...} }
    { order_id: "order-1", event: "OrderConfirmed", position: 2, data: {...} }
    { order_id: "order-1", event: "OrderFulfilled", position: 3, data: {...} }
```

To get the current state, replay the events:
1. Start with an empty `Order`
2. Apply `OrderPlaced` → Order is now "pending" with certain lines
3. Apply `OrderConfirmed` → Order is now "confirmed"
4. Apply `OrderFulfilled` → Order is now "fulfilled" with a tracking number

### The Benefits of Event Sourcing

**Complete audit trail.** You know exactly what happened, when it happened, and in what order. This is often a regulatory requirement in finance, healthcare, and legal domains.

**Temporal queries.** You can reconstruct the state of any aggregate at any point in time. "What was the state of this account on January 15th?" - replay events up to that timestamp.

**Event-driven integration.** The event store is a natural pub/sub bus. Downstream systems subscribe to the event stream. No need to poll for changes.

**Debugging.** When something goes wrong, you can replay the exact sequence of events that led to the problem. No guessing.

**New projections from history.** Add a new read model, replay the entire event history to backfill it. The event store is the canonical source of truth.

### The Costs of Event Sourcing

**Complexity.** Event Sourcing is significantly more complex than traditional CRUD. Think carefully before applying it.

**Query complexity.** You cannot `SELECT * FROM orders WHERE status = 'pending'`. You need projections (read models) for all queries.

**Event schema evolution.** Once events are stored, they are immutable. Changing event schemas requires upcasting strategies.

**Team learning curve.** Most developers are unfamiliar with Event Sourcing. Budget significant time for team education.

**Projection maintenance is forever.** Every query needs a projection, and every projection is code that must be deployed, monitored, rebuilt after bugs, and migrated across schema changes. Oskar Dudycz (event-driven.io) has spent years pushing back on the "Event Sourcing is the default" crowd for this reason. Projections are infrastructure, and infrastructure is liability.

**Temporal bugs are subtle.** If you replay events using today's code, you will compute "what would the balance be today if the current rules had always applied", which is often not what happened historically. Correct temporal queries require either versioned handlers, recorded inputs that were external at the time (tax rates, exchange rates, feature flags), or event payloads that carry the answer rather than the inputs. This is the class of bug that is easy to introduce and hard to notice until audit time.

**Storage grows without natural bounds.** Events are immutable and appended forever. A hot aggregate with 50k events per day adds up fast. You will end up building archival, snapshotting, and stream-split strategies whether you wanted to or not.

> **Senior track**: Greg Young (who introduced CQRS and Event Sourcing in the 2010 paper *CQRS and Event Sourcing*) is blunt in recent talks: Event Sourcing is a tool for domains where the history of decisions is itself a business asset, ledgers, regulatory audit, clinical records, trading systems. If you cannot point to a regulator, a reconciliation team, or a product requirement that needs time travel, you are paying for a feature you will not use. CQRS without Event Sourcing is a much smaller commitment (split read and write models, keep current-state storage on the write side) and covers most of the "my reads and writes have different shapes" use cases.

### Event Sourcing vs Event Streaming

These get conflated constantly. Event **streaming** (Kafka, NATS JetStream, Kinesis) is about moving events between services as a transport. Event **sourcing** is about using events as the system of record for an aggregate. You can do event streaming without event sourcing (most Kafka deployments). You can do event sourcing without Kafka (Postgres as an event store is a common, boring, correct choice). Mixing up these two leads to the distributed monolith that Dudycz keeps warning about: an event bus that looks asynchronous but whose consumers must all be up for the system to function.

### Junior → FAANG: Making the "Events as Source of Truth" Shift Concrete

The hardest part of learning Event Sourcing is unlearning the update-in-place reflex. Every time you want to write `UPDATE orders SET status = 'canceled'`, pause and ask: "what event happened that caused this change?" The answer is always a named, past-tense fact: `OrderCanceled`. That fact carries the data needed to derive the new state. Write the event, not the mutation.

Work through the replay sequence in this section by hand. Start with an empty struct. Apply `OrderPlaced` and write down what fields change. Apply `OrderConfirmed` and write down what changes. Apply `OrderFulfilled` and write down the final state. This exercise makes the `apply()` dispatcher and state mutation methods in the next section feel obvious rather than magical.

The costs list is where juniors underestimate Event Sourcing. "Projection maintenance is forever" is not a metaphor. Every query your service needs to answer requires a projection. When a new product feature needs a new query, you need a new projection, which means new code, a new rebuild procedure, new monitoring, and new operational runbooks. This multiplies the cost of feature development in ways that are not visible on day one.

The temporal bug note is subtle but interview-critical. If you replay historical events through today's code, and today's code implements different business rules than yesterday's, the replay produces an answer different from what actually happened. This is the class of bug that fails regulatory audits. Know it exists and be able to explain it in two sentences.

For FAANG entry-level interviews: be able to describe Event Sourcing versus traditional state storage, list three benefits (audit, temporal queries, new projections), list three costs (complexity, projection maintenance, schema evolution), and name one domain where it is clearly appropriate (financial ledger) and one where it is clearly overkill (user preferences). That coverage is enough for an entry-level bar.

### Senior @ FAANG: The Decision Framework and Operational Reality

The "senior track" callout in this section (Greg Young's position) is a temperature check for where you stand on Event Sourcing adoption. Young's framing is the current pragmatic consensus: Event Sourcing is a tool for domains where the history of decisions is a business asset, not a default architecture. If you are evaluating Event Sourcing for a service, the test is: can you point to a specific stakeholder (regulator, reconciliation team, fraud analyst, auditor) who needs the history? If not, you are paying the costs without capturing the benefits.

The "storage grows without natural bounds" cost deserves a capacity planning exercise that most teams skip. Estimate: how many events per day for this aggregate, at what average payload size, over what retention period? Multiply and add 40% overhead for indexes and TOAST. For a banking service with 1 million transactions per day at 500 bytes per event, that is 500 MB per day, 15 GB per month, 180 GB per year, before replication. At three-year retention, you are looking at 540 GB for the event store alone. This is manageable but not free, and the number is due diligence every team should do before committing to Event Sourcing.

The event streaming versus event sourcing distinction has a governance consequence. If your organization uses Kafka as the integration backbone, teams often conflate "we publish to Kafka" with "we do Event Sourcing." These are completely different. Publishing to Kafka is durable async messaging. Event Sourcing means Kafka (or your event store) is the system of record: the aggregate's current state is computed by replaying events, not stored in a database. Most Kafka-using systems are not doing Event Sourcing: they have a primary database, emit change events to Kafka for integration, and the Kafka topic is not the source of truth. Clarifying this distinction in architecture reviews prevents teams from inheriting Event Sourcing complexity they did not intend to sign up for.

The temporal bug class deserves a formal treatment in your team's runbook. The three categories of temporal correctness risk are: (1) replay-time rule drift (today's code applies different rules than the code that ran historically), (2) external state dependency (the aggregate's behavior depended on an external value like an exchange rate that is no longer available), and (3) clock skew (events recorded with system time rather than business time diverge from wall-clock history under replay). Each has a mitigation: (1) immutable event handlers per schema version, (2) recording external values in the event payload, (3) using business timestamps not system timestamps for domain time. An architecture decision that ignores all three and plans to "replay later if needed" is carrying undocumented technical debt.

---
