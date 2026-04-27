export default `# Chapter 14: Context Package

*"Context carries deadlines, cancellation signals, and request-scoped values across API boundaries."* - Go Documentation

Before \`context.Context\` was introduced in Go 1.7, every team that built a production Go service eventually invented their own mechanism for propagating cancellation and deadlines through call stacks. Done channels, custom structs with timeout fields, global cancellation flags, each approach worked partially and composed poorly. The \`context\` package solved this by standardizing the contract: a \`Context\` is an immutable, tree-structured value that carries a deadline, a cancellation signal, and a bag of request-scoped key-value pairs. When a context is cancelled, all contexts derived from it are cancelled simultaneously. This single invariant, cancellation propagates downward through the tree automatically, is what makes the \`context\` package the connective tissue of the entire Go ecosystem for server-side programming.

The practical implications are profound. An HTTP handler can create a context with a 500ms deadline. Every database query, downstream RPC call, and background computation spawned by that handler inherits the deadline and will be cancelled automatically if the client disconnects or the budget is exceeded. A gRPC interceptor can extract the deadline from incoming metadata and create a Go context that mirrors it, ensuring the server never does more work than the client is willing to wait for. A graceful shutdown handler can cancel a top-level context and trust that every in-flight request will observe the cancellation signal and terminate cleanly, no external signaling infrastructure required. This is not theoretical. It is the exact architecture of HTTP servers in the Go standard library, gRPC-Go, and virtually every serious Go service framework.

Correct \`context\` usage is also one of the most common sources of bugs in production Go code. Storing contexts in structs (instead of passing them as the first parameter) breaks the tree structure. Passing \`context.Background()\` deep into a call stack instead of the request context defeats cancellation propagation. Storing mutable values in context bypasses type safety and creates invisible data dependencies. Using context values as a substitute for proper function parameters obscures API contracts. This chapter covers not just the mechanics of the \`context\` API but the design principles behind it, so you can recognize and fix these anti-patterns in real codebases, not just in toy examples.

**What you'll learn in this chapter:**

- **\`context.Context\` interface and tree structure** - how derived contexts form cancellation trees and why immutability matters
- **Cancellation propagation** - using \`WithCancel\`, \`WithCancelCause\`, and manual cancellation to stop goroutines cleanly
- **Deadlines and timeouts** - \`WithDeadline\` vs. \`WithTimeout\`, clock sources, and avoiding deadline extension anti-patterns
- **Context values** - idiomatic key types, what belongs in context vs. function parameters, and performance considerations
- **Context in HTTP handlers** - \`r.Context()\`, middleware for request tracing, and timeout enforcement in handler chains
- **Context in gRPC services** - deadline propagation from metadata, interceptor patterns, and server-side cancellation
- **Context in database calls** - passing context to \`database/sql\`, query cancellation, and connection pool interaction
- **Graceful shutdown patterns** - using a root context to coordinate clean shutdown of all in-flight work

**Why this matters at scale:**

Google's production HTTP servers enforce per-request deadline budgets using context, every database call and downstream RPC is bounded, preventing a slow dependency from exhausting the server's goroutine pool. Twitch's video ingestion pipeline uses context cancellation to immediately halt transcoding work when a stream disconnects, reclaiming GPU resources within milliseconds. Shopify's Rails-to-Go migration documented that adopting context-propagated timeouts was the single change that most improved their API reliability under partial infrastructure failures, downstream timeouts became bounded rather than indefinite. Kubernetes's \`controller-manager\` uses a single root context for its entire control loop. When the process receives SIGTERM, a single cancellation cascades through every reconciler and shuts down the cluster gracefully.

**Prerequisites:** Chapter 11 (Concurrency Fundamentals), goroutines and channels. Chapter 13 (Synchronization Primitives) is helpful. Familiarity with \`net/http\` handler signatures is assumed.

> **For readers new to Go:** context feels like boilerplate until you have debugged your first goroutine leak caused by a missing cancellation. Pass context as the first parameter to every function that might do I/O, check \`ctx.Err()\` on blocking operations, and do not store context in structs. These three rules prevent 90% of context-related bugs.
>
> **For readers already senior at a FAANG-equivalent:** the leverage is in the common-mistakes section (13.10) and the horror-stories section (13.14). These are the patterns you catch at review time, and the postmortems you run when context was misused in production.

**Chapter navigation by career stage.**

- **Junior:** read 13.1 through 13.4 sequentially. The context interface, cancellation, deadlines, and values are the core. Skip HTTP/gRPC integration until you have written basic context-aware code.
- **Mid-level:** the HTTP and gRPC integration (13.5, 13.6) are where context meets reality. Understand how context flows through middleware and interceptors.
- **Senior:** the common-mistakes and anti-patterns section. Every team has the same context bugs; knowing them prevents recurrence.
- **Staff or Principal:** the architecture question is "does every service respect end-to-end deadline propagation?". Answer is often no. Drive the fix.

**Staff and Principal lens: context is the org's deadline-propagation protocol.** In a microservices architecture, a client's deadline should flow through every service in the call graph. If Service A calls B with a 500ms deadline and B calls C, C should see a deadline less than 500ms, not Infinity. When this invariant breaks, slow downstreams can accumulate work well past the client's timeout, wasting compute. The staff-level deliverable: end-to-end deadline propagation across the org's service catalog. Enforce it via middleware, verify it via integration tests, monitor adherence via tracing. A Go org without this discipline is a Go org that periodically burns capacity on work no client is still waiting for.

**Go 1.26 note.** Context has evolved: \`context.Cause\` (Go 1.20) returns the specific reason for cancellation, beyond just \`context.Canceled\`. \`context.WithoutCancel\` (Go 1.21) detaches child contexts from parent cancellation for fire-and-forget patterns. \`context.WithDeadlineCause\` and \`context.WithTimeoutCause\` (Go 1.21) let you specify why a deadline triggered. \`context.AfterFunc\` (Go 1.21) runs a function when a context is cancelled. Each of these is useful. Modern Go context code uses them.

---
`;
