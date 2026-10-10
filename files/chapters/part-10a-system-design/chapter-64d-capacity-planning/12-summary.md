## Summary

Capacity planning connects system design theory to production engineering. Estimating that a Twitter DM system requires ~7.5 PB of storage and ~10 application servers, explaining the reasoning in two minutes, and designing an architecture that matches those constraints is the level of analysis expected at senior and staff levels.

The key frameworks to internalize:

**Numbers (memorize these)**:
- Latency: L1 cache (0.5ns) → memory (100ns) → NVMe (100μs) → network (500μs) → HDD (10ms) → cross-continent (150ms)
- HDD IOPS: 100/second. The number that defines when HDDs are unacceptable.
- Seconds per day: 86,400 ≈ 100K
- Storage sizes: tweet (280B), user profile (1KB), photo (3MB), HD video (50MB/min)

**Traffic estimation formula**:
```
Average RPS = (DAU × actions per user) / 86,400
Peak RPS = Average × 2-3
```

**Storage estimation formula**:
```
Total storage = (data per item × item count × retention days × replication factor)
```

**Server sizing formula**:
```
Servers = Peak RPS / (RPS per server × 0.7)
```

**The interview framework**: Clarify scale → Traffic → Storage → Bandwidth → Servers. Always in this order. Always with numbers before architecture.

**Production capacity planning**: Know your runway (months until saturation), keep headroom (target 50-60% utilization), load test to validate estimates, and plan capacity additions three months before you need them.

These skills reduce the risk of capacity-related outages and prepare you for the estimation component of system design interviews.

### Junior → FAANG: Consolidating Capacity Planning as an Interview Skill

The summary recaps the formulas and frameworks that you must be able to execute from memory in an interview. Here is how to use the summary as an active learning tool rather than a passive review.

**Turn each formula into a worked example.** The traffic formula (DAU times actions per user divided by 86,400) is not memorable in isolation. It is memorable when attached to a concrete system. Practice running each formula on at least three systems: Twitter for social media, YouTube for video, Uber for marketplace. When the formula is anchored in real systems, it becomes part of your mental model rather than a rote expression.

**The five-step interview framework is the deliverable.** The most important output of this chapter is not any single formula: it is the ability to execute the five-step framework (clarify, traffic, storage, bandwidth, servers) fluently on any system in under 10 minutes. This is the skill that gets you through the estimation phase of a FAANG system design interview. Every other concept in this chapter serves this framework.

**Production capacity planning extends the interview skill into engineering judgment.** The runway calculation, headroom targets, and load testing practices described in the production section are what you bring to your first senior engineering role. The difference between an engineer who can estimate capacity in an interview and an engineer who can own capacity planning in production is the difference between knowing the formulas and knowing when to apply them, what to measure, and how to act on the results.

**First-job habit:** Within your first month at any engineering role, find the answer to four questions about each service you own: what is the current peak RPS, what is the measured maximum RPS (from load testing or past incidents), what is the current utilization percentage, and what is the monthly growth rate? These four numbers give you the capacity runway and tell you whether action is needed now or can wait. Knowing this for your services before your manager asks is the signal that you own your infrastructure, not just your code.

**Interview entry point:** "Summarize your approach to system design estimation." The expected answer is: "I start by clarifying scale (DAU and usage patterns), then work through traffic (average and peak RPS, separated by reads and writes), storage (data per item times item count times replication times retention), bandwidth (ingress and egress, with CDN split), and server count (peak RPS divided by RPS per server at 70% utilization). Then I validate that the architecture I propose is consistent with the numbers I just produced."

### Senior @ FAANG: Capacity Planning as a Continuous Engineering Practice

At senior level, the summary in this section is the baseline competency for the team, not just for you personally. The frameworks here are the starting point for a much more sophisticated organizational practice.

**From formulas to instrumented systems.** The formulas in this summary are estimation tools. In production, every number in the estimation should be measurable in real time from the service's metrics. DAU comes from analytics. Peak RPS comes from your APM tool. Storage growth rate comes from your storage monitoring dashboard. A staff engineer builds the monitoring infrastructure that makes these numbers visible continuously, so that the estimation phase of a design review can be grounded in actuals, not assumptions.

**From runway calculation to automated alerts.** The runway calculation (months until saturation at current growth) should not be a manual exercise: it should run automatically against real metrics and alert the responsible engineer when the runway drops below the threshold for their resource type. A staff engineer designs or deploys this automated runway system for the team's portfolio of services, with thresholds calibrated to the provisioning lead time for each resource type.

**From headroom targets to cost-efficiency reviews.** Headroom targets (50-70% utilization) prevent reliability failures. They also have a cost implication: running at 50% means you are paying for twice the capacity you use at peak. A staff engineer balances these concerns by establishing a cost-efficiency review cadence: quarterly for stable services, monthly for high-growth services. Services that are persistently below the target utilization band are right-sized downward. Services approaching the upper bound of the target band are provisioned upward proactively. This balance reduces waste while maintaining reliability.

**ADR: capacity planning as an input to organizational goal-setting.** At large organizations, capacity-related engineering work (provisioning new database clusters, migrating to larger instance types, implementing connection pooling) competes with feature development for engineering time. A staff engineer ensures that capacity planning produces work items with explicit urgency based on runway calculations. An item with a three-month runway is higher priority than a feature with no deadline. Runway-based prioritization of infrastructure work is an organizational discipline that prevents reactive fire-fighting.

**L6/L7 concern: capacity planning in the context of organizational growth.** Capacity planning for a service that serves 10 million users is different from capacity planning for a service that serves 1 billion users. At 1 billion users, the planning horizon is longer (growth rate as a percentage is lower, but absolute growth is massive), the architectural choices are fewer (only a handful of databases and storage systems can operate at that scale), and the cost of a wrong capacity decision is higher. A staff engineer joining a team that owns services at this scale must first understand the current capacity model, the growth rate projections, and the architectural constraints that bound the solution space. Capacity planning at this scale is a multi-year strategic activity, not a quarterly operational one.

**Governance: capacity planning documentation as organizational memory.** Capacity plans are most valuable when they are living documents that reflect current reality, not snapshots frozen at the time of initial design. A staff engineer establishes the expectation that every capacity-affecting change (new feature, architectural change, growth event) triggers an update to the relevant capacity plan. Over time, a capacity plan that is kept current becomes the authoritative record of the service's growth trajectory, making future planning easier and reducing the time required to onboard new engineers to the service's scale characteristics.

---

*Next: twenty production-scale system design problem walkthroughs, from Instagram to LLM serving.*
