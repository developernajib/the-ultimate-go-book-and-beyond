## Summary

Observability pillars and best practices:

1. **Logging**: Use structured logging (slog, zap, zerolog)
 - Include correlation IDs (request_id, trace_id)
 - Avoid logging sensitive data
 - Use appropriate log levels

2. **Metrics**: Prometheus for counters, gauges, histograms
 - Keep cardinality low (< 1000 unique label combinations)
 - Use exemplars for trace correlation
 - Follow RED/USE methods

3. **Tracing**: OpenTelemetry for distributed tracing
 - Sample appropriately in production
 - Propagate context across services
 - Add meaningful attributes to spans

4. **Correlation**: Request IDs and trace IDs everywhere
 - Include in logs, metrics, and traces
 - Propagate across service boundaries
 - Enable jumping between observability tools

5. **Health Checks**: Liveness and readiness probes
 - Liveness: simple alive check
 - Readiness: dependency checks

6. **Alerting**: Alert on symptoms, not causes
 - Use SLOs and error budgets
 - Make alerts actionable
 - Include runbook links

The key insight is that observability is not just about collecting data - it's about being able to answer questions about your system's behavior when things go wrong.

### For the Senior-at-FAANG Track

The key discipline here is correlation: every log, metric, and trace carries the same request ID and trace ID. Without correlation, observability is three separate systems. With it, they form one story.

### For the Staff and Principal Track

The deliverable is the org's observability infrastructure: shared libraries, standard dashboards, SLO definitions, vendor selection. Teams with mature observability resolve incidents in minutes. Teams without spend hours. The investment is unglamorous but produces compounding returns in incident response time and on-call health.

### Mental Model to Take Away

Observability is the team's window into production. Without it, engineers guess at the behavior of systems they own. With it, they understand behavior and diagnose issues quickly. Treat observability as infrastructure: build it once, maintain it continuously, measure its value in MTTR and engineer satisfaction.

---
