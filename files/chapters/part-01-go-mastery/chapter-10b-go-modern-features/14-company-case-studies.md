## Company Case Studies

### Observability Pipelines, Swiss Tables at Fleet Scale

Large metrics platforms process data from millions of hosts, and tag sets stored as `map[string]string` dominate the heap of their ingestion services. For a workload shaped like that, the Go 1.24 upgrade delivers a fleet-level result:

**Impact (typical for map-heavy ingestion fleets):**
- Substantial memory reclaimed across the fleet from lower per-map overhead
- Faster map operations on hot-path tag processing
- No code changes required, just upgrading to Go 1.24

**The key insight:** For companies operating at scale with billions of live maps, a double-digit-percent improvement in map memory efficiency translates directly to reduced infrastructure costs, and it can be verified with nothing more than heap metrics before and after the version upgrade.

**Go lesson:** Upgrade Go versions proactively. Low-level runtime improvements like Swiss Tables provide free performance gains.

### Google, PGO at Scale

Google uses PGO extensively for Go services in their production fleet:

**Impact at Google (per the official Go PGO documentation):**
- CPU reduction: roughly 2-14% depending on workload
- For latency-critical services where CPU time directly maps to tail latency, a few percent of CPU back is a measurable p99 improvement
- A modest binary-size increase is the accepted tradeoff for the CPU savings

**Google's PGO workflow:**
1. Nightly collection of production CPU profiles from representative traffic
2. CI builds use the collected profiles automatically
3. A/B testing framework verifies PGO builds outperform non-PGO builds
4. Rollback mechanism: keep both PGO and non-PGO binary for quick rollback

**Go lesson:** For services burning significant CPU, PGO is a free performance win that compounds over time as profiles capture increasingly representative production behavior.

### Edge-Shaped Workloads and the Green Tea GC

Edge services (think Cloudflare-style fleets: Go services at hundreds of PoPs handling short-lived HTTP requests) are the workload shape the Green Tea GC (Go 1.26) helps most: many small, short-lived allocations per request.

**Workload:** Short-lived HTTP handlers allocating significant per-request heap (DNS serving, proxy logic, rules evaluation).

**Impact (the Go team's published range):**
- GC overhead reduced 10-40% on allocation-heavy workloads
- Lower and more stable pause behavior at the tail
- Memory usage slightly reduced due to GC efficiency

**The measurement approach that works:**
1. Canary deployment to a small slice of traffic on the new Go version
2. Compare GC CPU fraction (via `runtime/metrics`) between versions
3. A/B test p99 latency in production
4. Gradual rollout after confirming improvement

**Go lesson:** GC improvements benefit services with high allocation rates most. If your service has non-trivial GC activity (`GCCPUFraction > 0.05`), upgrading to Go 1.27 is worth testing.

---
