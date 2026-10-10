# Chapter 59: Distributed System Patterns

*Distributed systems are not just about making things work, they are about making things work correctly under every conceivable failure.*

Building software that runs across multiple machines is fundamentally different from building a monolith. When you introduce a network between components, you inherit an entirely new class of problems: partial failures, message reordering, clock skew, split-brain scenarios, and the impossibility of perfect consistency. These are not bugs to be fixed, they are invariants of the environment that must be designed around. The patterns in this chapter exist because engineers at companies like Amazon, Google, and LinkedIn encountered these realities in production and codified repeatable solutions.

Go's concurrency model maps well to distributed algorithms. You can model Raft leader election with goroutines and channels, coordinate distributed transaction steps with Saga orchestrators, and build outbox pattern processors as background workers. Go's explicit error handling also makes failure management, the central concern of distributed systems, more disciplined than in languages that rely on exceptions.

This chapter takes a pattern-first approach. Rather than surveying distributed systems theory abstractly, you will implement each pattern in Go with production-grade code. You will understand when to reach for consistent hashing versus simple modulo distribution, how distributed locks prevent concurrent mutations across processes, and how circuit breakers and bulkheads contain cascading failures.

**What you'll learn in this chapter:**

- How consistent hashing minimizes data reshuffling when cluster topology changes
- Implementing the Raft consensus algorithm in Go for leader election and log replication
- Building distributed locks using Redis `SET NX` and etcd leases with proper TTL management
- Distributed rate limiting with sliding window, token bucket, and leaky bucket algorithms
- Implementing circuit breakers, bulkheads, and retry with exponential backoff in Go
- Making operations safe to retry through idempotency keys and fencing tokens
- Composing resilience patterns into a production-grade HTTP client

**Why this matters at scale:**

Google's Chubby lock service, the ancestor of ZooKeeper and etcd, was built because distributed coordination without consensus leads to split-brain and data corruption at scale. Netflix pioneered circuit-breaker patterns via Hystrix after discovering that a single slow downstream dependency could cascade into full-platform outages. Discord uses consistent hashing to route millions of messages per second while maintaining guild-level ordering. These are not theoretical concerns, they are production lessons that shaped the patterns in this chapter.

**Prerequisites:** Chapters 1-58, familiarity with goroutines and channels (Chapter 11), and a basic understanding of key-value stores and HTTP services.

### Junior -> FAANG: Building Your Mental Model of Distributed Failures

The single biggest gap for junior engineers entering distributed systems work is the assumption that the network is reliable. In a single-process program, a function either returns or panics. In a distributed system, a function call across a network can succeed at the remote end and still return an error to the caller. That ambiguity is not a bug in the framework. It is an irreducible property of networks, and every pattern in this chapter exists to manage it.

Start by memorizing the "fallacies of distributed computing" as a checklist: the network is not reliable, latency is not zero, bandwidth is not infinite, the network is not secure, topology does not change, there is not one administrator, transport cost is not zero, and the network is not homogeneous. When a colleague proposes a design, run through these eight points and ask which ones the design silently assumes away.

The second prerequisite gap is understanding what "partial failure" means in practice. When your database write times out, you do not know whether the write happened or not. Your code must either be idempotent (safe to retry) or it must record intent before acting (outbox pattern) so it can recover deterministically. Practice this thought experiment on every endpoint you write: "what happens if I call this twice?"

For interviews, be ready to explain CAP theorem at a conversational level: under a network partition, a system must choose between consistency (every read returns the most recent write) and availability (every request receives a non-error response). Most production systems choose availability and accept eventual consistency, which is why understanding conflict resolution matters.

Entry-level interview signals FAANG looks for: you can name at least three failure modes that do not exist in single-process programs, you understand why `time.Sleep` is not a substitute for a proper backoff strategy, and you have actually run a distributed system locally with something like Docker Compose and observed a node failure.

### Senior @ FAANG: Platform Thinking and Governance for Distributed Primitives

At the senior and staff levels, the question shifts from "how do I implement a circuit breaker" to "how does my organization prevent twenty teams from implementing twenty different circuit breakers with twenty different tunability knobs, none of which are observable from a single dashboard?"

The architectural answer is to promote resilience patterns into platform primitives. At Google, circuit breaking, retries, and deadline propagation are handled by the RPC framework (Stubby, later gRPC) so that individual services get them without writing any code. At Netflix, Hystrix was a library that every Java service imported, which gave Netflix visibility into every breaker state from a single Hystrix Dashboard stream. The ADR question for your organization is: service mesh (Envoy/Istio handling retries and circuit breaking transparently at the sidecar layer) versus library (each team imports a shared package) versus framework (opinionated service template that bakes these in).

Each has real tradeoffs. A service mesh gives you language-agnostic control and centralized observability, but it adds a network hop, complicates local development, and makes debugging harder because the retry is invisible to the application. A library gives teams more control and easier debugging, but governance is harder: teams drift on versions, tunability choices proliferate, and you end up with some services using five-second timeouts and others using thirty-second ones, making SLO math impossible.

Staff-level concern: distributed system patterns interact badly when composed incorrectly. Retries inside a circuit breaker is safe. A circuit breaker inside a retry is dangerous: each retry attempt opens a fresh circuit evaluation window, so the breaker never accumulates enough signal to open. Rate limiters before bulkheads is correct. Bulkheads before rate limiters means a request burns a bulkhead slot while waiting for rate-limiter admission. Document the correct composition order in your organization's service template and enforce it in code review.

Maturity model signal: a team at level one has each pattern implemented ad hoc per service. Level two has a shared library with standardized configuration. Level three has observability baked in: every breaker state transition emits a structured log event with service name, downstream, reason, and duration in the open state. Level four has automated alerting when breaker open-rate for any service exceeds a threshold, and runbooks linked from the alert. Level five has chaos engineering that deliberately injects failures to verify breakers trip at the right thresholds.

Bar-raiser interview signals: you can articulate why distributed transactions (2PC) are almost always the wrong answer and what the correct alternatives are (saga, outbox, idempotency keys). You can explain why clock skew makes lease-based leader election fundamentally different from Raft-based election, and when you would accept the weaker guarantee. You can describe what happens to your system during a Redis failover if you rely on Redis for distributed locking, and you have a plan for it.

---
