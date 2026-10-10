## 90C.1 Why Engineering Metrics Matter

### The Measurement Imperative

Software engineering is one of the few professional disciplines where its practitioners regularly resist measuring their own work. Developers who would never deploy code without tests routinely manage teams without any quantitative feedback on delivery performance, quality, or developer experience.

The consequences are predictable. Without metrics, teams optimize based on intuition and seniority rather than evidence. Senior engineers who believe they are shipping fast are often shocked to discover their lead time is measured in weeks, not days. Managers who feel confident about code quality are surprised when their defect escape rate rivals teams they consider less rigorous.

Metrics create a feedback loop. A team that measures deployment frequency can observe whether a new CI/CD investment actually increased deploy cadence. A team that measures flaky test rate can observe whether their test reliability initiative is working. Without measurement, improvement is invisible.

### Measuring What Matters vs. Vanity Metrics

Not all metrics are created equal. Vanity metrics look good but do not reflect real performance. They satisfy reporting requirements without informing decisions.

**Vanity metrics** (commonly used, often misleading):

| Metric | Why It's a Vanity Metric |
|--------|--------------------------|
| Lines of code written | More code is not better code. Deleting code is often the highest-value contribution. |
| Number of commits | Commit frequency is a style choice, not a productivity signal. |
| Story points completed | Points are team-relative and easily gamed by inflating estimates. |
| Test coverage % | 80% coverage with weak tests is worse than 60% coverage with strong tests. |
| Number of PRs merged | PRs vary in complexity by 3 orders of magnitude. |
| Uptime % | 99.9% uptime hides whether you have one hour of downtime or 1000 one-second incidents. |

**Meaningful metrics** (reflect real performance):

| Metric | Why It Matters |
|--------|---------------|
| Deployment frequency | Direct measure of delivery capability and team agility |
| Lead time for changes | Measures the efficiency of your entire development process |
| Change failure rate | Measures the quality and risk of your deployments |
| MTTR | Measures organizational resilience and recovery capability |
| Cycle time | Measures how long work actually takes from start to done |
| Flaky test rate | Predicts CI reliability and team confidence in tests |
| PR review turnaround | Reflects team collaboration health |

The distinction is causality. Meaningful metrics are causally connected to outcomes you care about: shipping value to users, maintaining stability, and attracting and retaining engineers. Vanity metrics are correlated with activity but not with outcomes.

### FAANG Staff Engineers and Team Health

At senior engineer level, your individual technical contributions are expected. What differentiates senior from staff is your ability to improve the performance of the engineers around you. You are measured not just on what you build but on what you enable others to build.

Engineering metrics are the instrument panel for this responsibility. A staff engineer who cannot answer "what is our deployment frequency?" or "what is our change failure rate?" has not fully taken ownership of team health.

In practice, FAANG staff engineers are expected to:

- **Know the current state**: Be able to quote DORA metrics for their team at any time
- **Track trends**: Identify whether metrics are improving or degrading over the last quarter
- **Diagnose root causes**: When a metric degrades, understand why (tooling, process, people, architecture)
- **Drive improvement**: Propose and execute initiatives that measurably improve metrics
- **Report to leadership**: Summarize team health in terms of metrics in quarterly reviews and promotion packets

If you are preparing for a staff engineer interview at a top company, expect questions like: "How do you measure the health of your team?" or "How would you improve developer productivity?" The expected answer involves specific metrics, baselines, and improvement strategies.

### Junior → FAANG: Building the Metrics Habit Before You Need It

The ability to "report to leadership in terms of metrics" is a skill that requires practice before it is needed. Most junior engineers have never had to present team health data to a VP or engineering director. The first time you do it under real stakes is not the time to figure out how metrics narratives work.

Practice now: after your next project or sprint, write a three-bullet summary of what you shipped and how you know it was successful, using at least one quantifiable metric. Share it in your team Slack. Over time, this habit builds the data collection discipline and communication skill that staff-level roles require.

The "diagnose root causes" skill is also practiced, not innate. When a metric on your team degrades, ask to be involved in the investigation even if it is not your direct responsibility. The investigative process, forming a hypothesis, finding the data that confirms or refutes it, identifying the lever that will change the metric, is the core skill of staff-level engineering.

### Senior @ FAANG: Metrics as Investment Decision Support

At FAANG, the highest-value use of engineering metrics is as investment decision support. When a platform team proposes a three-engineer-quarter investment in CI infrastructure improvements, the decision to fund that investment should be based on measurable current state and projected improvement. If current CI P90 latency is 22 minutes and the improvement is expected to reduce it to 8 minutes for a team of 40 engineers, the ROI calculation is approximately: 40 engineers times 2 hours per day times 0.25 (fraction of time affected by CI wait) times 14 minutes reduction divided by 22 minutes current latency, annualized. That calculation should be in the proposal.

Staff engineers who can construct and defend that kind of ROI argument get platform investments funded. Staff engineers who can only argue that the improvement "would be nice" or "is industry standard" do not. Metrics are the vocabulary of resource allocation at FAANG scale, and fluency in that vocabulary is a multiplier on every proposal you make.

The "baselines and improvement strategies" expected in a staff interview answer require that you have actually measured your team's DORA metrics, not just that you understand what DORA metrics are. Before a FAANG loop, instrument your current team's metrics if they are not already instrumented, collect at least four weeks of data, and identify one concrete improvement initiative with an expected metric outcome. That preparation produces authentic, specific interview answers that no amount of study can replicate.

---
