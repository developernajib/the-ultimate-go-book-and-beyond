## Summary

Production debugging is a discipline distinct from development debugging. The tools overlap, Delve, pprof, and goroutine dumps work in both contexts, but the constraints are fundamentally different: you cannot pause the process, you cannot always reproduce the issue, and every diagnostic action risks making the incident worse.

Core production debugging techniques for Go services:

1. **Delve.** Attach to running processes or analyze core dumps post-mortem. Use headless mode with SSH tunneling for remote access. Never attach to all replicas simultaneously.
2. **Core Dumps.** Capture the full memory image at crash time. Limit dump size and configure rotation to prevent disk exhaustion on high-memory services.
3. **Goroutine Dumps.** The fastest way to diagnose deadlocks and goroutine leaks. Parse dumps programmatically to detect stuck goroutines across consecutive snapshots.
4. **pprof.** Run on a dedicated, authenticated port separated from application traffic. Continuous profiling stores historical baselines that make regression detection automatic.
5. **Structured Logs.** Machine-parseable, level-gated, and correlated by trace ID. Replace all `fmt.Printf` debugging with `slog` calls before code reaches production.
6. **Distributed Tracing.** Thread a trace ID through every service hop to collapse the search space from "somewhere in N services" to a specific span.
7. **Runtime Diagnostics.** Expose GC pause durations, heap growth trends, and goroutine counts through JSON endpoints and `GODEBUG` environment variables.
8. **Safety Controls.** Authenticate all debug endpoints, rate-limit goroutine dumps, cap profile durations, and audit every debug session.

The single most important lesson: build your observability infrastructure before you need it. The middle of an incident is the worst time to discover that pprof endpoints are not enabled, that logs lack trace IDs, or that goroutine dumps are not rate-limited.

### For the Senior-at-FAANG Track

Master the diagnostic tools. Lead on-call. Translate incidents into durable improvements.

### For the Staff and Principal Track

Build the shared debugging infrastructure. Train the team. Measure MTTR. Treat debugging capabilities as production readiness.

---
