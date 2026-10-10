## Interview Questions and Answers

**Q: What is the difference between a feature flag and a configuration flag?**

A: Configuration flags change runtime behavior (log level, timeout values, batch size), they're operational knobs. Feature flags control whether a user sees new functionality, they're release mechanisms. Feature flags require: (1) stable user assignment (same user always gets same experience), (2) metrics tracking per variant, (3) rollout percentage control, (4) kill switch, and (5) cleanup after full rollout. Configuration flags require none of these.

*What FAANG expects:* Mention OpenFeature as the vendor-neutral standard and articulate the flag lifecycle (creation, targeting rule authoring, progressive rollout, full rollout, cleanup). Emphasize that stale flags are technical debt, and that mature organizations auto-expire flags once they have sat at 100 percent for a sustained window.

*Follow-ups:*
- How do you detect and remove stale feature flags in a codebase of 10k+ flags?
- What is the failure mode when your flag service goes down, and how do you design around it? (Answer: bundle last-known-good flag state in the binary, fail closed for new flags, fail open for established flags.)
- How does a permission flag differ from a feature flag, and why should they not share infrastructure?

---

**Q: How do you ensure A/B test assignments are statistically valid?**

A: (1) **Sticky assignment**: use a stable hash of (userID + experimentName) so users don't switch variants between sessions. (2) **Sample Ratio Mismatch (SRM) check**: verify the actual traffic split matches the intended split, a 50/50 experiment with 60/40 actual traffic indicates a bias bug. (3) **Pre-experiment A/A test**: verify the metric is equal between two identical groups before treatment. (4) **Minimum sample size**: calculate required N from desired MDE, α (0.05), and power (0.8) before starting. (5) **Novelty effect**: run long enough (2+ weeks) to eliminate novelty-driven behavior changes. (6) **No peeking**: either fix N up front or use sequential testing (mSPRT, Always Valid Inference).

*What FAANG expects:* Know the peeking problem quantitatively (continuous peeking at α=0.05 inflates type-I error to ~30%) and name a real mitigation (mSPRT at Netflix, Always Valid Inference at Optimizely). Also mention guardrail metrics, primary metrics alone are not enough, a revenue lift that tanks latency is not a win.

*Follow-ups:*
- Your treatment shows 2% lift, p=0.04, n=500 per arm. Do you ship? (Answer: no, MDE at n=500 is much larger than 2%, this is noise.)
- How do you handle multiple concurrent experiments on overlapping traffic? (Answer: orthogonal layers or mutually-exclusive experiment sets, Google's "layers" system.)
- What is a CUPED-adjusted metric and when would you use it?

---

**Q: What are the risks of shadow traffic testing?**

A: (1) **Side effects**: shadow requests to a payment service could charge users twice. Use a `X-Shadow-Request` header that downstream services honor to short-circuit writes, or route the shadow to isolated infrastructure. (2) **Database writes**: shadow must be read-only or target a separate shadow database, never share a write path with production. (3) **Resource consumption**: shadow doubles load on the candidate, capacity-plan accordingly. (4) **False positives**: legitimate non-deterministic differences (timestamps, random IDs, request ordering) look like mismatches, the comparison function must canonicalize these. (5) **Personal data in logs**: shadow diffs often contain PII, ensure log scrubbing before persisting.

*What FAANG expects:* Explain how Istio/Envoy `request_mirror_policies` implement mirroring at L7, and when you would reach for an in-process Go mirror instead (per-request comparison logic, response diffing, business-logic-aware sampling). Mention that the payment-double-charge is a real, recurring class of incident.

*Follow-ups:*
- How do you shadow a stateful service (one that writes to a database)?
- What percentage of traffic do you mirror, and why not 100%?
- Your shadow diff rate is 3%. How do you decide whether that is bugs or noise?

---

**Q: How does progressive canary rollout differ from blue-green deployment?**

A: Blue-green: two full environments, switch all traffic at once, instant cutover but doubles infrastructure cost and all-or-nothing risk. Canary: gradually increase traffic percentage (1% -> 5% -> 25% -> 100%), monitoring error rates and latency at each stage. Canary is safer because failures affect only a small percentage of users initially. The tradeoff is complexity: you must handle two versions in production simultaneously (database schema compatibility, API versioning), and you need a traffic splitting layer (service mesh, ingress controller, or progressive delivery tool like Argo Rollouts or Flagger).

*What FAANG expects:* Name Argo Rollouts (CNCF Graduated) or Flagger as the Kubernetes-native progressive delivery controller, and connect canary analysis to SLO burn-rate alerts rather than raw error thresholds (multi-window multi-burn-rate per the SRE workbook). Mention expand-contract / parallel-change patterns for schema migrations that must stay compatible across the canary window.

*Follow-ups:*
- Your canary looks clean at 5% but fails at 50%. What classes of bugs produce that pattern? (Answer: resource exhaustion, cache hit-rate cliffs, thread-pool contention, database hot partitions.)
- How do you canary a change that cannot be partially deployed, e.g., a breaking protocol change?
- Why is "successful canary" not sufficient evidence to keep the old version, and how long do you keep it warm for rollback?

---

**Q (Junior-track onramp): You have never run a feature-flag rollout. Where do you start?**

A: Pick a small code change you would normally deploy directly. Wrap it in a feature flag (OpenFeature SDK if available, otherwise the store from section 1.1). Deploy with the flag off. Turn it on for yourself via a user-list rule. Verify. Turn it on for the team, verify. Ramp to 1 percent, 10 percent, 100 percent over a day, watching metrics at each step. After full rollout, open a PR to remove the flag. That week-long exercise teaches the rhythm of progressive delivery. I would also ask a senior colleague to review the rollout plan before starting, because there are subtle ways to get matcher logic or sticky assignment wrong that are easier to catch with a second pair of eyes.

Follow-ups:
- "How do you decide how fast to ramp?" (Based on blast radius and metric sensitivity. Fast for low-risk changes with abundant traffic, slow for high-risk changes or low-traffic paths.)
- "What if your team has no flag infrastructure?" (Start with a local OpenFeature adapter backed by JSON config. Upgrade to a managed provider later if the need justifies it.)

---

**Q (Staff-track): You are the staff engineer for a team that deploys directly to production without canary or flags. Write the six-month progressive-delivery rollout.**

A: Month one: introduce feature flags. Get one team member to adopt them in one service. Document the pattern. Month two: introduce canary deployments with a simple router or Argo Rollouts. Run one real canary for a low-risk change. Document. Month three: add automated canary analysis with SLO burn-rate alerts. Tie to one critical service. Month four: introduce shadow traffic for the highest-risk service, validate with response diffing for a two-week window. Month five: formalize the rollout playbook. Require feature flags plus canary for any change on a critical path. Month six: build the dashboards that make rollback decisions data-driven rather than gut-driven. Success metric: number of user-impacting incidents per release. If it drops by 50 percent over six months, the investment is paying off. The staff-level move is not the technical work (which is straightforward) but the cultural change, teaching the team that direct deploys are the exception, not the norm. Without that cultural shift, the technical machinery stays unused.

Follow-ups:
- "What if leadership wants faster velocity than the ramp allows?" (Show the incident data. Progressive delivery catches bugs that would otherwise roll back entire deploys, which is slower than any canary ramp.)
- "How do you handle a team member who resists the process?" (Start with measurable wins. Let one real incident caught by canary be the proof. Cultural change follows evidence.)
- "What is the minimum viable progressive delivery setup?" (Feature flags with a kill switch and a canary router with manual promotion. Everything else layers on top.)

