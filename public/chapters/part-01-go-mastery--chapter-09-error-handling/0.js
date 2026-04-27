export default `# Chapter 9: Error Handling Mastery

*"Errors are values. They are not special. They do not deserve special syntax. Handle them with the same care and intention you give to any other value your program produces."* - Rob Pike

No aspect of Go provokes more debate among developers coming from other languages than its error handling. The \`if err != nil\` pattern appears so frequently in Go code that it became a meme. Critics point to Go programs where error checks outnumber business logic lines. The frustration is real and worth taking seriously. But the critics are reacting to the surface, not the design intent. In Java or Python, exceptions create hidden control flow: any method call might throw, propagating upward through an arbitrarily deep call stack until something catches it, or doesn't, crashing the program with a stack trace. This implicit propagation makes programs easier to write in the happy path but dramatically harder to reason about in the error path, which is exactly where critical bugs live. Go's explicit \`error\` return forces every caller to acknowledge that a function can fail and to decide at the call site what to do about it.

The decision at the call site is the crucial phrase. Go does not force you to handle every error the same way. You can log and continue, wrap with context and propagate, retry with backoff, convert to a user-facing error message, increment a metric and return a default, or \`panic\` when the error represents an unrecoverable programming mistake. What Go prevents is accidentally ignoring the error, because the compiler will not let you use a function's other return values if you have not acknowledged the error return. This is a fundamentally different guarantee than any exception-based language offers: in Java, you can catch \`Exception\` and swallow it silently, a pattern that causes production incidents regularly. In Go, ignoring an error requires the explicit \`_\` blank identifier, a visible, searchable signal in code review that something is being intentionally discarded.

The ecosystem of error handling patterns that has developed around Go's \`error\` interface, error wrapping with \`%w\`, the \`errors.Is\` and \`errors.As\` inspection functions, sentinel errors, custom error types carrying structured context, and the separation between operational errors and programmer errors (handled with \`panic\`/\`recover\`), gives production teams tools to build error handling systems that are simultaneously informative for debugging, clean for callers, and compatible with observability infrastructure. The patterns Stripe uses to attach request IDs, user IDs, and operation names to errors propagated through their payment processing pipelines are the same patterns you will learn in this chapter, not because they are invented here, but because they emerge naturally from Go's error-as-value philosophy when you apply it with discipline.

**What you will learn in this chapter:**

- The \`error\` interface, why it is just \`interface{ Error() string }\`, how this simplicity enables the entire ecosystem of error patterns, and the implications of errors being values
- Custom error types, implementing the \`error\` interface with structs that carry structured context (error codes, HTTP status, request IDs, stack frames), and how to use \`errors.As\` to extract them
- Error wrapping with \`fmt.Errorf\` and \`%w\` - building error chains that preserve the original cause while adding context at each layer of the call stack
- \`errors.Is\` and \`errors.As\` - how they traverse error chains, when to use each, and how they interact with custom error types that implement \`Unwrap\` or \`Unwrap() []error\`
- Sentinel errors - \`var ErrNotFound = errors.New(...)\` patterns, when sentinel errors are appropriate, their coupling trade-offs, and the alternative of error type inspection
- Panic and recover, what panic is for (programmer errors, not operational errors), how \`recover\` works in deferred functions, writing panic-safe HTTP handlers and goroutines
- Production error patterns, error logging with structured fields, error metrics and alerting, the error response envelope pattern for APIs, and the \`errgroup\` package for concurrent error collection
- Testing errors, table-driven tests for error conditions, using \`errors.Is\`/\`errors.As\` in assertions, testing panic behavior, and the \`testify\` assertion helpers for error chains

**Why this matters at scale:**

Stripe's engineering blog has documented how their Go error handling system, built on custom error types carrying error codes, HTTP status mappings, and user-safe message fields, allows their API layer to translate internal errors into precise, actionable API responses without any mapping tables or switch statements. Every error returned from any layer of their stack automatically carries the information needed to produce the right HTTP response and the right log entry. Google's internal Go error handling guidelines mandate that every error crossing a service boundary must be wrapped with the calling service's name and the operation being performed, a practice that transforms a cryptic \`connection refused\` into \`user-service: fetch-preferences: connection refused\`, dramatically reducing mean time to diagnosis. Uber's Go platform team built \`uber-go/multierr\`, a package for accumulating multiple errors in parallel operations. Its role is now largely served by the standard library \`errors.Join\` (Go 1.20+), and modern code generally reaches for the stdlib version. Both solve the same production reliability requirement: a batch operation reports all failures rather than stopping at the first one, something exception-based services could not meet cleanly without significant complexity.

**Prerequisites:** Chapters 1 to 6. Chapter 7 (Go Internals) is helpful for understanding \`panic\`/\`recover\` mechanics but not required. No prior knowledge of Go error handling needed.

> **For readers new to programming:** the \`error\` return pattern takes time to appreciate. Read Sections 8.1 through 8.3, then write a small program that handles several error cases explicitly. Come back for the advanced patterns once the basics feel natural.
>
> **For readers already senior at a FAANG-equivalent company:** this is the chapter you reference when writing the team's error-handling discipline. Sections 8.7 (error handling at scale), 8.9 (production system), and 8.11 (common mistakes) are the material you adapt for the team's review checklist.

**Chapter navigation by career stage.**

- **Junior or FAANG-entry:** focus on the basics. Sections 8.1 through 8.5 are the core. Diagnosing the typed-nil bug (8.1), using \`fmt.Errorf\` with \`%w\` (8.2), and picking sentinel vs typed errors (8.4-8.5) cover 80% of what interviewers probe.
- **Mid-level engineer:** the patterns material (8.3, 8.7) is the next step. Learn when to wrap and when not, when to define a typed error vs a sentinel, when error-as-value becomes error-with-context.
- **Senior engineer:** the production system and case-study material (8.9, 8.10) is reference for building team discipline. Write the team's error-handling guide based on these.
- **Staff or Principal:** the org-wide question is "what error contract do services expose to each other?". The answer shapes observability, incident diagnosis, and API stability.

**What the senior track gets that most error-handling material skips.** Standard content stops at "use %w to wrap". This book adds the observability framing (error messages are shipped, indexed, and retained), the cross-service contract framing (what callers can and cannot branch on), the operational framing (how error types shape on-call diagnosis), and the team-policy framing (when to wrap, when to pass through, when to escalate to panic).

---
`;
