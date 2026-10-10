## FAANG Interview Q&A: NASA Software Engineering

These questions assess whether you can translate safety-critical software principles into the Go systems that run at Google, Meta, Amazon, and Stripe, without blindly over-engineering.

### 1. NASA's Power of 10 rule 2 requires all loops to have a fixed upper bound. What does this look like in a Go service?

Translate the principle: every loop over external input must have an explicit iteration cap, every network call must have a context deadline, every channel receive must be guarded by a timeout or cancellation, and every backoff loop must have a maximum retry count. Mention that `context.Context` is the Go idiom that encodes bounded work, and that unbounded `for { select { ... } }` loops in goroutines are the most common violation.

### 2. Why does NASA still use C in 2026, and what is the Go equivalent of the decision?

NASA uses C because the toolchain, formal verification ecosystem, and certified compilers (like Green Hills INTEGRITY) are mature and auditable at the level aerospace certification requires. Go lacks a certified compiler and the GC introduces unbounded latency, which is unacceptable in hard-real-time contexts. For Go engineers: the lesson is that language choice is a function of the reliability and latency envelope, not developer preference. Pick the language whose runtime matches your constraints.

### 3. The Mars Pathfinder priority inversion bug took down the rover for days. What is the Go analog?

Priority inversion in Go appears as goroutine starvation: a low-priority goroutine holds a resource (mutex, channel, or rate-limit token) that a high-priority goroutine needs. Mitigation: use `sync.Mutex` rather than `sync.RWMutex` where the read/write pattern is not strongly asymmetric (RWMutex has known starvation issues), bound the time any goroutine can hold a critical section, and avoid `select` statements where one branch can dominate. Describe a production incident where you diagnosed a starvation pattern.

### 4. Design a bounded Go HTTP service applying NASA principles.

A Staff-level answer covers: every numeric parameter validated at construction with explicit upper bounds, buffer pools pre-allocated before the first request so the hot path has zero heap allocations, middleware that caps request body size and request deadline, a rate limiter with a fixed token-bucket capacity, and assertions at function entry on invariants that must hold. The goal is not to match NASA's reliability level but to borrow the design discipline of making every resource cap explicit.

### 5. How do you decide when NASA-level rigor is overkill versus when it is the right engineering investment?

The answer depends on the cost of failure. For a user-facing web service, the cost of an incident is usually recoverable and the engineering investment in aerospace-level rigor is a poor trade. For a financial-trading system (Knight Capital), a medical device (Therac-25), or infrastructure that other critical systems depend on (Consul, Kubernetes control plane), the investment pays back the first time it prevents a catastrophic failure. A Staff engineer can articulate the cost-of-failure calculation explicitly rather than defaulting to either extreme.
