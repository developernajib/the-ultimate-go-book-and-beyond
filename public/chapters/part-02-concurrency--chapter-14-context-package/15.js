export default `## Summary

The context package is the standard mechanism for managing request lifecycles in Go services:

| Feature | Purpose | Key Methods |
|---------|---------|-------------|
| Cancellation | Stop work when no longer needed | \`WithCancel\`, \`Done()\`, \`Err()\` |
| Deadlines | Limit operation duration | \`WithDeadline\`, \`WithTimeout\`, \`Deadline()\` |
| Values | Request-scoped data | \`WithValue\`, \`Value()\` |

**Key Rules:**
1. Pass context as first parameter named \`ctx\`
2. Don't store context in structs
3. Always call cancel functions (use \`defer\`)
4. Use typed keys for context values
5. Check \`ctx.Done()\` in long-running operations
6. Context values for request-scoped data only
7. Don't pass nil context, use \`context.Background()\` or \`context.TODO()\`

**Context Flows:**
- Cancellation flows DOWN (parent → children)
- Values are looked up UP the chain (child → parent)
- Deadlines use minimum of parent and self

The context package enables proper request lifecycle management, making services more reliable and debuggable.

### For the Senior-at-FAANG Track

Push back on context anti-patterns in review: context stored in structs, context values smuggling dependencies, cancel forgotten without defer, context not propagated to database or RPC calls. Each catch prevents a future production bug.

### For the Staff and Principal Track

The org-wide deliverable is end-to-end deadline propagation: every service respects the incoming deadline and propagates it to every downstream call. Without this invariant, slow dependencies burn capacity on work no client is still waiting for. Drive the rollout; enforce via middleware and integration tests; monitor via tracing. This is unglamorous work that pays compound dividends in incident prevention.

### Mental Model to Take Away

Context is the plumbing that makes concurrent Go services debuggable and well-behaved. It is not glamorous, but it is the layer beneath every correct shutdown, every observable cancellation, every propagated deadline. A codebase with disciplined context usage runs cleaner and fails faster. A codebase without it accumulates invisible bugs that surface as mysterious latency, leaked goroutines, and shutdown problems. Invest in context discipline early. It is cheaper than the alternative.

---
`;
