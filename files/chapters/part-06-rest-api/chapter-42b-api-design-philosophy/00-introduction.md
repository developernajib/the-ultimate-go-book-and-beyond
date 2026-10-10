# Chapter 42B: API Design as a Product

*"APIs are forever."* Werner Vogels, CTO of Amazon, on why the interface you ship is a promise you cannot quietly take back.

In most engineering organizations, APIs are designed by the same engineers who implement them, under deadline pressure, with the primary goal of making the code work. The result is an API that reflects the internal data model, the database schema, or the implementation's convenience rather than the needs of the developer consuming it. Field names leak internal jargon. Error messages describe what went wrong in the database, not what the client should do differently. Pagination is inconsistent across endpoints. Webhooks arrive without signatures. This kind of API is not a product. It is a technical artifact that other developers have to work around.

The companies whose APIs developers actually enjoy using treat their APIs as products with users, a value proposition, and a lifecycle. They conduct API design reviews before a line of implementation code is written. They maintain backwards compatibility across years of product evolution. They publish SDKs that feel idiomatic in every language. They provide sandbox environments, detailed changelogs, and runnable examples. This is not polish applied at the end of a sprint. It is a discipline that starts with the question: "If I were a developer integrating this endpoint at 2am, would this make sense?"

This chapter examines API design as a product discipline through the lens of Go. You will work through API-first development workflows using OpenAPI contracts and mock servers, resource modeling decisions that survive years of product evolution, idempotency key patterns that make payment APIs safe to retry, webhook delivery infrastructure with HMAC signature verification, and the developer experience details (consistent naming, predictable pagination, meaningful error codes) that turn a functional API into one developers recommend to their colleagues.

**What you'll learn in this chapter:**
- API-first development: designing OpenAPI contracts before writing implementation code
- Resource modeling for long-term evolution: nouns vs verbs, nesting depth, and relation representation
- Idempotency key patterns that make any state-changing operation safe to retry without side effects
- Webhook delivery design: HMAC-SHA256 signing, delivery guarantees, and retry with exponential backoff
- Developer experience essentials: consistent naming conventions, envelope formats, and pagination contracts
- SDK design principles: what makes a Go client library feel idiomatic versus mechanical
- API governance with OpenAPI linting, breaking-change detection, and contract testing in CI
- Designing sandbox and test mode environments that let developers integrate safely before going live

**Why this matters at scale:**
Stripe's public API launched in 2011 and its URL prefix is still `/v1`. That is worth understanding precisely, because it is widely misreported as "Stripe has never made a breaking change." Stripe makes breaking changes regularly. What it does not do is force them on you. Breaking changes ship as **dated API versions**, each account is pinned to the version it integrated against, and you upgrade deliberately when you choose to. The `/v1` in the path has never moved because the version that matters was never in the path.

That is the actual lesson, and it generalises beyond payments: the expensive commitment is not "never change the API," which is impossible for a product that is still growing. It is "never change the API *underneath an existing integration*." Those are very different promises, and only the second one is keepable.

**Prerequisites:** Chapter 38 (REST fundamentals), Chapters 39-42 (auth, validation, versioning, rate limiting)

### Junior → FAANG: Reading an Introduction Like an Engineer, Not a Consumer

Most developers read a chapter introduction to find out what topics are covered. At FAANG, you read it to extract the design commitments being made and the failure modes being pre-empted. Practice this now.

This introduction makes three concrete claims: an API that mirrors your database schema serves your convenience rather than your consumer's, idempotency keys make retries safe without duplicate side effects, and versioning that pins each integration to the contract it was written against is what makes long-term compatibility achievable at all. Each of those claims is an interview entry point.

A common entry-level mistake is to treat these topics as independent techniques. They are not. Idempotency keys exist because POST is not safe per RFC 9110, and "not safe" means proxies and clients will not automatically retry. Understanding the RFC gives you the chain. If you cannot explain why a design rule exists, you will struggle to apply it correctly when the situation does not match the textbook example.

Concrete habit to build now: for every API design decision you make in your first job, write one sentence explaining the RFC or failure mode that motivates it. If you cannot write that sentence, you do not yet understand the decision well enough to defend it in a design review.

Before moving through this chapter, make sure you can answer: what is the difference between safe and idempotent in the HTTP semantics RFC, and what infrastructure relies on each property?

### Senior @ FAANG: What an Introduction Signals About Organizational Maturity

An introduction that frames APIs as products with a lifecycle, rather than as code you happen to expose, is signaling a specific worldview: API design is governance, not craft. That framing has concrete implications for how staff-level engineers operate.

At L6 and above, your job is not to write great APIs. It is to create conditions where teams across the organization consistently produce APIs that meet a bar, without requiring your personal review of every design. That requires three things this introduction gestures at but does not develop.

First, "developers enjoy using it" has to become measurable before you can fund work against it. Pick leading indicators, not lagging ones, because a lagging indicator only tells you that adoption already failed. Time to first successful call from a cold start is the canonical leading indicator. So are 4xx rates scoped to *new* integrations rather than established clients (established clients have already routed around your sharp edges, which is exactly why their error rate looks fine), and the fraction of support tickets that are integration questions rather than bug reports. If you cannot translate "good API" into a number that moves, you cannot argue for headcount against it.

Second, Hyrum's Law (with enough consumers, every observable behaviour of your system will be depended upon by somebody, regardless of what you promised) has a corollary this introduction does not state: the cost of enforcing a contract is proportional to how long you waited to enforce it. A breaking change in week 2 of an API is a one-team coordination. The same change in year 2 is a multi-quarter migration. The ADR implication is that any design decision you cannot commit to supporting for years should be marked experimental with an explicit promotion criterion. Do not let stability happen to you by default.

Third, treat the dated-version model in the section above as a benchmark rather than as trivia. A bar-raiser question: "How would you measure whether your API platform has reached that level of maturity, and where is the gap today?" A strong answer names the backward-compatibility incident rate, the number of consumers pinned to versions you would like to retire, whether you *can* retire a version at all, and SDK quality signals. The weak answer is a list of things Stripe does. The distinction is whether you can name your own gap.

---
