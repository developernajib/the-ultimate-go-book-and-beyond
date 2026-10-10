## Common Mistakes and Anti-Patterns

| Mistake | Problem | Fix |
|---------|---------|-----|
| No kill switch on feature flags | Can't quickly disable broken features | Always add explicit enabled/disabled flag |
| Using random assignment for A/B tests | Same user gets different variant each visit | Use stable hash of userID+experimentName |
| Canary with no auto-rollback | Broken canary affects growing % of users | Set error budget threshold with automatic rollback |
| Shadow traffic blocking primary response | Doubles latency for users | Always fire shadow requests in a goroutine |
| Not logging A/B assignment with events | Can't analyze which users saw which variant | Log variant with every tracked event |
| Synthetic probes from single location | Doesn't catch regional failures | Run probes from multiple regions |
| Progressive rollout without warm-up | Statistics meaningless at 1% with 10 users | Require minimum N requests before analysis |
| Feature flag checks everywhere | Flag evaluation scattered, hard to clean up | Centralize behind service methods, remove flags after rollout |
| Dark launch without timeout | Candidate goroutine leaks on slow response | Always use context with timeout for dark traffic |
| Peeking at A/B test p-values | Type-I error balloons from 5% to 30%+ | Fix sample size up front or use sequential testing (mSPRT, AVI) |
| Synthetic probes inside the same cluster | Probes go dark with the service they monitor | Run external probes from an independent failure domain (different cloud, DNS, network) |
| Coupling app code to a flag vendor's SDK | Rewriting every call site to switch vendors | Program against OpenFeature, swap the provider, not the call sites |
| Shadowing a write path without isolation | Double-charges, duplicate emails, corrupted state | Route shadow to read-only infra or have services honor `X-Shadow-Request` |
| Canary threshold on raw error rate | Noisy alerts, slow to detect slow burns | Alert on SLO burn rate with multi-window multi-burn-rate policy |
| Feature flags never removed after rollout | Code complexity grows, 200+ conditional branches accumulate | Set expiration at flag creation, auto-notify owner at expiry |
| A/B test without SRM monitoring | Biased assignment silently invalidates results | Continuous chi-square test on variant split, alert on p < 0.001 |
| Dark launch comparing wrong invariants | Mismatches are noise (timestamp, generated ID), real bugs slip through | Normalize both outputs before comparison, ignore non-deterministic fields |
| Shadow response diffing without tolerance | Every float rounding counts as a diff, real signals lost | Define equivalence tolerances per field type |
| Canary auto-rollback on transient spikes | Benign traffic bumps trigger rollbacks, teams stop trusting automation | Multi-window burn-rate alerts (1h and 6h), require both to fire |
| Synthetic probes with embedded credentials | Probe account compromised, gains production access | Use dedicated probe account with minimum-necessary scopes |
| Canary analysis on counters accumulated since process start | A long healthy history dilutes a fresh regression, so the gate goes quiet exactly when exposure is highest. With 1M good requests behind it, a canary failing 100% of live traffic needs ~20,000 failures to cross a 2% cumulative threshold | Diff counter snapshots taken at the start of each stage. Every rate must come from a bounded, recent window |
| Warm-up check against a cumulative request counter | Satisfied once, then never gates again, so every later stage promotes on a single tick having measured nothing | Count requests *per stage*, and reset the baseline on every stage change |
| Treating "no data" as a healthy rate of 0.0 | A canary receiving zero traffic reads as a flawless 0% error rate and gets promoted. `NaN` from 0/0 is the same trap wearing a disguise: every `NaN > threshold` comparison is false, so the gate silently approves | Return an explicit ok/no-data signal, never a bare 0. Hold position when there is no evidence |

### Junior → FAANG: the "why did this fail?" reflex

For every flag flip, canary rollback, shadow diff, or A/B-test anomaly, ask "why did this fail and what signal would have caught it sooner?" This reflex turns every incident into a learning moment, and the cumulative effect over months is a testing-in-production intuition that no textbook can teach. Engineers who habitually ask this question write safer rollouts, design better dashboards, and catch incidents earlier. Those who skip it tend to meet the same failure again next quarter, wearing a different hat.

### Senior @ FAANG: the progressive-delivery maturity model

At staff level, rate your team on a maturity model for progressive delivery. Level 1: direct deploys with manual rollback. Level 2: canary deploys with manual promotion. Level 3: automated canary analysis with automatic rollback on baseline metrics. Level 4: feature-flagged rollouts with product-owned ramps and shadow validation for high-risk changes. Level 5: SLO burn-rate alerts drive automatic rollback, dark-launch patterns are routine, the platform produces standardized reports on every release. Assess your team honestly. Name the level you are at, the level you want to reach, and the concrete gap. Platform teams and service teams benefit from having a shared vocabulary for this maturity. Staff engineers who publish this model and drive teams up the levels create a durable capability improvement that outlives any individual release.

---
