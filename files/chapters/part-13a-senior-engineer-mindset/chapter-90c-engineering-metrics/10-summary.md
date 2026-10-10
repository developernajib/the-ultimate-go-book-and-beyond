## Core Metrics Frameworks Summary

Engineering metrics are the compass that allows senior and staff engineers to navigate team performance with evidence rather than intuition. The key frameworks are:

**DORA Metrics** measure delivery performance:
- Deployment Frequency: How often you ship
- Lead Time for Changes: How fast you ship
- Change Failure Rate: How safely you ship
- MTTR: How quickly you recover

**Flow Metrics** measure value stream efficiency:
- Flow Time and Flow Efficiency show where work gets stuck
- Little's Law explains why WIP limits improve throughput
- Cycle time vs. lead time reveals pre-development bottlenecks

**Developer Experience Metrics** measure the friction in your tools:
- Build time, test time, CI time indicate tooling health
- Flaky test rate indicates test quality and CI trustworthiness
- PR review turnaround is the number-one cycle time driver

**Quality Metrics** measure what escapes your safety nets:
- Defect escape rate shows testing effectiveness
- Coverage trends (not absolute) indicate test quality direction
- Security vulnerability aging shows organizational risk posture

**Implementation guidance**:
- Commercial tools (LinearB, Swarmia) are the lowest-friction starting point
- DIY with GitHub API + Grafana provides full control for teams with the investment capacity
- Goodhart's Law protection requires metric families, transparent methodology, and never using individual metrics in performance reviews
- Review metrics weekly (operational), monthly (tactical), and quarterly (strategic)

The engineer who can quote their team's DORA metrics, explain what is driving them, and propose specific improvements is demonstrating staff-level thinking. Master this discipline and you will stand out at every engineering leadership level from senior to VP.

---
