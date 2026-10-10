# Chapter 62: Design Notification System

*The art of communication is the language of leadership, and at scale, that communication runs through notification pipelines.*

Every significant user action in a modern application triggers a cascade of notifications: a payment confirmation email, a push notification on mobile, an SMS fallback if the push is undelivered, and an in-app badge increment. Designing a system that orchestrates all of these channels reliably - at the scale of millions of events per hour - requires solving a cluster of genuinely hard problems simultaneously. Fan-out from a single event to multiple channels must be parallelised without losing any delivery. Deduplication must prevent a user from receiving the same notification three times because a retry was triggered after a partial failure. User preferences must be enforced in real time: a user who opted out of marketing emails must never receive one, even when the preference store is under load.

The delivery guarantee question is particularly thorny. Email delivery is inherently at-least-once - you may send and the SMTP server may acknowledge, yet the email may never arrive. Push notifications through APNs and FCM have their own acknowledgment semantics that do not map cleanly to transactional guarantees. SMS via Twilio or Vonage is expensive and synchronous, so it must be reserved as a fallback for high-priority events. Building a system that threads these constraints together - treating each channel's delivery model honestly rather than pretending they are uniform - is what separates reliable notification infrastructure from fragile point solutions.

Go is exceptionally well-suited for notification systems because the fan-out model maps naturally onto goroutines and channels. A single inbound event can be fanned out to parallel channel workers using a `sync.WaitGroup` with per-channel goroutines, each with independent retry logic and circuit breakers. Priority queuing can be implemented with separate channel buffers or with a heap-backed priority queue that drains time-sensitive transactional notifications before promotional batches. This chapter builds the entire system in Go, from the inbound event API to the per-channel dispatcher, deduplication layer, preference engine, and delivery status tracker.

**What you'll learn in this chapter:**

- Designing a multi-channel notification architecture that handles email, SMS, push, and in-app notifications as independent delivery pipelines
- Implementing fan-out with Go goroutines and channels, including per-channel circuit breakers and retry policies
- Building an idempotency layer using Redis to deduplicate notifications across retries and replayed events
- Designing a user preference engine that enforces opt-out rules and quiet hours without blocking the hot delivery path
- Implementing priority queuing to separate transactional (high-priority) from promotional (low-priority) notification workloads
- Handling partial delivery failures gracefully - logging delivery status per channel without failing the entire fan-out
- Designing rate limiting per user to prevent notification storms during system incidents or bulk campaigns
- Building a templating engine that renders dynamic notification content safely with Go's `html/template`

**Why this matters at scale:**

Meta's notification infrastructure sends over 100 billion notifications per day across Facebook, Instagram, and WhatsApp, using a multi-tier fan-out architecture where a single "like" event propagates to a social graph-aware delivery system rather than brute-forcing every follower. Duolingo publishes engineering posts on their streak-notification system, where timezone-aware scheduling and user engagement scoring determine the exact send time for each user - a system processing tens of millions of personalised schedules daily. Uber's trip-event notification pipeline must deliver ride status updates within 200ms end-to-end, achieved by keeping the push-notification path in-memory and async, while persisting the event to a durable queue in parallel for audit and replay purposes.

**Prerequisites:** Chapters 1-61, familiarity with message queues (Chapter 64 previewed), and basic knowledge of APNs, FCM, and SMTP protocols.

### Junior -> FAANG: Understanding What a Notification System Actually Is

Many candidates arrive at a notification system interview thinking of it as a simple "send email" wrapper. FAANG interviewers are probing whether you understand the distribution, reliability, and coordination challenges that emerge at millions of events per hour.

Start by being explicit about delivery semantics. Email is at-least-once: you can send and the SMTP server acknowledges, yet the message may still not arrive. Push via APNs or FCM is best-effort with its own retry window. SMS is synchronous and expensive but has the highest delivery rate. Treating these channels as uniform is a red flag. Interviewers want to see that you map each channel to its actual guarantees, then design the system around those constraints rather than pretending they are all the same.

A first-job habit that separates candidates: when asked "how do you ensure a notification is sent exactly once?" do not jump to Redis locks without first acknowledging that cross-system exactly-once is theoretically impossible. Frame the answer as "effectively-once via idempotency keys plus provider-side deduplication." That framing shows you understand distributed systems fundamentals.

Go's goroutine model is a strong fit here. A single fan-out event can spawn parallel channel workers, each with independent retry logic, using a `sync.WaitGroup`. Demonstrating this concretely in your answer (rather than just saying "use goroutines") signals that you can translate system design into working code.

For interview entry-point: draw the three layers first (API intake, priority queue, per-channel workers), then explain why each exists. The interviewer will push on whichever layer they care most about.

### Senior @ FAANG: Platform Thinking for Notification Infrastructure

At staff and principal level, the interview is not about building one notification service. It is about designing a notification platform that product teams across the company can use without building their own.

**ADR: Why per-priority Kafka topics instead of a single topic with priority headers**

A single topic with metadata-based priority cannot deliver true priority isolation. A burst of low-priority marketing messages will consume all partition bandwidth, creating back-pressure that starves critical OTP delivery. The correct architectural decision is separate topics per priority tier, each with independently sized consumer groups and partition counts. This is the ADR you should be able to articulate: what you rejected (single topic with header-based routing, single topic with consumer-side filtering) and why the chosen design (per-priority topics) is the only one that actually delivers SLA isolation under load.

**Governance and multi-tenant notification contracts**

When multiple product teams share a notification platform, you need a contract between the platform and the caller. That contract should include: priority tier, expected send-time SLA, channel preferences override policy, and compliance category (transactional vs marketing). Without this contract, product teams will abuse high-priority topics for convenience, and the platform will have no enforcement mechanism. A senior candidate proposes a `NotificationContract` type that is validated at intake and rejected with a clear error if the caller claims critical priority for a batch marketing campaign.

**Maturity model: where most companies get stuck**

Most notification systems start as a fire-and-forget email wrapper. The maturity progression is:

1. Single-channel, no retry, no deduplication (prototype)
2. Multi-channel, at-least-once with idempotency keys (production v1)
3. Priority queuing with SLA measurement and alerting (production v2)
4. Preference engine, quiet hours, rate limiting (scale)
5. Platform with multi-tenant contracts, audit trail, self-service template management (FAANG-grade)

A bar-raiser question is: "Where on this maturity model is your current system, and what is the cost of the next step?" Candidates who cannot articulate technical debt, migration cost, and business justification for each step are operating at L4 level. L6 thinking involves knowing which step to skip based on the business's current scale and risk tolerance.

**L6/L7 staff concern: notification fatigue at the platform level**

A single team's notification might seem reasonable in isolation. When 20 product teams each send two notifications per day, users receive 40 notifications, uninstall the app, and the entire notification channel loses value for everyone. Staff-level thinking means proposing a cross-team notification budget per user per day, enforced at the platform level, with an escalation process for teams whose notifications are deprioritized. This is a platform governance problem, not a software engineering problem, and recognizing that distinction is what separates principal engineers from senior engineers.

**Observability as a first-class citizen**

The delivery tracking system described in this chapter is necessary but not sufficient for a FAANG-grade platform. You also need: per-provider SLA tracking (is SendGrid's p99 delivery latency degrading?), per-notification-type engagement metrics (open rate, click rate, unsubscribe rate), and anomaly detection that pages on-call when a notification type's delivery rate drops 20% below its 7-day rolling average. Building these observability primitives into the platform from day one, rather than adding them reactively after an incident, is the architectural decision that staff engineers are responsible for.

---
