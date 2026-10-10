# Chapter 27: Idempotency & Exactly-Once Processing

*Exactly-once delivery does not exist. Exactly-once processing does, and idempotency is how you get it.*

Networks lie. Services crash mid-request. Clients time out and retry without knowing whether their original message was processed. In distributed systems, partial failures are not the exception, they are the norm. Without idempotency, every retry becomes a gamble: did the payment charge once or twice? Did the email send to the user once or a dozen times? Did the inventory decrement happen at all? These are not theoretical edge cases. They are incidents waiting to happen in any system that handles real traffic.

Start with the distinction that organizes this entire chapter, because getting it wrong makes the rest incoherent. **Exactly-once delivery is impossible.** Not difficult, not expensive: impossible, and provably so. A sender that gets no acknowledgement cannot distinguish "the message was lost" from "the message arrived and the ack was lost". It must choose: resend and risk a duplicate, or stay silent and risk losing the message. There is no third option, and no amount of protocol engineering creates one, because the ack for the ack has the same problem. Every system marketed as "exactly-once" is doing one of two things: at-most-once (accepting loss) or at-least-once plus deduplication (accepting duplicates and discarding them).

That second option is the achievable and genuinely useful goal, and it has a name worth using precisely: **exactly-once processing**. Delivery happens many times. *Effects* happen once. The receiver recognizes the duplicate and declines to act on it twice. Everything in this chapter, idempotency keys, dedup stores, the outbox, conditional writes, exists to make the effect happen once while the delivery happens as many times as the network demands. When someone says "exactly-once" in a design review, the useful question is always: are you claiming the message arrives once, which is false, or that its effect lands once, which is the thing we are building?

Go's explicit error handling, goroutine model, and tight control over database transactions make it well-suited for building idempotent systems. Unlike languages that hide failure behind exceptions, Go forces you to reason about every failure path, which is exactly the mindset needed to design retry-safe operations. Combined with PostgreSQL's unique constraints and Redis atomic operations, Go gives you the building blocks to construct exactly-once processing on top of at-least-once infrastructure.

This chapter covers the full spectrum of idempotency patterns: idempotency key middleware, transactional outbox publishing, distributed deduplication stores, two-phase processing, and saga orchestration for multi-step transactions. You'll build systems that are safe to retry under any failure condition, from network timeouts to process crashes to zombie workers, without risk of double-processing or data corruption.

**What you'll learn in this chapter:**
- Understanding naturally idempotent vs non-idempotent operations and how to convert between them
- Building production-grade idempotency key infrastructure with Redis and PostgreSQL storage backends
- Implementing the transactional outbox pattern to guarantee at-least-once publishing with no lost messages, and pairing it with consumer-side dedup to reach exactly-once processing
- Creating efficient deduplication stores with proper TTL management and storage cleanup strategies
- Designing two-phase processing systems that survive process crashes and zombie worker scenarios
- Orchestrating distributed sagas with compensation logic for multi-step transactional workflows
- Implementing optimistic and pessimistic locking strategies for safe concurrent data modifications
- Designing retry-safe REST and gRPC APIs with proper idempotency semantics across all failure modes

**Why this matters at scale:**
Stripe publishes its idempotency key contract as a foundational API design principle: every charge, refund, and transfer endpoint accepts an `Idempotency-Key` header, responses are replayed for at least 24 hours, and reusing a key with different parameters is rejected rather than silently replayed. That contract is the reference implementation this chapter builds toward, and because clients already know it, matching its semantics exactly means their existing retry logic works against your API on day one. Ride-hailing and delivery platforms lean on the same primitives plus saga orchestration to coordinate multi-step workflows that must survive partial failure.

**Prerequisites:** Chapter 32 (Database Patterns), Chapter 22 (Resilience Patterns), Chapter 26 (Feature Flags & Configuration)

**Staff and Principal lens: idempotency is how retry becomes safe.** Without it, retries duplicate effects. With it, retries are harmless. This is the foundation of reliable distributed systems. Every mutation endpoint should be idempotent by design.

---
