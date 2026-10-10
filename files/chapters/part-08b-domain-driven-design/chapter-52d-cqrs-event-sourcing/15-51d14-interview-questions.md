## 52D.15 Interview Questions

Each question lists what a FAANG/senior panel is actually listening for, plus the follow-ups you should expect once you give a clean first answer. If you can answer the follow-ups too, you are demonstrating staff-level depth rather than memorized definitions.

### Conceptual

**1. What is CQRS and what problem does it solve? When would you NOT use it?**

*What FAANG expects:* A clear framing that CQRS is about splitting the *models* (not just methods) for reads and writes, and the honest answer that the split has a cost. Weak candidates recite "separate read and write". Strong candidates talk about the spectrum (shared DB with different models, vs separate stores with async projections), cite the tension between write-side invariants and read-side query shapes, and proactively name the cases where CQRS is overkill: simple CRUD, small teams, early-stage product discovery, or hard read-your-writes requirements.

*Follow-ups:*
- Where on the CQRS spectrum would you start a new service, and why?
- How do you keep the read and write models from silently drifting?
- A PM wants "every screen must reflect the last write within 50ms". How does this change your CQRS design, or does it rule it out?

**2. What is Event Sourcing? What are its primary benefits? What are its primary costs?**

*What FAANG expects:* The benefit list is easy (audit, temporal queries, new projections from history, event-driven integration). The cost list is what separates seniors. Expected costs: projection maintenance is forever, temporal bugs are subtle (replaying with today's code does not reproduce yesterday's answer), storage growth, team learning curve, GDPR/erasure pain. Reference Oskar Dudycz's pragmatic position: Event Sourcing is not a default, it is a tool for domains where the history of decisions is itself a business asset.

*Follow-ups:*
- Give a concrete example of a temporal bug that only shows up at audit time.
- Would you use Event Sourcing for a user-preferences service? Defend your answer.
- How do you reason about storage cost for an aggregate that sees 10k events per day for five years?

**3. How does eventual consistency in CQRS affect API design? What strategies do you use to handle it?**

*What FAANG expects:* Recognition that eventual consistency is a product concern, not just a technical one. Strategies: return the new state from the write side on the command response (the aggregate already computed it), read-your-writes via session stickiness or version tokens, optimistic UI with reconciliation on conflict, and explicit UI affordances ("processing...") where the lag is user-visible. A red flag is candidates who try to "hide" eventual consistency behind synchronous APIs and end up reinventing distributed locks.

*Follow-ups:*
- How would you detect projection lag in production? What alerting threshold?
- A mobile client reads from a projection that is 2s behind. Whose problem is that, and how do you divide responsibility between backend and client?
- How does this change for a multi-region deployment?

**4. What is a projection? How do you handle projection failures? How do you rebuild a projection from scratch?**

*What FAANG expects:* A projection is a read model derived from the event stream by an idempotent consumer that tracks a checkpoint. Failure handling: at-least-once delivery plus idempotent apply, dead-letter queue for poison events, and the ability to replay from any checkpoint. Rebuild: stop consumer, truncate target table, reset checkpoint to 0, restart, wait for catch-up. Strong candidates mention blue/green projection tables for zero-downtime schema changes on the read model.

*Follow-ups:*
- What does idempotent apply look like in SQL? Write the UPSERT.
- A projection has been wrong for a week. How do you fix it without taking the read side offline?
- How do you know the rebuild is actually done and correct?

**5. What is the difference between a domain event and an integration event? Why does the distinction matter for event sourcing?**

*What FAANG expects:* Domain events are internal, rich, and coupled to the aggregate's language. Integration events are external contracts, versioned, and simplified. Publishing domain events directly to Kafka is a classic mistake that turns every aggregate refactor into a breaking change for every consumer. Senior answers bring up the anti-corruption layer that translates one into the other, and the outbox pattern to guarantee the translation happens exactly once.

*Follow-ups:*
- Walk through the outbox pattern and why a direct "publish after commit" is broken.
- How do you version an integration event without breaking consumers?
- When would you keep them as the same struct, and why is that usually wrong?

**6. What is a saga? Compare choreography-based and orchestration-based sagas.**

*What FAANG expects:* A saga coordinates a multi-step business workflow across aggregates or services with compensations instead of distributed transactions. Choreography: each service reacts to events, no central coordinator, minimal coupling but hard to reason about end-to-end. Orchestration: a central process manager drives the steps, easier to debug and visualize, but the orchestrator becomes a bottleneck and a single point of change. Staff-level answers note that choreography tends to decay into "what is happening?" and that orchestration, done as an event-sourced process manager, is usually the pragmatic default past 3 steps.

*Follow-ups:*
- Design the compensations for a 4-step booking saga where step 3 fails.
- How do you guarantee the saga itself is durable and resumable after a crash?
- Where does the saga live: the write side, a separate service, or the read side?

### Design

**7. Design an event-sourced `BankAccount` aggregate. What events does it produce? How does it load from history?**

*What FAANG expects:* Events: `AccountOpened`, `MoneyDeposited`, `MoneyWithdrawn`, `AccountFrozen`, `AccountClosed`. The `Apply` methods mutate state, the command methods (`Deposit`, `Withdraw`) validate invariants and call `raise(event)`. `LoadFromHistory` iterates events through `Apply` to rebuild state plus version. Strong candidates explicitly separate the "new event" path (validate invariants, raise, apply) from the "replay" path (apply only, no validation, because history is already valid).

*Follow-ups:*
- Why must `Apply` be pure and total? What happens if it is not?
- How do you express "cannot withdraw more than balance" during replay of a historical `MoneyWithdrawn`?
- Where does the currency check live, and why not in the event?

**8. You have a CQRS system where the read model is lagging 30 seconds behind the write model. How do you diagnose and fix this?**

*What FAANG expects:* A structured diagnosis: measure where the time is going (event publish latency, consumer lag, DB write time on the projection), check for poison events stuck on the DLQ, look at consumer throughput vs event arrival rate. Fixes depend on the cause: partition the stream and add consumers, batch projection writes, move the projection DB to faster storage, or simplify the projection. A red flag is "just scale it up" without measurement.

*Follow-ups:*
- You find one projection is slow, the others are fine. Do you shard or rewrite?
- How do you backfill the 30s of missed updates without double-applying events?
- What SLO would you put on projection lag, and what drives that number?

**9. Design a CQRS + Event Sourcing architecture for a ride-sharing platform's trip management. What events does the Trip aggregate produce? What read models do you maintain?**

*What FAANG expects:* Events: `TripRequested`, `DriverAssigned`, `TripStarted`, `LocationUpdated` (high-frequency, discuss whether this belongs in the event log or a side channel), `TripCompleted`, `TripCanceled`, `FarePaid`. Read models: rider's active trip view, driver's current assignment, heatmap of active trips by region, daily earnings per driver, trip history per rider. Strong candidates push back on storing every GPS ping as a domain event and suggest a separate time-series store referenced from the aggregate.

*Follow-ups:*
- How would you handle surge pricing as events?
- A regulator asks "reconstruct this trip exactly as of 3 months ago". Can you? What did you have to plan for?
- Where does the driver-matching saga live, and what events does it consume and produce?

**10. How do you handle GDPR right-to-erasure in an event-sourced system?**

*What FAANG expects:* You cannot just `DELETE` from an immutable event log. The accepted pattern is crypto-shredding: encrypt personal data with a per-subject key, store only the ciphertext in events, and delete the key on erasure. Events remain but PII becomes unrecoverable. Alternatives: tombstone events plus a compaction step, or a parallel "PII store" keyed by subject that the projections join against. Staff-level answers mention that this must be designed in from day one, retrofitting GDPR onto an existing event store is painful.

*Follow-ups:*
- Which fields count as PII in a financial event? Who decides?
- How does crypto-shredding interact with historical projections that already cached the plaintext?
- What do you tell auditors about the events that still exist but are unreadable?

### Go-specific

**11. Implement an `EventStore` interface in Go. What methods does it need? What optimistic concurrency mechanism does it use?**

*What FAANG expects:*

```go
type EventStore interface {
    Load(ctx context.Context, streamID string) ([]PersistedEvent, int, error)
    Append(ctx context.Context, streamID string, expectedVersion int, events []DomainEvent) error
    LoadSnapshot(ctx context.Context, streamID string) (*Snapshot, []PersistedEvent, error)
}
```

Optimistic concurrency via a unique constraint on `(stream_id, stream_version)`. Append transaction checks the current max version matches `expectedVersion`, inserts events with sequential versions, commits. Unique violation on concurrent append surfaces as a `ConcurrencyError` the handler can retry. Strong candidates also mention the outbox write inside the same transaction.

*Follow-ups:*
- Why `expectedVersion` as a parameter rather than "just insert"?
- How do you test the race without a full integration setup?
- What isolation level, and why?

**12. How would you use Go generics to implement a type-safe command bus?**

*What FAANG expects:*

```go
type CommandHandler[C any] interface {
    Handle(ctx context.Context, cmd C) error
}

type Bus struct {
    handlers map[reflect.Type]any
}

func Register[C any](b *Bus, h CommandHandler[C]) { /* ... */ }
func Dispatch[C any](ctx context.Context, b *Bus, cmd C) error { /* ... */ }
```

The generic parameter gives type safety at registration and dispatch without wrapping every command in `interface{}`. Seniors mention the trade-off: reflection is still needed inside the registry to key handlers by type, so generics give you the API surface but not a fully reflection-free implementation.

*Follow-ups:*
- How do you add middleware (logging, tracing) without losing the generic types?
- How do you return typed results from queries but nothing from commands?
- What breaks if someone registers two handlers for the same command type?

**13. How do you test an event-sourced aggregate without any infrastructure dependencies?**

*What FAANG expects:* The Given-When-Then style: given a list of historical events, when a command is applied, then expect a specific list of new events or a specific error. No DB, no event store, just the aggregate and pure functions. Strong candidates show a small test helper that rehydrates from events, invokes the method, and asserts against `UncommittedEvents()`, and argue this is why the aggregate must not depend on `context.Context`, loggers, or clocks as hidden globals.

*Follow-ups:*
- How do you test time-dependent behavior without `time.Now()`?
- How do you test that replay is deterministic across code versions?
- Show how a property-based test would complement the Given-When-Then cases.

**14. What is the snapshot pattern and how do you implement it in Go without coupling the domain to the infrastructure?**

*What FAANG expects:* The aggregate exposes a `TakeSnapshot() Snapshot` method returning a pure data struct, plus a `LoadFromSnapshotAndHistory(snap, events)` constructor. The infrastructure decides when to snapshot (every N events, time-based, out-of-band) and how to serialize. The domain does not know about JSON, Postgres, or TTLs. Senior answers stress that snapshots are a cache, the event log is still the system of record, and schema-versioned snapshots must fall back to full replay on mismatch.

*Follow-ups:*
- A snapshot format change ships. How do you roll it out safely?
- Would you ever delete old snapshots? When?
- How do you prove, in a test, that load-from-snapshot and load-from-full-history produce the same aggregate?

### Junior → FAANG: How to Use This Question Set

Interview questions in this section are stratified: some are knowledge questions (can you define CQRS?), some are judgment questions (when would you NOT use Event Sourcing?), and some are design questions (design a BankAccount aggregate). Know which kind you are answering and calibrate your depth accordingly.

For knowledge questions, aim for one clear sentence of definition followed by one concrete example. "CQRS separates the models for reads and writes. On the write side, the `Account` aggregate enforces invariants. On the read side, a denormalized `account_balance_views` table serves queries directly without loading the aggregate." That is a complete answer to "what is CQRS?"

For judgment questions, the interviewers are testing whether you know the costs, not just the benefits. Whenever you describe a pattern, immediately follow with: "and the cost is..." Candidates who only describe benefits are perceived as junior. Candidates who name the costs without prompting, and describe when the costs outweigh the benefits, are perceived as senior.

For design questions, structure your answer as a sequence: events first, then state, then methods, then `apply`, then `LoadFromHistory`. Do not jump to code syntax until you have named the domain events. The domain events are the design. The code is just the implementation.

The Go-specific questions (11-14) are testing whether you can translate patterns into idiomatic Go. Practice implementing a minimal version of each answer on paper without looking at the chapter code. If you cannot write the `EventStore` interface from memory, you have not internalized the pattern well enough for a FAANG coding round.

### Senior @ FAANG: What the Bar-Raiser Is Really Listening For

The interview questions in this section are framed from the bar-raiser's perspective. A bar-raiser is a trained interviewer whose job is to assess whether the candidate raises the average bar of the team, not just meets it. For L6 and L7 roles, the bar-raiser is looking for signals that distinguish a senior who can implement these patterns from a staff engineer who can govern them.

The signal on Question 1 (CQRS, when would you NOT use it) is specificity. Any candidate can say "don't use it for simple CRUD." The bar-raiser is listening for: "I would not use it when the team does not have operational experience with projection maintenance, because the hidden cost is not the code, it is the runbooks, the rebuild procedures, the lag monitoring, and the on-call rotation for projector failures." That answer demonstrates that you have operated CQRS in production, not just implemented it.

The signal on Question 2 (Event Sourcing costs) is the temporal bug example. Most candidates can list "storage growth" and "team learning curve." Fewer can give a concrete temporal bug scenario: "if we replay historical order events through today's pricing code, we compute what the revenue would be under today's prices, not what it actually was. A CFO looking at historical revenue data would see wrong numbers if we rebuild the revenue projection after a price change." That example is what separates candidates who have thought deeply about Event Sourcing from those who memorized a list.

The signal on Question 8 (read model lagging 30 seconds) is structured diagnosis. The bar-raiser is watching whether the candidate starts with measurement or with solutions. "I would first instrument the event publish latency, the consumer throughput in events/second, and the DB write time per batch in the projector. Once I know where the time is going, I can target the fix." That is the correct order. "Scale up the projector" is the wrong first answer.

For Questions 11-14 (Go-specific), the signal is precision. Can the candidate write the `EventStore` interface with correct method signatures from memory? Can they explain why `expectedVersion` is passed as a parameter (optimistic concurrency) rather than derived inside the append? Can they describe the idempotency requirement for projection tests without prompting? Precision in these answers indicates hands-on experience, not book knowledge.

The follow-up questions in this section are where L7 candidates separate from L6. An L7 candidate on "how do you handle GDPR erasure in an event-sourced system" goes beyond crypto-shredding to discuss: which fields constitute PII under GDPR (name, email, IP address, device fingerprint, and potentially financial account numbers), how crypto-shredding interacts with projections that cached the plaintext before the key was deleted (those projections must be rebuilt after erasure), and what you tell auditors about events that still exist but whose payloads are now unreadable ciphertext (the event structure proves the history, the ciphertext proves the PII was present, the deleted key proves the erasure). That level of completeness is the bar for a staff-level GDPR compliance conversation.

---
