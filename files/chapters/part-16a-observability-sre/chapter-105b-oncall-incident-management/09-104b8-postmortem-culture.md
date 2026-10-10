## 105B.8 Postmortem Culture

### Blameless Postmortems

The blameless postmortem, pioneered by Etsy and formalized at Google, is the cornerstone of reliability engineering culture. The premise: **systems fail, not people.**

When a human makes a mistake that contributes to an incident, the correct question is not "why did this person do that?" but "why did the system allow or encourage this person to do that?" The answer is almost always: inadequate tooling, insufficient testing, missing safeguards, process gaps, or unclear requirements.

Blame produces two failure modes:
1. Engineers fear making mistakes and become risk-averse (nothing ships)
2. Engineers conceal mistakes to avoid blame (postmortems are useless)

Blameless culture produces:
1. Complete, honest postmortems
2. Systemic fixes that prevent recurrence
3. Engineers comfortable asking for help during incidents

**The blameless principle does not mean no accountability.** If an engineer ignores a known process or behaves recklessly, that is a separate conversation. But the postmortem document itself stays systemic.

### Postmortem Structure

A postmortem template does two jobs: it forces the author to reconstruct the incident factually before drawing conclusions, and it makes every review meeting follow the same shape so nothing is skipped. The template below moves from impact through timeline to root cause analysis and ends where the value is: tracked action items.

```
POSTMORTEM: [Service/Incident Name]
=====================================
Incident Date: [YYYY-MM-DD]
Postmortem Date: [YYYY-MM-DD]
Severity: SEV[1/2/3]
Duration: [X hours Y minutes]
Author: [Name]
Reviewers: [Names]
Status: DRAFT / IN REVIEW / FINAL

EXECUTIVE SUMMARY
-----------------
One paragraph: what happened, how long, user impact, resolution.

IMPACT
------
- Users affected: [number / percentage]
- Duration: [start time] to [end time] ([X] minutes)
- Features affected: [list]
- Downstream services impacted: [list]
- SLO impact: [e.g., "consumed 8.3 of 43.2 monthly error budget minutes"]
- Revenue impact: [if applicable]

TIMELINE
--------
All times in UTC.

[HH:MM] [Event description]
[HH:MM] [Alert fired: alert name]
[HH:MM] [Engineer Name] acknowledged alert
[HH:MM] [Action taken, e.g., "began investigating logs"]
[HH:MM] [Discovery, e.g., "identified database pool exhaustion"]
[HH:MM] [Mitigation attempted, e.g., "killed long-running queries"]
[HH:MM] [Outcome, e.g., "error rate dropped to baseline"]
[HH:MM] Service declared recovered
[HH:MM] Postmortem meeting scheduled

ROOT CAUSE ANALYSIS
-------------------
Primary cause: [specific, technical description]

Five Whys:
1. Why did the service error rate spike?
   → Database connection pool was exhausted
2. Why was the pool exhausted?
   → A deployment introduced a query without connection timeout
3. Why was the query without a timeout?
   → Code review did not catch missing context deadline
4. Why did code review miss this?
   → No automated check exists for missing context propagation
5. Why does no automated check exist?
   → This failure mode was not previously encountered, so no tooling was built

Contributing factors:
- [Factor 1: e.g., "Runbook did not include step for identifying long-running queries"]
- [Factor 2: e.g., "No alert existed for idle-in-transaction connections specifically"]

WHAT WENT WELL
--------------
- [e.g., "Alert fired within 2 minutes of first user impact"]
- [e.g., "Runbook guided engineer to correct diagnosis in 8 minutes"]
- [e.g., "Rollback completed in under 3 minutes once decision was made"]

WHAT WENT POORLY
----------------
- [e.g., "15 minutes elapsed before engineer checked database connection pool"]
- [e.g., "Runbook was missing the pg_stat_activity query for idle-in-transaction"]
- [e.g., "No staging environment test covers connection pool exhaustion scenarios"]

ACTION ITEMS
------------
| ID | Description | Owner | Due Date | Priority |
|---|---|---|---|---|
| AI-1 | Add linter check for missing context propagation to DB calls | @alice | 2026-03-27 | P1 |
| AI-2 | Add alert for pg_stat_activity idle-in-transaction > 5 connections | @bob | 2026-03-20 | P1 |
| AI-3 | Update runbook with pg_stat_activity diagnosis step | @charlie | 2026-03-15 | P2 |
| AI-4 | Add connection pool exhaustion test to staging integration suite | @alice | 2026-04-01 | P2 |
| AI-5 | Document context deadline policy in Go service standards | @dave | 2026-03-31 | P3 |

LESSONS LEARNED
---------------
[2-3 sentences on what this incident taught us about system design, process, or tooling]
```

### Five Whys for Root Cause Analysis

The Five Whys technique (originally from Toyota Production System) is the most practical root cause analysis tool for software incidents. Rules:

1. Ask "why" until you reach a systemic cause, not a human failure
2. Each "why" answer should lead to a more fundamental cause
3. Stop when the answer is "we did not build X" or "process Y does not exist"
4. The fifth why is usually about process, tooling, or organizational structure

**Example: Goroutine Leak Causing OOM**

```
Incident: Service OOM killed at 03:47 UTC. All in-flight requests dropped.

Why 1: Why was the service OOM killed?
→ Memory usage grew from 512MB to 3.2GB over 6 hours

Why 2: Why did memory grow to 3.2GB?
→ 47,000 goroutines were created and not cleaned up (goroutine leak)

Why 3: Why were goroutines not cleaned up?
→ HTTP client goroutines blocked on channel reads that never received values
   because the channel senders exited due to context cancellation

Why 4: Why did the senders exit without sending?
→ The v2.4.1 deployment changed context cancellation timing without updating
   the channel consumer to handle context cancellation

Why 5: Why was the consumer not updated?
→ The code change was reviewed and merged as a "refactor" with no test coverage
   for the goroutine lifecycle under context cancellation
```

Root cause: Missing test coverage for goroutine lifecycle under context cancellation allowed a breaking change to reach production undetected.

**Action items from this 5-why:**
- Add goroutine count check to integration tests (detects leaks before deploy)
- Add context cancellation handling to channel consumer pattern
- Create team coding standard: every goroutine must have explicit lifecycle management with context

### Example Postmortem: Database Connection Pool Exhausted

The following completed postmortem shows what the template looks like when filled in for a real failure mode: the database connection pool exhaustion scenario from the runbook section. Note how the timeline records decisions as well as events, and how every action item traces back to a specific "why" in the analysis.

```
POSTMORTEM: payment-service DB Connection Pool Exhausted
=========================================================
Date: 2026-03-05
Severity: SEV2
Duration: 23 minutes (14:17 - 14:40 UTC)
Author: Alice Chen
Status: FINAL

EXECUTIVE SUMMARY
-----------------
On 2026-03-05, payment-service experienced a 23-minute degradation where
approximately 8,000 users (34% of active users) received payment errors.
Root cause was a new database query introduced in v3.1.0 that ran without
a context deadline, causing long-running transactions to accumulate and exhaust
the 25-connection pool. Recovery was achieved by killing long-running queries
and rolling back to v3.0.9.

IMPACT
------
Users affected: ~8,000 (34% of active users at time of incident)
Duration: 23 minutes
Features affected: Payment checkout (complete failure), Order history (degraded)
SLO impact: 23 minutes consumed (53% of monthly 43.2-minute error budget)
Estimated revenue impact: ~$14,000 in failed transactions

TIMELINE
--------
14:17 UTC  payment-service v3.1.0 deployed to production
14:19 UTC  First long-running queries begin accumulating (silent, no alert yet)
14:22 UTC  DBConnectionPoolExhausted alert fires (>90% pool utilization)
14:23 UTC  Alice acknowledged alert, opened runbook
14:25 UTC  Alice confirms pool at 100% utilization, finds 12 idle-in-transaction connections
14:28 UTC  Alice runs pg_stat_activity query, identifies queries running >5 minutes
14:31 UTC  SEV2 declared, Bob joins as secondary
14:33 UTC  Alice attempts to kill long-running queries
14:35 UTC  Pool utilization drops to 60%, error rate drops from 85% to 15%
14:37 UTC  Rollback decision made (cannot identify safe fix in-incident)
14:38 UTC  kubectl rollout undo executed
14:40 UTC  Error rate returns to baseline (<0.1%), incident resolved
14:45 UTC  Post-incident status update posted, postmortem scheduled

ROOT CAUSE
----------
v3.1.0 introduced a new "generate invoice" endpoint that queries the database
inside a transaction without setting a context deadline. Under normal load,
this query completes in ~200ms. Under the actual production load (invoice
generation requested for a promotional campaign email blast), the query
ran for >5 minutes per request, holding connections in "idle in transaction"
state.

Five Whys:
1. Why did the connection pool exhaust? → Connections held idle in transaction
2. Why were connections idle in transaction? → Queries ran >5 min without timeout
3. Why did queries run without timeout? → No context deadline set on DB call
4. Why was no deadline set? → Developer was unaware of the pattern, and not in code review checklist
5. Why is it not in the checklist? → Pattern was known but never codified, and this was the first time it caused a production incident at this scale

ACTION ITEMS
------------
| ID | Description | Owner | Due | Priority |
|---|---|---|---|---|
| AI-1 | Add go-staticcheck rule for db calls without context propagation | @alice | 2026-03-12 | P1 |
| AI-2 | Add alert: pg_stat_activity idle_in_transaction > 3 for 2 min | @bob | 2026-03-10 | P1 |
| AI-3 | Add context deadline to all db.QueryContext calls in v3.1.x | @carol | 2026-03-10 | P1 |
| AI-4 | Add code review checklist item: context deadlines on all DB calls | @alice | 2026-03-15 | P2 |
| AI-5 | Load test invoice endpoint with campaign-scale traffic before next deploy | @dave | 2026-03-20 | P2 |
```

### Junior → FAANG: Post-Mortem Action Items Must Be Specific and Owned

The five action items in the table above have three properties that make them effective: a specific action (not "investigate latency," but "add alert for pg_stat_activity idle_in_transaction > 3 for 2 minutes"), a named owner (not "the team," but "@bob"), and a deadline. Action items without these three properties reliably do not get done.

For a first job, volunteer to own post-mortem action items even when the incident was not directly yours. Taking ownership of an action item and following it through to completion demonstrates reliability in the literal sense: you can be relied on to close what you commit to.

### Senior @ FAANG: Post-Mortem Culture as a Continuous Improvement System

The post-mortem action items above are not isolated fixes: they form a continuous improvement pipeline. AI-4 ("add code review checklist item") is a systemic fix that prevents the entire class of mistake from recurring in any code change, not just this service. AI-5 ("load test before next deploy") changes the deployment process to catch this failure mode in staging. These process improvements are the highest-value action items: they provide leverage across all future incidents, not just the one that triggered the post-mortem.

An L6 engineer distinguishes between tactical post-mortem action items (fix the specific thing that broke) and strategic action items (change the process so this class of failure cannot reach production). A post-mortem that produces only tactical action items has missed an opportunity. Measuring the ratio of tactical to strategic action items across all post-mortems is a way to assess whether the organization's reliability practice is maturing or stagnating.

---
