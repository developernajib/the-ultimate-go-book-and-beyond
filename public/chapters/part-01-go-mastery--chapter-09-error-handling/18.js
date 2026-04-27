export default `## Summary

This chapter covered Go's error handling model from the single-method \`error\` interface through production-grade structured error systems. Here are the core ideas to carry forward.

**Go's error handling philosophy:**

- **Explicit**: Every error is visible in the code
- **Values**: Errors are values, not control flow
- **Composable**: Errors can be wrapped and unwrapped
- **Type-safe**: errors.Is and errors.As provide safe matching

**Key patterns:**

- **Wrap with %w**: Add context while preserving the chain
- **Use errors.Is**: Match sentinel errors through wrapping
- **Use errors.As**: Extract error types through wrapping
- **Panic rarely**: Only for programmer errors at startup
- **Test errors**: Verify error conditions thoroughly
- **Log at boundaries**: Log errors once at HTTP handlers or main

**Production considerations:**

- **Structured errors**: Use error codes and details for APIs
- **Error classification**: Retryable vs permanent errors
- **Observability**: Log errors with request IDs and context
- **Performance**: Use sentinel errors in hot paths

### What you should be able to do now

- Wrap errors with \`%w\` without hesitation.
- Use \`errors.Is\` and \`errors.As\` correctly.
- Decide sentinel vs typed vs opaque for a new error case.
- Diagnose the typed-nil bug on sight.
- Design an error envelope for a public API.

### For the senior-at-FAANG track

The team's error-handling discipline is the artifact that compounds. Write it. Enforce it in review. Update it as the team's workload evolves. The discipline is the leverage, and the individual error-handling decisions are the execution.

---
`;
