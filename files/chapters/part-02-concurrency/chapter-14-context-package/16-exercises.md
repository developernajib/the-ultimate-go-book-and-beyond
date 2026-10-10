## Exercises

1. **Cascading Timeout**: Build a service that calls 3 downstream services with individual timeouts that respect an overall budget.

2. **Context Metrics**: Implement a context wrapper that automatically records metrics (latency histograms, error counts) for each operation.

3. **Tenant Isolation**: Create middleware that extracts tenant ID from JWT, adds to context, and ensures all database queries are scoped to that tenant.

4. **Graceful Degradation**: Build a service that falls back to cached data when the context deadline is exceeded for the primary data source. Note the trap: once the request context is expired, the fallback cannot use it either, or the fallback fails instantly too. Work out which context the cache read should get.

5. **Trace Visualization**: Implement a trace collector that builds a span tree from context and outputs it as JSON for visualization.

6. **Fire-and-forget audit**: Write a handler that responds immediately and does work afterwards: read the request body, then send a notification and write an audit record. Implement it three ways, passing `r.Context()`, passing `context.Background()`, and passing `context.WithoutCancel(r.Context())` with a timeout. Drive each with a real `httptest` server and record what actually happens to the background work and to the trace ID in each case. Then explain why the first version passes a unit test and fails in production.

### Senior at FAANG Track

7. **Context-usage audit.** For one production service, find every function that should take context but does not. Refactor. Document the scope of the change.

8. **Deadline-propagation integration test.** Build a CI-runnable test that verifies a request's deadline propagates through every downstream call. Run it in CI. Catch regressions.

9. **Cause migration.** Adopt `context.WithCancelCause` throughout one service. Emit metrics per cause. Measure the improvement in diagnostic signal.

### Staff / Principal Track

10. **Org-wide context convention.** Write the one-page guide on context usage for your org. Include context-key registry, middleware requirements, prohibited patterns. Publish. Maintain quarterly.

11. **End-to-end deadline enforcement.** Drive the rollout of middleware that enforces deadline propagation across every service. Measure compliance over six months. Publish progress.

12. **Shutdown protocol.** Author the org's graceful-shutdown library. One root context per service, SIGTERM handler, bounded drain deadline, diagnostics on leaked goroutines. Drive adoption.

13. **Context migration playbook.** If your org is transitioning from a pre-context era to context-aware Go, document the playbook: what to migrate, in what order, how to measure success, how to handle holdouts. Apply to three services. Refine.

14. **Context-incident postmortem library.** Write up the last five context-related incidents at your org. Publish as internal teaching material. The goal is that no junior engineer reaches for a context anti-pattern without having read at least one story showing what goes wrong.
