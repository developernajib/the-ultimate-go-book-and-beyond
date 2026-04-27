export default `## Exercises

1. **Cascading Timeout**: Build a service that calls 3 downstream services with individual timeouts that respect an overall budget.

2. **Context Metrics**: Implement a context wrapper that automatically records metrics (latency histograms, error counts) for each operation.

3. **Tenant Isolation**: Create middleware that extracts tenant ID from JWT, adds to context, and ensures all database queries are scoped to that tenant.

4. **Graceful Degradation**: Build a service that falls back to cached data when context deadline is exceeded for the primary data source.

5. **Trace Visualization**: Implement a trace collector that builds a span tree from context and outputs it as JSON for visualization.

### Senior at FAANG Track

6. **Context-usage audit.** For one production service, find every function that should take context but does not. Refactor. Document the scope of the change.

7. **Deadline-propagation integration test.** Build a CI-runnable test that verifies a request's deadline propagates through every downstream call. Run it in CI. Catch regressions.

8. **Cause migration.** Adopt \`context.WithCancelCause\` throughout one service. Emit metrics per cause. Measure the improvement in diagnostic signal.

### Staff / Principal Track

9. **Org-wide context convention.** Write the one-page guide on context usage for your org. Include context-key registry, middleware requirements, prohibited patterns. Publish. Maintain quarterly.

10. **End-to-end deadline enforcement.** Drive the rollout of middleware that enforces deadline propagation across every service. Measure compliance over six months. Publish progress.

11. **Shutdown protocol.** Author the org's graceful-shutdown library. One root context per service, SIGTERM handler, bounded drain deadline, diagnostics on leaked goroutines. Drive adoption.

12. **Context migration playbook.** If your org is transitioning from a pre-context era to context-aware Go, document the playbook: what to migrate, in what order, how to measure success, how to handle holdouts. Apply to three services. Refine.

13. **Context-incident postmortem library.** Write up the last five context-related incidents at your org. Publish as internal teaching material. The goal is that no junior engineer reaches for a context anti-pattern without having read at least one story showing what goes wrong.
`;
