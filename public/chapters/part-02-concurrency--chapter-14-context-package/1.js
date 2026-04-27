export default `## Learning Objectives

By the end of this chapter, you will be able to:

1. **Explain the context.Context interface** and its design philosophy
2. **Implement proper cancellation propagation** across goroutines and API boundaries
3. **Design timeout hierarchies** with layered deadlines for complex operations
4. **Use context values correctly** following best practices and avoiding anti-patterns
5. **Build context-aware HTTP handlers** with middleware for request tracing
6. **Integrate context with gRPC services** for proper deadline and metadata handling
7. **Implement graceful shutdown patterns** using context cancellation
8. **Write thorough tests** for context-dependent code
9. **Apply production patterns** from Google, Uber, Netflix, and Stripe
10. **Debug context-related issues** including leaks, premature cancellation, and value misuse

### Detailed Outcomes

**Junior to FAANG-entry track**

- Pass \`context.Context\` as the first parameter to every function that can block.
- Always call \`defer cancel()\` after \`context.WithCancel\`, \`WithTimeout\`, \`WithDeadline\`.
- Check \`ctx.Err()\` and return from long loops that respect cancellation.
- Never store context in a struct. Never pass \`nil\` for a context; use \`context.TODO()\` while migrating.

**Mid-level engineer**

- Design middleware that enriches context with request-scoped data (request ID, user, trace span).
- Know when to use \`WithoutCancel\` (Go 1.21) for fire-and-forget patterns derived from a request context.
- Use \`context.Cause\` (Go 1.20) to surface specific cancellation reasons in logs and metrics.
- Enforce deadline budgets across call graphs: each downstream call gets remaining time minus a safety margin.

**Senior engineer**

- Push back in review on context stored in structs, context values smuggling dependencies, cancel forgotten without defer, context not propagated into database or RPC calls.
- Own the team's middleware that sets request deadline, request ID, trace span. Make it unavoidable.
- Diagnose context-propagation bugs from traces (downstream call received no deadline when it should have).

**Staff or Principal**

- Drive the org's end-to-end deadline propagation. If the service mesh does not enforce it, add middleware; if middleware exists, verify every service uses it.
- Design the shutdown protocol: single root context cancelled on SIGTERM, with bounded drain deadline, applied uniformly across the service portfolio.
- Own the context-value discipline: which keys are allowed, who owns each, how they evolve. Prevent context-values drift.
- Stay current with context additions: \`WithoutCancel\`, \`AfterFunc\`, \`Cause\`, \`WithDeadlineCause\`. Retire older patterns when new APIs supersede them.

---
`;
