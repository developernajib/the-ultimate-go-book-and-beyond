## Summary

On-call and incident management are not operations work separate from engineering. They are engineering work that closes the feedback loop between code quality and production reality.

The key insights from this chapter:

**Alert on symptoms, not causes.** Multi-burn-rate SLO alerting is the production-grade approach. Every alert must have a runbook and must be actionable.

**Error budgets are the translation layer** between reliability goals and engineering decisions. When the budget is green, ship features. When it is red, ship reliability.

**Runbooks are the contract** between the alert and the on-call engineer. They must be specific, actionable, and copy-paste ready. They must be tested and current.

**Incident response is a process.** Designate an incident commander. Communicate every 15-20 minutes. Stabilize first, investigate second. Preserve diagnostic artifacts before restarting anything.

**Blameless postmortems produce learning.** The goal is systemic fixes that prevent recurrence, not attribution of fault. Action items must be SMART and owned.

**Toil is the enemy of sustainable on-call.** Measure it. Keep it below 50% of engineering time. Automate every repeated manual task.

**Go services must be built for debuggability.** Structured logs with correlation IDs, Prometheus metrics with proper labels, distributed traces, pprof endpoints on internal ports, graceful shutdown, and circuit breakers are not optional. They are the engineering contract that makes incidents survivable.

The engineers who master these practices do not just respond to incidents faster. They build systems that page less often, recover faster when they do page, and improve continuously through honest postmortems. That is the staff engineer standard.

### Junior → FAANG: Summary as a Personal Reliability Pledge

Each bullet point in the summary above represents a commitment to your future on-call colleagues. When you write a feature, ask: "Have I instrumented this for debuggability?" "Is there a runbook for the alert I added?" "Will my deployment strategy protect the error budget?" These questions, asked consistently before merging code, are what separate engineers who make on-call better from those who make it worse.

### Senior @ FAANG: Staff Engineer Standard as an Organizational Target

The final sentence ("That is the staff engineer standard") is a measurable target, not an aspiration. At L6, quantify it: what is the current MTTR for your area? What is the current on-call volume? What is the post-mortem action item completion rate? Set 6-month targets for each metric and make the investments (runbook automation, alert tuning, game days) needed to achieve them. Then repeat. The staff engineer standard is not a destination but a continuous improvement discipline.

---

### Navigation

- **Previous Chapter**: [Chapter 105 - SRE for Go Services](../chapter-105-sre-practices/00-introduction.md)
- **Next Chapter**: [Chapter 106 - Cost-Aware Engineering](../chapter-106-cost-aware-engineering/00-introduction.md)
