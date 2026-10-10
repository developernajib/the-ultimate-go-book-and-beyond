## 105C.9 Common Mistakes and How to Avoid Them

| Mistake | Problem | Solution |
|---------|---------|----------|
| Using `fmt.Printf` for logging | Unstructured, unsearchable, no levels | Use `log/slog` with JSON format in production |
| High-cardinality metric labels | Prometheus OOM, performance degradation | Normalize paths, use bounded label values |
| Not sampling debug logs | Storage costs explode at scale | Implement rate-based sampling, always emit errors |
| Missing correlation IDs | Cannot trace requests across services | Generate or propagate correlation ID in every request |
| Logging PII in plain text | GDPR/compliance violations | Mask/redact PII before logging, use structured fields |
| Ignoring log buffering | Every log call is a write syscall | Buffer logs and flush in batches, use async handlers |
| No log rotation | Disk fills up in production | Configure logrotate or use a log shipper |
| Sampling traces without parent-based sampling | Partial traces in Jaeger | Use `ParentBased` sampler so child spans match parent decision |
| Creating new metrics per request | Prometheus cardinality explosion | Create metrics once at startup, add labels at record time |
| Not implementing health endpoints | Load balancer routes to unhealthy instances | Implement `/health/live` and `/health/ready` |

### Junior → FAANG: The Three Mistakes That End Careers Early

Of the ten mistakes above, three are most damaging at the junior level:

**Logging PII in plain text.** This can result in a GDPR breach that requires notifying the data protection authority, disclosing the breach to affected users, and paying fines of up to 4% of global annual turnover. A junior engineer who logs a user's email address or credit card number in a debug statement can trigger an incident that costs the company millions of dollars.

**Not implementing health endpoints.** Without liveness and readiness probes, Kubernetes cannot distinguish between a healthy pod and a deadlocked pod, so it routes traffic to deadlocked pods and does not restart them. This turns a transient bug into a permanent service degradation.

**Creating new metrics per request.** A service that calls `promauto.NewCounterVec()` inside a request handler (instead of registering the counter once at startup) tries to register a new metric on every request. This causes a `duplicate metrics collector registration` panic the second time any request arrives, and the service crashes.

### Senior @ FAANG: Systematic Mistake Prevention at Platform Scale

At L6, each mistake in this table is a candidate for platform-level prevention. PII in logs is prevented by a custom slog handler that redacts sensitive fields. High-cardinality labels are prevented by a CI linter. Creating metrics per request is prevented by a `go vet` analyzer that flags metric constructor calls inside function bodies that are not `main` or `init`. Health endpoints are required by the platform's Kubernetes deployment template.

The principle is: every mistake that appears more than twice across the organization is worth investing in a platform-level prevention. The one-time cost of building the prevention is always less than the ongoing cost of fixing recurring instances of the mistake.

---
