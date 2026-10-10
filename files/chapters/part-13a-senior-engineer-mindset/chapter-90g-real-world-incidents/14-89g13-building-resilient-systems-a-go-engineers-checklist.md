## 90G.13 Building Resilient Systems: A Go Engineer's Checklist

### Infrastructure Resilience

A resilient infrastructure distributes workloads across independent failure domains so that no single hardware failure, regional outage, or provider disruption can take down the entire system. Each item in this checklist addresses a specific blast-radius concern (from BGP route diversity down to out-of-band monitoring), ensuring that the systems you depend on to diagnose failures are themselves immune to those failures.

```
[ ] Multi-region deployment with health-aware routing
[ ] Geopolitical risk assessment for each region
[ ] Submarine cable corridor diversity documented
[ ] Out-of-band monitoring on independent infrastructure
[ ] Recovery runbooks that do NOT depend on failed systems
[ ] Physical access procedures for data center emergencies
[ ] DNS provider diversity (not single-provider)
[ ] BGP route monitoring from external vantage points
```

### Deployment Safety

The majority of production incidents are caused by changes (new binaries, config updates, or feature flag flips) that were not progressively validated before reaching full traffic. This checklist enforces a progressive delivery model where every artifact moves through staged rollout gates, automated health checks gate promotion at each stage, and the rollback mechanism is verified to work even when the service itself is unavailable.

```
[ ] Canary deployment for ALL artifacts (binaries, configs, feature flags)
[ ] Progressive rollout stages: canary → 1% → 10% → 50% → 100%
[ ] Automated rollback on error rate / crash rate threshold
[ ] Rollback mechanism works when the service is down
[ ] Configuration changes go through same pipeline as code changes
[ ] Ordered rule configurations are validated for unreachable rules
[ ] Deployment requires minimum bake time at each stage
```

### Go Runtime

Go's runtime gives engineers direct control over memory pressure, garbage collection frequency, goroutine lifecycle, and allocation hot paths. But the defaults are tuned for development workloads, not production containers. These checks ensure the runtime is configured for your actual memory limits, that goroutine leaks are caught before they exhaust resources, and that allocation-intensive code paths use pooling strategies to minimize GC pressure.

```
[ ] GOMEMLIMIT set appropriately for container memory limit
[ ] GOGC tuned for workload (or off when using GOMEMLIMIT)
[ ] Goroutine count monitored with alerting on sustained growth
[ ] Buffered channels used where sender should not block
[ ] Contexts propagated to all goroutines for cancellation
[ ] sync.Pool used for hot-path transient allocations
[ ] Off-heap storage evaluated for large pointer-heavy caches
[ ] GC pause time monitored (runtime/metrics or GODEBUG=gctrace=1)
```

### Failure Handling

Distributed systems fail in partial and unpredictable ways. A slow downstream service can cascade into full upstream saturation far more destructively than a hard failure would. This checklist encodes the standard defensive patterns: circuit breakers prevent thundering-herd retries against broken dependencies, bulkheads contain failures within isolated resource pools, and load shedding ensures the system degrades gracefully rather than collapsing entirely under overload.

```
[ ] Circuit breakers on all external dependencies
[ ] Retry budget limiting total retries as % of successful requests
[ ] Exponential backoff with full jitter on retries
[ ] Timeout on every external call (no unbounded waits)
[ ] Graceful degradation paths for non-critical dependencies
[ ] Load shedding under extreme pressure
[ ] Bulkhead pattern isolating failure domains
```

### Observability

You cannot debug what you cannot see, and in a distributed Go system the gap between "service is down" and "I know exactly why" is bridged entirely by the quality of your observability stack. This checklist verifies that logs carry correlation identifiers for request tracing, that service dependency graphs are derived from real runtime traffic rather than stale documentation, and that on-call ownership is explicitly assigned so there is never ambiguity about who responds to an alert.

```
[ ] Structured logging with correlation IDs
[ ] Distributed tracing across service boundaries
[ ] Error rate monitoring with anomaly detection
[ ] Output quality monitoring (for AI/ML services)
[ ] Dependency graph discovered from runtime traffic
[ ] Service ownership tracked and alerted when orphaned
[ ] On-call rotation covers all services 24/7
```

### Organizational Resilience

Technical resilience depends on the humans behind the systems maintaining a culture that learns from failure rather than concealing it. Blameless post-mortems convert incidents into institutional knowledge, chaos engineering exercises stress-test assumptions before real outages expose them, and keeping the bus factor above one for every critical system ensures that no single engineer departure creates a single point of failure in your organization.

```
[ ] Blameless post-mortems within 48 hours of incidents
[ ] Action items tracked to completion
[ ] Runbooks maintained and tested quarterly
[ ] Bus factor > 1 for every critical system
[ ] Institutional knowledge externalized into documentation
[ ] Chaos engineering exercises scheduled regularly
[ ] Incident response drills conducted quarterly
```

### Junior → FAANG: Using the Checklist Before a System Design Interview

Work through the full checklist against any system you delivered in the past year. For each unchecked item, ask: why is it unchecked, and what would the consequence be if this gap caused a production incident? This exercise produces concrete interview material. "I noticed we didn't have output quality monitoring for our ML ranking service, so I proposed and built a sampling-based quality check that runs on 5% of production traffic" is a strong answer to "tell me about a time you improved reliability."

### Senior @ FAANG: Checklist as a Production Readiness Review Gate

At L6, this checklist is the foundation of a production readiness review (PRR) process. Every new service, every service reaching a new traffic tier, and every service that takes on a new dependency must pass a PRR against a checklist like this one before being promoted to production. The PRR is reviewed by a technical lead outside the team, because teams under delivery pressure reliably skip checklist items they consider optional. External review is the enforcement mechanism.

At staff level, you own the PRR process itself: the checklist evolves as new failure modes are discovered, the review process is calibrated to the service's criticality, and the checklist completion rate across your org is a leading indicator of reliability. Tracking this metric gives you early warning of teams that are skipping resilience work in favor of feature velocity.

---
