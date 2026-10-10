## 105.13 SRE Implementation Frameworks

### SRE Implementation Checklist

SRE implementation succeeds only when each phase builds on the prior one: a team cannot set meaningful SLOs without first measuring baseline SLIs, cannot implement burn rate alerting without defined error budgets, and cannot run effective postmortems without incident severity classifications already in place. Sustainability deserves equal weight alongside correctness, an on-call rotation receiving more than 10 actionable alerts per shift degrades engineer judgment and accelerates burnout, directly reducing the reliability it was intended to protect. Tracking toil explicitly as a percentage of engineering time creates the organizational visibility needed to justify automation investment before toil becomes the dominant activity.

```
┌──────────────────────────────────────────────────────────────────┐
│               SRE IMPLEMENTATION CHECKLIST                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  FOUNDATION:                                                     │
│  □ Define SLIs based on user journeys                            │
│  □ Set achievable SLOs (measure first!)                          │
│  □ Calculate and track error budgets                             │
│  □ Create error budget policy with consequences                  │
│                                                                  │
│  MONITORING:                                                     │
│  □ Implement burn rate alerting                                  │
│  □ Create SLO dashboards                                         │
│  □ Set up multi-window alerts                                    │
│  □ Track budget consumption over time                            │
│                                                                  │
│  INCIDENT RESPONSE:                                              │
│  □ Define severity levels                                        │
│  □ Establish on-call rotation                                    │
│  □ Create runbooks for all alerts                                │
│  □ Set response time targets                                     │
│                                                                  │
│  LEARNING:                                                       │
│  □ Conduct blameless postmortems                                 │
│  □ Track action items to completion                              │
│  □ Share learnings across teams                                  │
│  □ Review SLOs quarterly                                         │
│                                                                  │
│  SUSTAINABILITY:                                                 │
│  □ Track toil and work to reduce it                              │
│  □ Keep on-call healthy (< 10 alerts/shift)                      │
│  □ Maintain runbook currency                                     │
│  □ Invest in automation                                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Key Metrics Reference

| Metric | Healthy Target | Concerning | Critical |
|--------|----------------|------------|----------|
| Alerts per shift | < 10 | 10-20 | > 20 |
| Alert acknowledge time | < 5 min | 5-15 min | > 15 min |
| False positive rate | < 25% | 25-50% | > 50% |
| Toil percentage | < 30% | 30-50% | > 50% |
| Postmortem completion | > 90% | 70-90% | < 70% |
| Action item completion | > 80% | 60-80% | < 60% |
| Error budget remaining | > 50% | 25-50% | < 25% |

### Quick Reference: SLO Targets by Maturity

| Service Maturity | Suggested Availability | Error Budget (30d) |
|------------------|------------------------|-------------------|
| New/Experimental | 99.0% | 7.2 hours |
| Developing | 99.5% | 3.6 hours |
| Production | 99.9% | 43 minutes |
| Critical | 99.95% | 22 minutes |
| Financial/Safety | 99.99% | 4.3 minutes |

## Exercises

1. **Define SLOs, SLIs, and Error Budgets for a Real Service**: Choose a Go microservice (payment processor, authentication service, or similar) and define three distinct SLOs: one availability SLO, one latency SLO, and one data freshness SLO. For each, write the SLI measurement query in PromQL, specify the target percentage, and calculate the error budget in minutes per 30-day window. Document the business justification for each target value: why 99.9% rather than 99.99%? What would the engineering cost of the higher target be? Present the results in a structured markdown table that could be shared with stakeholders.

2. **Implement a Multi-Window Burn Rate Alert**: Implement the Google SRE Workbook multi-window burn rate alerting model for a 99.9% SLO. Write Prometheus alerting rules for four alert conditions: fast burn (1h window, 14.4× burn rate), slow burn (6h window, 6× burn rate), ticket burn (3d window, 1× burn rate), and a combined condition requiring both a short and long window to exceed the threshold simultaneously. Verify each rule with `promtool` and document what user impact each level represents and what the expected response time is.

3. **Write and Test an Incident Runbook**: Select an alert from Exercise 2 and write a complete operational runbook for it. The runbook must include: alert meaning and user impact, step-by-step diagnosis commands (copy-paste ready Go `pprof` commands, PromQL queries, Kubernetes commands), a decision tree for escalation, mitigation options with expected time to resolve, and a rollback procedure. Share the runbook with a colleague and run a 15-minute tabletop exercise where they attempt to follow it during a simulated incident. Update the runbook based on any gaps discovered.

4. **Conduct a Blameless Postmortem**: Simulate or recall a real incident (or use this scenario: a Go service leaked goroutines and ran out of memory over 6 hours, causing 45 minutes of degraded availability). Write a full blameless postmortem document covering: incident timeline with UTC timestamps, impact assessment, root cause analysis using the five-whys technique, contributing factors, and at least five SMART action items with owners and due dates. Identify at least two systemic improvements that would have detected the issue earlier or reduced its blast radius.

5. **Measure and Reduce Toil**: Over one week, log every on-call and operational task performed for a service, categorizing each as toil (repetitive, manual, no lasting value) or engineering work. Calculate your toil percentage at week's end. For the top three toil sources, design an automation solution in Go, for example a CLI tool that automates a manual diagnosis step or a controller that handles a recurring remediation. Implement at least one automation and measure the time saved per incident over the following two weeks.

6. **Set Up and Run a Game Day**: Design a game day exercise to test your service's observability and incident response. Define at least three failure scenarios (e.g., a goroutine leak that grows memory over 30 minutes, a 10% error rate injected via a feature flag, a simulated downstream dependency timeout). For each scenario document the expected alert, expected time-to-detect, expected mitigation steps, and success criteria. Run the game day recording actual times versus expected, then produce a short debrief document identifying gaps in alerting coverage, runbook accuracy, or team response to address before the next exercise.

## Summary

- **SLIs, SLOs, and SLAs**: SLIs measure what users experience (latency, availability, error rate), SLOs set internal targets, and SLAs are contractual commitments. Always set SLOs tighter than SLAs.
- **Error budgets**: The allowed failure time derived from an SLO (e.g., 99.9% availability = 43 min/month). Consuming the budget triggers a freeze on risky changes and a reliability sprint.
- **Multi-window burn rate alerts**: Alert on fast burn (1-hour window) for immediate response and slow burn (6-hour window) for gradual degradation. This reduces false positives compared to threshold alerts.
- **Toil reduction**: Toil is manual, repetitive, automatable work that scales with traffic. Track toil as a percentage of eng time and invest in automation when it exceeds 30%.
- **Incident management**: Define severity levels with clear response-time targets. Use a dedicated incident channel, appoint an incident commander, and track action items in real time.
- **Blameless postmortems**: Focus on systemic causes, not individuals. Complete postmortems within 5 days while memory is fresh and track every action item to closure.
- **Runbooks**: Document step-by-step remediation for every alert. Runbooks reduce mean time to repair (MTTR) and enable on-call engineers to resolve incidents without expert escalation.
- **On-call health**: Keep alert volume below 10 actionable alerts per shift. More than that indicates alert fatigue and insufficient automation, so review and prune regularly.
- **Capacity planning**: Combine historical traffic trends with load-test data to forecast resource needs 6-12 months out. Provision ahead of demand to avoid reactive scaling crises.
- **Reliability as a feature**: SRE frames reliability investment against business impact. Use error budget burn data to justify platform work in product roadmap conversations.

### Junior → FAANG: How to Use This Summary

Each bullet point in the summary above is a potential interview question topic. Read each one and ask: can I explain this concept in two minutes with a concrete example? Can I implement the technical component (PromQL for burn rate, Go code for a runbook runner)? Can I describe a situation where I applied this practice and what the outcome was?

If you can answer yes to all three for each bullet, you are ready for SRE interviews at FAANG-tier companies.

### Senior @ FAANG: Summary as an Organizational Maturity Rubric

Use this summary as a maturity rubric for your team or organization. For each bullet, rate the current state: not in place, partially in place, consistently in place. The gaps are a prioritized reliability investment backlog. An L6 engineer uses this rubric in quarterly reliability reviews with engineering leadership to track progress and justify investment priorities.

The last bullet ("reliability as a feature") is the most important for senior-level work. It frames reliability investment in the language of product management, which is necessary for getting reliability work onto the roadmap. Error budget burn data is the evidence. The business impact translation is the argument. Without both, reliability work competes poorly against feature requests in roadmap prioritization.

---

### Navigation

- **Previous Chapter**: [Chapter 104 - Prometheus & Grafana Mastery](../chapter-104-prometheus-grafana/00-introduction.md)
- **Next Chapter**: [Chapter 105B - On-Call & Incident Management](../chapter-105b-oncall-incident-management/00-introduction.md)
