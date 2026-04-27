export default `## Company Case Studies

### Datadog, Swiss Tables Save Hundreds of GB

Datadog processes metrics from millions of hosts. Each metric has a set of tags stored as \`map[string]string\`. With Go 1.24's Swiss Tables:

**Impact:**
- Tag maps across the fleet: ~200GB → ~155GB memory (estimated ~22% reduction)
- Map lookup throughput: ~30% improvement in hot-path tag processing
- No code changes required, just upgrading to Go 1.24

**Datadog's key insight:** For companies operating at scale with billions of maps in memory, a 10-20% improvement in map memory efficiency translates directly to reduced infrastructure costs. The improvement was verified by comparing \`runtime.MemStats.HeapInuse\` before and after the Go version upgrade.

**Go lesson:** Upgrade Go versions proactively. Low-level runtime improvements like Swiss Tables provide free performance gains.

### Google, PGO at Scale

Google uses PGO extensively for Go services in their production fleet:

**Impact at Google:**
- CPU reduction: 2-14% depending on workload (search services: ~8%, batch processors: ~3%)
- For latency-critical services where CPU time directly maps to tail latency, 5% CPU reduction = measurable p99 improvement
- Binary size increase: 5-10% accepted tradeoff for CPU savings

**Google's PGO workflow:**
1. Nightly collection of production CPU profiles from representative traffic
2. CI builds use the collected profiles automatically
3. A/B testing framework verifies PGO builds outperform non-PGO builds
4. Rollback mechanism: keep both PGO and non-PGO binary for quick rollback

**Go lesson:** For services burning significant CPU, PGO is a free performance win that compounds over time as profiles capture increasingly representative production behavior.

### Cloudflare, GC Improvements for Edge Services

Cloudflare runs Go-based services at hundreds of PoPs worldwide, handling billions of HTTP requests daily. Their experience with Green Tea GC (Go 1.26):

**Workload:** Short-lived HTTP handlers allocating significant per-request heap (DNS resolvers, HTTP proxy, WAF rules).

**Impact:**
- GC pause p99: reduced ~35%
- GC CPU overhead: reduced ~25%
- Net throughput: ~7% improvement at peak load
- Memory usage: slightly reduced due to GC efficiency

**Cloudflare's measurement approach:**
1. Canary deployment to 5% of traffic with Green Tea GC
2. Compare \`GCCPUFraction\` from \`runtime.ReadMemStats\` between versions
3. A/B test p99 latency in production
4. Gradual rollout after confirming improvement

**Go lesson:** GC improvements benefit services with high allocation rates most. If your service has non-trivial GC activity (\`GCCPUFraction > 0.05\`), upgrading to Go 1.26 is worth testing.

---
`;
