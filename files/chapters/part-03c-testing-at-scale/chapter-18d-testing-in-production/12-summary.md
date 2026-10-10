## Summary

Testing in production augments pre-production testing with production-specific validation:

- **Feature flags**: Enable/disable code paths without deployment. Sticky assignment (hash of userID+flagName) ensures consistent user experience. Progressive rollout (1% → 5% → 100%) with automatic rollback on error budget breach is the gold standard for release risk management.

- **Canary deployments**: Route a small percentage of traffic to the new version while monitoring error rates and latency. The `CanaryAnalyzer` automates advancement and rollback decisions. Key metric: canary error rate should not exceed stable error rate by more than a threshold (typically 0.1-1%). Compute every rate over the current stage only, by diffing counter snapshots. Rates accumulated since process start let a long healthy history dilute a fresh regression until the gate stops firing, and a zero-traffic canary must report "no data" rather than a healthy-looking 0%.

- **Shadow traffic**: Mirror real production traffic to a candidate service without affecting user responses. The `ShadowProxy` copies requests in a goroutine with timeout, runs the candidate, compares responses, and tracks mismatch rate. Use for validating refactors, new algorithms, or database migrations before cutover.

- **Synthetic monitoring**: Probes (`HTTPProbe`, `DNSProbe`, `TCPProbe`) run on a schedule to verify availability from the outside, independent of user traffic. They catch issues that only affect specific endpoints or happen during low-traffic periods. Availability over recent history drives SLA reporting.

- **A/B testing**: Controlled experiments that measure the user-behavior impact of a change. Users are randomized *into arms once*, by a stable hash, not re-rolled per request. Significance comes from a two-proportion z-test, and it must be **two-sided**: `normCDF(|z|)` on its own is the one-sided figure and reads 0.95 at |z| = 1.645, which quietly doubles the false-positive rate to roughly 9%. Use `2*normCDF(|z|) - 1`. Fix the sample size up front to avoid the peeking problem, and remember that picking the best of k arms needs a multiple-comparisons correction.

- **Dark launching**: Run new code paths against production traffic in the background, comparing results without affecting users. Catches correctness differences and performance regressions before enabling the feature.

The meta-principle: production is the only environment with real users, real data, and real scale. Use production testing to validate what staging cannot reach: real user behavior, emergent scale effects, and long-running state. Limit the blast radius throughout with progressive rollout and automatic rollback.

**The 2026 stack**: OpenFeature as the flag abstraction, Argo Rollouts or Flagger for progressive delivery tied to SLO burn-rate alerts, Istio/Envoy `requestMirror` or an in-process Go shadow for traffic mirroring, and Datadog / Grafana k6 / Checkly for synthetic monitoring from an independent failure domain. Treat your homegrown code as the seam behind those standards, not a replacement for them.

### For the junior engineer on the FAANG track

Leave this chapter with four habits. First, wrap risky changes in feature flags and ramp them gradually rather than flipping a single switch. Second, read canary dashboards on every rollout until the pattern is reflexive. Third, write one synthetic probe for the critical path on any service you own. Fourth, treat every A/B test with statistical rigor or do not call it an experiment. These four habits are what interviewers probe for when they ask "how do you deploy safely at scale?" Candidates who live them have concrete stories to tell. Those who do not fall back on textbook definitions and come apart under the first follow-up question.

### For the senior engineer at FAANG

Leave this chapter with three artifacts per team or platform. First, a written progressive-delivery playbook: when to use feature flags, canaries, shadow traffic, dark launching, and which combinations apply to which change types. Second, a platform-level canary-and-flag infrastructure that teams opt into with a few lines of config, with automated rollback on baseline SLO signals. Third, a team maturity-model assessment that tracks progress over time and informs hiring, training, and investment decisions. The techniques are ingredients. The playbook, platform, and maturity model are what turn testing-in-production from a collection of tools into an operational capability that scales. Staff-level work is measured by the durability of the capability you leave behind, not the cleverness of any individual release. Write the playbook. Mentor the juniors. Kill the flags that are no longer pulling their weight. The tooling will evolve. The discipline outlives any specific tool.

