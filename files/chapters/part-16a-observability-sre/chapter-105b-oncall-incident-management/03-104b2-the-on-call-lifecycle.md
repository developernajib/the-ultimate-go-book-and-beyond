## 105B.2 The On-Call Lifecycle

### Rotation Structure

A production rotation needs at minimum three tiers:

```
Primary (First Responder)
    |
    +--> Acknowledges within SLA (typically 5 minutes)
    +--> Diagnoses and mitigates
    +--> Escalates if needed within 15-30 minutes

Secondary (Backup)
    |
    +--> Activated if primary does not acknowledge within SLA
    +--> Also available for complex incidents needing two engineers

Escalation Path
    |
    +--> Team lead or senior engineer for SEV1/SEV2
    +--> Management chain for customer-impacting outages > 30 minutes
    +--> Dedicated incident commander for major incidents
```

**Rotation cadence.** Most FAANG teams use weekly rotations. Shorter rotations (daily) create excessive cognitive load from context switching. Longer rotations (biweekly) extend suffering when a bad week occurs. Weekly is the right default.

**Team size requirement.** A sustainable on-call rotation requires a minimum of 5-6 engineers. Even at 5, a weekly rotation means being primary roughly one week per month. Below 4 engineers, on-call is not sustainable and becomes a chronic burnout generator.

**Shadow on-call.** New engineers (interns, new hires) should shadow a primary for their first 1-2 rotations before going on-call independently. They observe, help diagnose, and write postmortem drafts without carrying pager responsibility.

### Handoff Protocols

A good handoff takes 30-45 minutes and covers:

```
HANDOFF TEMPLATE
================
Date: [YYYY-MM-DD]
Outgoing: [Name]
Incoming: [Name]

OPEN INCIDENTS
--------------
[ ] Incident #XYZ: [brief description, current state, next action, owner]

ACTIVE CHANGES
--------------
[ ] Deployment of [service] v1.2.3 completing this week - watch for [metric]
[ ] Database migration running Thursday night - may spike connection latency

KNOWN FRAGILE AREAS
-------------------
[ ] Redis cluster is near capacity (87% memory). Alert threshold is 90%.
    Runbook: https://wiki/runbook/redis-memory
[ ] Auth service token refresh has been flaky under high load. Ticket: ENG-4521

RECENT INCIDENTS THIS WEEK
---------------------------
[ ] Mon 14:00: High error rate on /checkout - root cause: bad deploy, rolled back.
    Postmortem: https://docs/postmortem/2026-03-09

THINGS TO WATCH
---------------
[ ] Traffic increases expected Thursday-Friday (product launch)
[ ] New service [payment-worker] deploying Friday - team lead: Alice

RUNBOOK GAPS FOUND THIS WEEK
-----------------------------
[ ] Runbook for "database connection pool exhausted" missing step for AWS RDS.
    ENG-4530 filed
```

The outgoing engineer writes this document. The incoming engineer reviews it synchronously and asks questions. Both sign off.

### On-Call Compensation at FAANG Companies

On-call compensation varies by company and even by org. Commonly reported approaches:

| Company | Approach |
|---|---|
| Google | On-call stipend included in base compensation philosophy, significant time-in-lieu for incidents |
| Amazon | On-call expectation baked into SDE role, incident time compensated via flex time |
| Meta | Dedicated on-call pay for some orgs. Toil reduction is an explicit goal |
| Netflix | High total comp philosophy accounts for operational responsibilities |
| Smaller companies | Explicit on-call pay ($X per week on primary, $Y per incident response) |

The key principle: **on-call should never be free.** Unpaid on-call is exploitation. If a company cannot afford to pay for on-call, they cannot afford the reliability posture they are claiming.

### Sustainable On-Call: Toil Reduction as a First-Class Goal

Google's SRE model has a hard rule: **SREs spend no more than 50% of their time on toil.** If toil exceeds 50%, the team stops feature work and reduces toil first.

This is not aspirational. It is policy. Teams that violate it escalate to SRE management for staffing or architecture intervention.

The mechanisms:
- Automate every repeated manual remediation step
- Create runbooks with automation scripts, not just manual steps
- File toil tickets the same sprint they are discovered
- Review toil metrics in team retrospectives

### Junior → FAANG: The On-Call Lifecycle Is a Loop, Not a Line

The on-call lifecycle does not end at resolution. The post-incident review and the toil reduction that follows are what transform a one-time incident into a permanent reliability improvement. Engineers who treat on-call as "respond, resolve, move on" accumulate debt: the same incidents recur, the same manual steps are repeated, and the on-call burden grows over time.

The toil-filing habit ("file toil tickets the same sprint they are discovered") is the most important habit for long-term on-call health. A toil ticket that is never filed is toil that is never fixed. Make it easy to file: a Slack command that creates a toil ticket from an incident timeline is better than a form that requires five minutes to complete during an already stressful incident.

### Senior @ FAANG: On-Call Lifecycle Metrics and Governance

At L6, instrument the on-call lifecycle itself. Track: time from alert to acknowledgment (should be under 5 minutes for P1), time from acknowledgment to mitigation (should be under 30 minutes for P1), toil ticket creation rate per incident (should be > 0 for every non-trivial incident), and toil ticket completion rate within 30 days (should be > 80%). These metrics reveal bottlenecks in the lifecycle: if mitigation takes too long, runbooks need improvement. If toil completion rate is low, sprint planning is not protecting reliability time.

Publish these metrics on a team dashboard and review them in quarterly reliability retrospectives. The act of measurement creates accountability: teams with visible on-call lifecycle metrics consistently outperform those without, because the data makes the cost of poor practices visible to everyone on the team.

---
