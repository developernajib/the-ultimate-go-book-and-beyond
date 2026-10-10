## 90C.7 Interview Questions

### "How do you measure engineering team health?"

**Strong answer structure**:

"I use three layers of metrics. The first is DORA metrics for delivery performance - deployment frequency, lead time, change failure rate, and MTTR. These give me a quantitative view of how fast and how safely we ship. An elite team deploys multiple times per day with under 5% change failure rate and recovers from incidents in under an hour.

The second layer is flow metrics - specifically cycle time and flow efficiency. DORA tells me about the deployment pipeline, and flow metrics tell me about the entire value stream from idea to production. If my DORA metrics look good but cycle time is long, I have a bottleneck in the pre-development phase - backlog refinement, design review, or prioritization.

The third layer is developer experience metrics - build time, test time, flaky test rate, and PR review turnaround. These are leading indicators. When build times creep up or flaky tests accumulate, DORA metrics degrade within weeks. Fixing developer experience problems before they show up in DORA metrics is the proactive approach.

I review these metrics weekly at the team level and quarterly at the org level, looking for trends rather than absolute values."

### "How would you improve developer productivity by 30%?"

**Strong answer structure**:

"First, I'd measure where time is currently going before proposing solutions. In most teams I've seen, the largest productivity sinks are: (1) long PR review queues - engineers wait hours for feedback and lose context, (2) flaky tests - engineers re-run CI instead of trusting it, (3) slow build/test pipelines - engineers context-switch while waiting, and (4) poor onboarding documentation - new engineers take weeks to reach productivity.

I'd start by measuring PR review turnaround time. If it's over four hours, I'd implement a PR review SLA - first review within two business hours - and add CODEOWNERS-based auto-assignment. In my experience, this alone typically reduces cycle time by 20-30%.

Simultaneously, I'd audit the CI pipeline for flaky tests using failure rate tracking over 30 days. Any test with a flakiness score above 5% gets quarantined - moved to a separate suite that doesn't block deployment - and fixed as a priority.

Finally, I'd profile the build and test pipeline to find the slowest components. Go's build cache is often not configured in CI, and enabling it can cut build time by 50%."

### "How do you avoid teaching engineers to game metrics?"

**Strong answer structure**:

"Goodhart's Law is the biggest risk in any metrics program. My defense is four-pronged.

First, I use metric families rather than individual metrics. If you're measuring deployment frequency, also measure change failure rate. You can game frequency by deploying one-line changes - but if you also measure failure rate, meaningless deploys show up as correlated failures.

Second, I explicitly prohibit using individual metrics in performance reviews. Metrics are team signals, not individual scorecards. The moment an engineer's promotion depends on their PR count, you get meaningless PRs.

Third, I validate quantitative metrics with qualitative signals quarterly - anonymous surveys asking engineers about their actual experience. Metrics that diverge from survey sentiment are being gamed.

Fourth, I publish the calculation methodology. Transparency reduces the impression that metrics are surveillance. Engineers who understand how metrics are calculated and why are less likely to game them and more likely to use them constructively."

### "What's your DORA metric experience?"

Prepare a concrete example:

"In my previous team we inherited a codebase with two-week lead times and a 22% change failure rate - solidly Low performer territory. Over two quarters, we reduced lead time to under a day (High performer) and change failure rate to 8% (High performer) through three initiatives.

First, we broke our two-hour CI pipeline into parallel stages, cutting it to 23 minutes. This alone reduced the PR-to-merge cycle by hours per day.

Second, we implemented automated canary deployments - 5% traffic for 15 minutes, then full rollout if error rates stayed below baseline. This caught three out of our next ten deploys before they became incidents.

Third, we implemented trunk-based development with feature flags, which eliminated long-lived feature branches and the associated merge conflicts and integration problems.

The change failure rate improvement came primarily from the canary deployments. The lead time improvement came primarily from the faster CI pipeline."

---
