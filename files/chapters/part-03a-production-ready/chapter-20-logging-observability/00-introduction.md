# Chapter 20: Logging and Observability

*You can't fix what you can't see.*

Observability is the engineering practice of making a system's internal state legible from its external outputs, without modifying the system or attaching a debugger. In distributed systems where containers restart in seconds and teams deploy dozens of times per day, observability is the difference between resolving an incident in minutes and spending hours firing blind. The three pillars, structured logs, metrics, and distributed traces, serve distinct purposes: logs explain *what happened* for a specific request. Metrics reveal *how the system is behaving* in aggregate over time. Traces expose *why a request was slow* by following it across every service it touched.

Go 1.21 elevated observability to a first-class language concern by introducing `log/slog`, a structured, leveled, high-performance logger in the standard library. Before `slog`, the ecosystem was fragmented between `uber-go/zap`, `rs/zerolog`, and the venerable but unstructured `log` package. Now there is a common interface that third-party handlers can implement, meaning you can swap from a human-readable development backend to a JSON production backend to an OpenTelemetry log exporter with a single line change. Correlation IDs, unique identifiers threaded through every log line, metric label, and trace span for a single request, transform a wall of log entries into a coherent narrative that any engineer can follow from API gateway to database and back.

OpenTelemetry has become the de facto standard for vendor-neutral instrumentation. Its Go SDK lets you emit traces and metrics with a single set of API calls and route them to Jaeger, Tempo, Datadog, Honeycomb, or Google Cloud Trace by swapping the exporter, with no code changes required. Companies that have standardized on OpenTelemetry across large Go fleets consistently report the same two wins: mean time to detect drops because signals are correlated instead of siloed, and on-call engineers pinpoint root causes from a single trace view instead of stitching together three dashboards. The correlation of structured logs with distributed traces is what lets an engineer follow one failing request from the load balancer to the exact slow query, often before customers notice the impact.

**What you'll learn in this chapter:**

- How to use Go 1.21's `log/slog` for structured, leveled logging with pluggable backends for development and production
- How to generate, propagate, and extract correlation IDs across goroutines and service boundaries using `context`
- How to define and instrument Prometheus metrics (counters, gauges, histograms, and summaries) for the signals that matter
- How to instrument Go services with the OpenTelemetry SDK to emit traces, connect spans across service calls, and export to any backend
- How to design log schemas that are queryable in Loki, Elasticsearch, or CloudWatch Logs without post-processing
- How to define SLOs and SLIs in terms of your metrics and build alerting rules that page on symptom, not cause
- How to implement liveness and readiness health check endpoints that integrate with Kubernetes probes
- How to build Grafana dashboards that tell the RED story (Rate, Errors, Duration) for every service at a glance

**Why this matters at scale:**

Google's Site Reliability Engineering book identifies structured logging as one of the most effective practices for reducing toil. The industry consensus, reflected across vendor and practitioner reports, is that teams with correlated logs, metrics, and traces diagnose incidents substantially faster than teams working from logs alone. The mechanism is not mysterious: correlation removes the manual step of stitching three tools together by hand, at exactly the moment when an engineer is least able to do careful work. Organizations that standardize on vendor-neutral instrumentation (like OpenTelemetry) can swap backends without code changes, reducing long-term vendor lock-in and making it practical to evaluate new tools as the ecosystem evolves.

**Prerequisites:** Chapters 1, 19. Familiarity with HTTP middleware patterns and basic Kubernetes concepts.

> **For readers new to observability:** the three pillars (logs, metrics, traces) serve distinct purposes. Learn each. Do not conflate them.
>
> **For readers already senior at a FAANG-equivalent:** the real value is correlation. Logs without trace IDs are noise. Metrics without context are numbers. Traces without log correlation are incomplete. Enforce correlation across the stack.

**Chapter navigation by career stage.**

- **Junior or mid-level:** structured logging with `slog`, basic metrics with Prometheus, request IDs through middleware. Master these.
- **Senior:** distributed tracing with OpenTelemetry, SLO-based alerting, RED-method dashboards.
- **Staff or Principal:** the architectural question is "does our observability infrastructure enable the team to diagnose incidents in minutes?". Drive systemic improvement.

**Staff and Principal lens: observability is the difference between diagnosing incidents in minutes and hours.** The staff-level investment is the observability infrastructure itself: shared libraries, standard dashboards, consistent conventions, OpenTelemetry across services. Without this infrastructure, every incident is an adventure. With it, on-call rotations are sustainable and mean-time-to-recovery drops dramatically.

**Go version note.** `log/slog` (Go 1.21) is the standard logging API. OpenTelemetry Go is stable for traces and metrics, with logs progressing. Prometheus client library remains the de facto metrics library. Modern Go services use all three.

---
