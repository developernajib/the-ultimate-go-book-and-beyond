## Exercises

These exercises build on the patterns from this chapter. Each one requires you to apply multiple DDD concepts together, not just implement a single building block in isolation.

**Exercise 1**: Implement a `Product` aggregate for an inventory management system. Include a `ProductID`, a `SKU` value object, a `StockLevel` value object with `Reserve()` and `Release()` methods, and appropriate domain events.

**Exercise 2**: Design and implement a `Customer` aggregate with an `EmailAddress` value object. Add methods to change the email address. Add a `CustomerEmailChanged` domain event.

**Exercise 3**: Implement a `DiscountPolicy` interface and two implementations: a `PercentageDiscountPolicy` (e.g., 10% off for premium customers) and a `FixedAmountDiscountPolicy` (e.g., $5 off orders over $50). Wire them into the `PricingService`.

**Exercise 4**: Write a context map for a ride-sharing platform (like Uber or Lyft). Identify at least 5 bounded contexts, name one relationship between each pair, and describe the `Driver` entity in two different contexts.

**Exercise 5**: Write a complete test suite for the `Order` aggregate covering all state transitions and all invariants. Ensure zero infrastructure dependencies in the test file.

### Junior → FAANG: Getting the Most from These Exercises

Exercises 1 through 3 are implementation exercises. Do them in Go, not pseudocode. The constraint is the same as a real codebase: no exported fields on aggregates or value objects, no setters, and all domain logic must be testable without a database. If you cannot test it without infrastructure, the design is wrong.

For Exercise 1, the key decision is whether `StockLevel` is an entity or a value object. Think about this before writing code: if you have two stock levels with the same count, are they the same thing? (Yes, so it is a value object.) What about `Reserve()` and `Release()`: since value objects are immutable, these methods should return a new `StockLevel`, not modify in place. Implement it this way and notice how it forces you to make the `Product` aggregate responsible for applying the returned value.

For Exercise 4, use the context map patterns from the bounded contexts chapter explicitly. Do not just draw boxes. For each pair of contexts, state whether the relationship is Partnership, Customer-Supplier, ACL, Conformist, Open Host Service, or Published Language, and justify the choice.

For Exercise 5, table-driven tests are the Go idiom for aggregate state machines. Define a table of `{name, initial state, operation, expected outcome}` rows and iterate over them. This approach also reveals gaps: if you cannot express a scenario as a row in the table, the test is missing something.

### Senior @ FAANG: Extension Exercises for Staff-Level Depth

The standard exercises test tactical DDD. These extensions test the strategic and operational depth expected at L6/L7.

**Extension A:** Take the `Product` aggregate from Exercise 1 and add an Outbox mechanism. The `Product` domain events (`StockReserved`, `StockReleased`) should be persisted to an outbox table in the same transaction as the product state. Write a relay worker that reads the outbox and publishes to an in-memory channel (simulating a message bus). Write tests that verify at-least-once delivery by simulating a relay failure and replay.

**Extension B:** Design a context map for a B2B SaaS platform that has at least one Core Domain, two Supporting subdomains, and one Generic subdomain. For each context, name the team owner, the integration pattern with each adjacent context, and the build-vs-buy decision. Write an ADR for the most complex integration relationship.

**Extension C:** Take the `CancelOrder` use case from the chapter examples and add idempotency key support. The command carries a `ClientRequestID`. If the same `ClientRequestID` has already been processed successfully, return the cached result without re-executing. Write tests that verify idempotent behavior when the command is submitted twice with the same key.

**Extension D:** Implement a saga for the `PlaceOrder` use case that coordinates three aggregates: `Order` (in the Order context), `StockReservation` (in the Inventory context), and `PaymentAuthorization` (in the Payment context). Each step can fail. Write the compensating transactions for each failure path. The saga state should be persisted so it survives process restarts. Use only domain events and in-memory repositories for the implementation.
