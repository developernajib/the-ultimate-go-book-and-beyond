## 105B.11 Interview Questions

These are real questions asked at FAANG and top-tier companies for senior and staff engineer roles. They assess not just knowledge but operational maturity.

---

**Q1. How do you decide what to alert on?**

Expected answer: Alert on user-visible symptoms, not system internals. Use SLO-based alerting. Every alert must be actionable, have a runbook, and be reviewed for false positive rate. Explain multi-burn-rate alerting for error budget consumption.

---

**Q2. What is the difference between an SLI, SLO, and SLA?**

Expected answer:
- SLI (Service Level Indicator): the actual measurement (e.g., "99.2% of requests returned 2xx in the last 30 days")
- SLO (Service Level Objective): the target you are trying to meet (e.g., "99.9% of requests return 2xx")
- SLA (Service Level Agreement): a contractual commitment to customers with financial penalties for breach

Bonus: SLOs are internal operational targets. SLAs are external contracts. You should set SLOs higher than SLAs.

---

**Q3. A service has 99.9% SLO. How many minutes of downtime are allowed per month?**

Expected answer: 43.2 minutes per 30-day month. Formula: (1 - 0.999) * 30 * 24 * 60 = 43.2 minutes. Bonus: explain that "downtime" means being above the error threshold, not complete unavailability.

---

**Q4. Your error budget is 80% consumed with 15 days left in the month. What do you do?**

Expected answer:
- Immediately review what consumed the budget (incident history)
- Apply error budget policy: likely freeze or reduce deployment cadence
- Conduct a reliability sprint on the contributing issues
- Notify engineering manager and relevant stakeholders
- Ensure SLO dashboard is being watched daily

---

**Q5. You are on-call and receive an alert at 2 AM. What is your process?**

Expected answer: Acknowledge within SLA. Open the runbook. Verify the alert is real. Follow diagnosis steps. Apply mitigation. Communicate status if SEV1/SEV2. Declare recovery when metrics return to baseline. Write incident summary even if < 15 minutes. File postmortem if user-impacting.

---

**Q6. What is a blameless postmortem? Why does it matter?**

Expected answer: A postmortem that focuses on systemic causes, not individual blame. Matters because blame produces fear (people hide mistakes, postmortems are incomplete) and blame is almost always incorrect (systems fail due to design gaps, not malicious or stupid humans). Enables honest, complete analysis that produces real fixes.

---

**Q7. How do you write a runbook?**

Expected answer: Runbook includes: alert description, user impact, diagnosis steps (with copy-paste commands), mitigation options, escalation path, post-incident steps. Must be specific, actionable, and linked from the alert. Tested by shadow on-call and updated after every incident where it was used.

---

**Q8. A Go service is experiencing high latency. What do you check first?**

Expected answer:
1. Check which endpoints are slow (not all? single endpoint? upstream?)
2. Check goroutine count (high = possible deadlock or leak under load)
3. Check GC pause duration (high = memory pressure)
4. Check database connection pool (exhausted = queries queuing)
5. Check downstream dependency latency (is it our service or our dependency?)
6. Pull CPU profile if latency is CPU-bound: pprof CPU profile
7. Pull trace for slow requests to identify bottleneck

---

**Q9. How do you handle toil on your team?**

Expected answer: Define toil explicitly (manual, repetitive, automatable). Track it in work logs. Keep below 50% of engineering time (SRE principle). File automation tickets every time toil is encountered. Allocate sprint capacity for toil reduction. Review toil metrics in retrospective.

---

**Q10. Your team's MTTR for incidents is 45 minutes. How do you improve it?**

Expected answer:
- Analyze incident timeline: where was time spent? Diagnosis or mitigation?
- If diagnosis is slow: improve runbooks, add missing metrics, improve logging
- If mitigation is slow: improve rollback tooling, add feature flags, improve deployment speed
- If communication is slow: define IC role and communication templates
- If alerting is slow: tune alert thresholds, review alert routing
- Measure, set target (e.g., 20 minutes), track progress

---

**Q11. What makes a good alert annotation?**

Expected answer: Every alert must include: a human-readable description of what is happening, the current value and threshold, a runbook URL, and optionally a dashboard URL. Example:

```yaml
annotations:
  summary: "Error rate above 1% on {{ $labels.job }}"
  description: "Current error rate: {{ $value | humanizePercentage }}. Threshold: 1%."
  runbook: "https://wiki.internal/runbooks/high-error-rate"
  dashboard: "https://grafana.internal/d/abc123"
```

---

**Q12. How do you ensure action items from postmortems actually get done?**

Expected answer: Make action items SMART (Specific, Measurable, Assignable, Realistic, Time-bound). Assign to named individuals, not teams. Give due dates. Track in project management system (not just in the postmortem doc). Review open action items weekly in team standup. Block postmortem closure until P1 items are scheduled (not necessarily done, but in sprint).

---

**Q13. What is the difference between mitigation and root cause? Why does it matter during an incident?**

Expected answer: Mitigation stops user impact (rollback, restart, feature flag). Root cause is the underlying reason it happened (code bug, design flaw, process gap). During an incident, prioritize mitigation. Users are being impacted. Do not keep the service degraded while investigating the perfect root cause. Once mitigated, investigate safely with preserved artifacts.

---

**Q14. A Go service's memory is growing linearly over 12 hours. How do you diagnose it?**

Expected answer:
1. Check goroutine count: if also growing, likely goroutine + memory leak together
2. Capture heap profile: `curl http://service:6060/debug/pprof/heap > heap.prof`
3. Analyze with `go tool pprof heap.prof` → `top20` to find allocation sites
4. Take two profiles 5 minutes apart and diff them: `go tool pprof -diff_base=heap1.prof heap2.prof`
5. Look for: unbounded caches, event listeners never removed, slices grown without reset, globals accumulating

---

**Q15. How do you set up on-call for a new service?**

Expected answer:
- Ensure service passes production readiness checklist
- Define SLO and error budget policy
- Configure multi-burn-rate alerts
- Write runbooks for every alert
- Add service to the paging tool (PagerDuty or similar) with proper escalation policy
- Schedule rotation with minimum 5 engineers
- Conduct shadow on-call for new engineers
- Set up incident channel naming convention
- Brief team on escalation paths

---

**Q16. What is your alert philosophy for a batch pipeline vs a real-time API?**

Expected answer: Real-time API: alert on error rate and latency percentiles. SLO-based, multi-burn-rate. Batch pipeline: alert on completion rate, data freshness (how old is the newest processed record?), and job failure rate. Latency matters less. Correctness and coverage matter more. Error budget measured in "% of records processed" not "% of requests succeeded."

### Junior → FAANG: How to Use This Question Bank

These 16 questions cover the range of on-call and incident management questions asked at FAANG companies. For each question, prepare: a 30-second conceptual answer (the definition or principle), a 90-second story answer (a specific example from your experience or a realistic hypothetical), and a follow-up answer (one deeper question you would expect and how you would answer it).

Q16 (batch pipeline vs. real-time API alerting) is particularly valuable because it tests whether you understand that SLO definitions are not one-size-fits-all. Being able to articulate the difference without prompting is a strong signal that you have thought deeply about reliability beyond the standard web service case.

### Senior @ FAANG: Bar-Raiser Depth on These Questions

A bar-raiser pushes beyond the expected answer to test for depth. For Q16, the follow-up might be: "Your batch pipeline processes records from a Kafka topic. How would you measure data freshness as an SLI?" The expected senior answer: use the consumer lag metric (difference between latest offset and consumer offset), combine it with the oldest unprocessed record's timestamp, and define freshness as "the maximum age of any unprocessed record in the topic." Alert when freshness exceeds the contractual data delivery SLO (e.g., "all records processed within 1 hour of ingestion").

This depth of answer demonstrates that the candidate can define SLIs for non-standard workloads, which is a staff-level competency: most services are not simple HTTP APIs, and the SRE who can define correct SLIs for batch pipelines, streaming systems, and scheduled jobs provides more value than one who can only apply the request/error/latency template.

---
