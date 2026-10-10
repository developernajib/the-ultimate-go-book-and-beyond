## 105.9 Mid-Chapter Synthesis: SRE Core Concepts Recap

### SRE Checklist

A functional SRE practice requires all four pillars, SLO definition, incident management, runbook coverage, and post-mortem culture, to be in place simultaneously. Weak runbooks undermine fast incident response just as much as missing SLOs undermine alerting correctness. Burn rate alerting is the critical link between error budgets and operational response: a high burn rate signals that the error budget will be exhausted before the window closes, triggering escalation before customers breach SLA thresholds. Blameless post-mortems close the learning loop by converting each incident into concrete action items that reduce the probability and impact of recurrence.

```
┌──────────────────────────────────────────────────────────────────┐
│                     SRE CHECKLIST                                │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  SLOs & ERROR BUDGETS:                                           │
│  □ Define SLIs for each critical path                            │
│  □ Set realistic SLO targets                                     │
│  □ Track error budget consumption                                │
│  □ Implement burn rate alerting                                  │
│                                                                  │
│  INCIDENT MANAGEMENT:                                            │
│  □ Define severity levels                                        │
│  □ Establish on-call rotation                                    │
│  □ Create communication templates                                │
│  □ Set response time targets                                     │
│                                                                  │
│  RUNBOOKS:                                                       │
│  □ Document common incidents                                     │
│  □ Include diagnostic commands                                   │
│  □ Define mitigation steps                                       │
│  □ Link alerts to runbooks                                       │
│                                                                  │
│  POST-MORTEMS:                                                   │
│  □ Conduct blameless reviews                                     │
│  □ Identify root cause and contributing factors                  │
│  □ Create actionable follow-ups                                  │
│  □ Track action item completion                                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Chapter Summary as a Preparation Framework

The post-mortem checklist above is also a mental checklist for interview answers about incidents. When an interviewer asks "tell me about a production incident," use this structure: what happened (timeline), contributing factors (what system design decisions allowed the impact to occur), immediate actions taken (what you did to mitigate), and follow-up improvements (what changed to prevent recurrence). This structure shows operational maturity regardless of the specific incident.

### Senior @ FAANG: SRE Practice Maturity as a Promotion Signal

The SRE practices in this chapter represent a maturity model. At L4/L5, engineers implement SRE practices for their own service. At L6, they define standards that make the practices consistent and automatable across all services in their area. At L7 (staff), they influence the org-wide SRE strategy, make investment trade-off decisions with product and business stakeholders, and measure reliability as a business metric.

If you are preparing for an L6 promotion, articulate the scope of your SRE work: how many services have you improved, what org-wide standards have you established, and what is the measured improvement in reliability metrics (MTTR, error budget consumption, on-call alert volume) that resulted from your work.

---
