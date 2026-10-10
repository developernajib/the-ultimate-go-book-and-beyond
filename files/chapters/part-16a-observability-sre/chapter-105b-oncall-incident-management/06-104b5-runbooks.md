## 105B.5 Runbooks

### What Makes a Great Runbook

A runbook is the on-call engineer's playbook for a specific alert. A great runbook has these properties:

1. **Specific to the alert.** Not a general "how this service works" document.
2. **Actionable.** Every step produces an observable outcome.
3. **Copy-pasteable.** Commands are ready to run, not "run the appropriate query."
4. **Time-bounded.** If you have been following this runbook for 30 minutes without resolution, escalate.
5. **Current.** Last updated within 3 months. Stale runbooks are worse than no runbook.
6. **Linked from the alert.** The alert annotation includes the runbook URL. Always.

### Runbook Structure

A consistent structure means an on-call engineer always knows where to look, even in an unfamiliar runbook. The template below orders sections by urgency: summary and impact first, immediate actions next, deeper diagnosis and escalation last.

```
RUNBOOK: [Alert Name]
====================
Last Updated: [Date]
Maintained by: [Team]
Alert: [Alert name and PromQL]

SUMMARY
-------
One paragraph: what this alert means and why it matters.

IMPACT
------
- Who is affected: [end users / internal teams / downstream services]
- User-visible symptoms: [error messages, degraded features, timeouts]
- Business impact: [revenue impact, SLA breach risk, data loss risk]
- Typical duration without intervention: [e.g., "self-resolves in 5 min if traffic spike"]

SEVERITY GUIDANCE
-----------------
- P0 (page now): Error rate > 5% sustained for > 2 minutes
- P1 (page): Error rate 1-5% sustained for > 5 minutes
- P2 (ticket): Error rate < 1% or intermittent

IMMEDIATE ACTIONS (first 5 minutes)
------------------------------------
1. Verify the alert is real (not a monitoring gap)
   $ curl -s https://your-service.internal/healthz | jq .

2. Check if this is a deployment issue
   $ kubectl rollout history deployment/your-service -n production

3. Check current error rate
   [Grafana link to error rate dashboard]

DIAGNOSIS STEPS
---------------
Step 1: Identify which endpoints are failing
  Query: [PromQL]
  Expected: Shows which paths are returning 5xx

Step 2: Check logs for error patterns
  $ kubectl logs -l app=your-service -n production --since=10m | grep "ERROR" | sort | uniq -c | sort -rn

Step 3: Check downstream dependencies
  $ [command to check database connectivity]
  $ [command to check Redis connectivity]

MITIGATION OPTIONS
------------------
Option A: Rollback (fastest if cause is a deployment)
  $ kubectl rollout undo deployment/your-service -n production
  Verify: error rate should drop within 2 minutes

Option B: Scale out (if cause is traffic spike)
  $ kubectl scale deployment/your-service --replicas=10 -n production

Option C: Shed load (if cause is dependency failure)
  $ [feature flag command to disable non-critical features]

ESCALATION
----------
- 15 minutes without resolution: page [Team Lead]
- 30 minutes without resolution or SEV1 impact: page [Engineering Manager]
- Database-related: page [Database on-call]
- Infrastructure-related: page [Platform on-call]

POST-INCIDENT
-------------
- File postmortem if incident lasted > 15 minutes or impacted users
- Update this runbook with any new diagnosis steps discovered
- File tickets for any permanent fixes identified
```

### Example Runbook: Goroutine Leak

Goroutine leaks are among the most common production issues in Go services. A leaked goroutine is one that was started but never terminates, typically blocked on a channel receive, an uncanceled context, or a network read with no deadline. The following runbook walks an on-call engineer through diagnosis and mitigation.

```markdown
RUNBOOK: GoroutineLeakDetected
===============================
Last Updated: 2026-03-01
Alert: goroutines_total > 10000 for 5m

SUMMARY
-------
This alert fires when the number of goroutines in a Go service exceeds 10,000
sustained for 5 minutes. Goroutine leaks occur when goroutines are created but
never terminate - typically from blocked channel receives, context leaks, or
infinite loops without exit conditions.

IMPACT
------
- Memory usage increases linearly with goroutine count (~2KB-8KB per goroutine)
- If unchecked, service will OOM kill within 30-60 minutes of this alert firing
- Active user requests will be dropped when OOM kill occurs
- No data loss risk (assuming stateless service)

IMMEDIATE ACTIONS (first 5 minutes)
-------------------------------------
1. Confirm goroutine count and growth rate:
   $ curl -s http://your-service.internal:6060/debug/vars | jq '.goroutines'

   If growing: proceed immediately
   If stable at high count: lower urgency, investigate next

2. Check if recent deployment correlates with goroutine spike:
   $ kubectl rollout history deployment/your-service -n production

3. Capture goroutine dump BEFORE any restart (critical for diagnosis):
   $ curl -s "http://your-service.internal:6060/debug/pprof/goroutine?debug=2" \
       > /tmp/goroutine-dump-$(date +%s).txt
   Save this file - it is the primary diagnostic artifact.

DIAGNOSIS STEPS
---------------
Step 1: Find the goroutine that is accumulating
  $ grep -A 5 "goroutine [0-9]" /tmp/goroutine-dump-*.txt | \
    awk '/goroutine/{stack=""} /in /{stack=stack" "$0} /^$/{print stack}' | \
    sort | uniq -c | sort -rn | head -20

  Look for: many goroutines with the same stack trace - that is the leak source.

Step 2: Look for common patterns in the dump:
  - "chan receive" - blocked waiting on a channel that is never written to
  - "time.Sleep" in a loop - goroutine sleeping but never exits
  - "net.(*netFD).Read" - stuck on network read (likely unclosed connection)
  - "sync.(*WaitGroup).Wait" - waiting for goroutines that are also leaked

Step 3: Correlate with recent code changes:
  $ git log --oneline -20 -- your-service/

MITIGATION OPTIONS
------------------
Option A: Rollback (if leak started after deployment)
  $ kubectl rollout undo deployment/your-service -n production
  Monitor goroutine count - should stabilize within 5 minutes

Option B: Restart pods (buys time while investigating)
  $ kubectl rollout restart deployment/your-service -n production
  WARNING: This destroys the diagnostic artifact (goroutine dump).
  ALWAYS capture goroutine dump first.

ESCALATION
----------
- 10 minutes without goroutine count stabilizing: page team lead
- If unable to identify leak source from dump: escalate to Go runtime experts

COMMON CAUSES IN THIS SERVICE
------------------------------
- HTTP client requests without context deadline (ENG-3421 - fixed in v1.4.0)
- Background job processor not checking ctx.Done() (ENG-3891 - fixed in v1.6.2)
- gRPC streaming connections not closed on client disconnect (known issue, ENG-4201)
```

### Example Runbook: Database Connection Pool Exhausted

Database connection pool exhaustion occurs when all connections in `database/sql`'s pool are in use and new queries cannot acquire a connection within the configured timeout. Common causes include long-running transactions, queries without context deadlines, and undrained result sets. This runbook covers diagnosis and remediation.

```markdown
RUNBOOK: DBConnectionPoolExhausted
====================================
Last Updated: 2026-02-15
Alert: db_connections_in_use / db_connections_max > 0.9 for 3m

SUMMARY
-------
This alert fires when the database connection pool is over 90% utilized.
At 100%, new database requests queue or fail immediately, causing cascading
errors across the service.

IMPACT
------
- All database-backed endpoints fail with "connection pool exhausted" errors
- Error rate spikes to near 100% of all write operations
- Read operations may succeed if read replicas have separate pools
- Potential: cascading failures to dependent services

IMMEDIATE ACTIONS (first 5 minutes)
-------------------------------------
1. Check current pool utilization:
   $ curl -s http://your-service.internal:6060/debug/vars | \
     jq '{in_use: .db_connections_in_use, max: .db_connections_max}'

2. Check for long-running queries holding connections:
   -- Run on database (read replica is fine)
   SELECT pid, now() - query_start AS duration, query, state
   FROM pg_stat_activity
   WHERE state != 'idle'
     AND query_start < now() - interval '30 seconds'
   ORDER BY duration DESC;

3. Check for idle-in-transaction connections (most common cause):
   SELECT count(*) FROM pg_stat_activity WHERE state = 'idle in transaction';

DIAGNOSIS STEPS
---------------
Step 1: Is this a traffic spike or a leak?
  - Traffic spike: pool utilization correlates with RPS increase
    Check: [Grafana RPS dashboard link]
  - Connection leak: pool utilization grows despite stable RPS
    Check: pool utilization over 1 hour - is it climbing steadily?

Step 2: Identify the query/transaction holding connections
  -- Find transactions open for > 60 seconds
  SELECT pid, usename, application_name, state,
         now() - xact_start AS transaction_duration, query
  FROM pg_stat_activity
  WHERE xact_start IS NOT NULL
    AND now() - xact_start > interval '60 seconds'
  ORDER BY transaction_duration DESC;

MITIGATION OPTIONS
------------------
Option A: Kill long-running queries (fastest)
  -- Kill a specific problematic query
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE now() - xact_start > interval '5 minutes'
    AND state = 'idle in transaction';

Option B: Temporarily increase pool size (buys time)
  -- Via environment variable restart (requires pod restart):
  DB_MAX_CONNECTIONS=50 (was 25)
  $ kubectl set env deployment/your-service DB_MAX_CONNECTIONS=50 -n production

Option C: Rollback if leak started after deployment
  $ kubectl rollout undo deployment/your-service -n production

ESCALATION
----------
- If long-running queries exist but cannot be safely killed: page DBA on-call
- If issue is infrastructure (RDS max connections limit): page Platform on-call
- If > 50% of users impacted: SEV1 declaration required
```

### Junior → FAANG: The Database Runbook as a Template

The database runbook structure above applies to nearly every infrastructure dependency: replace "database" with "cache," "queue," "external API," and the structure is the same: identify the symptom, measure the impact, run the diagnostic queries, apply the known fixes, escalate if unknown. This template approach lets you create runbooks quickly for every new dependency without starting from scratch.

For a first job, write a runbook for every alert before the service goes to production. If you cannot write the runbook (because you do not know what to do when the alert fires), the alert should not exist yet.

### Senior @ FAANG: Runbook Automation and the Runbook-as-Code Pattern

At L6, the goal is to make runbooks executable rather than just readable. The database runbook above contains commands. Those commands can be wrapped in a script. That script can be triggered by a Slack bot. That Slack bot integration reduces MTTR from "engineer reads runbook, types command, waits for output" to "engineer clicks button, sees output." The manual reading step remains (to verify the diagnosis before taking action), but the execution step is automated.

Runbook automation follows a maturity model: level 0 is no runbook. Level 1 is a written runbook with manual steps. Level 2 is a runbook with copy-paste-ready commands. Level 3 is a runbook with executable scripts. Level 4 is a Slack bot that executes the scripts with human approval. Level 5 is autonomous remediation that triggers without human involvement for specific well-understood failure modes. An L6 engineer drives their on-call rotation from level 1 to level 3, and selects specific high-frequency failure modes to advance to level 4 or 5.

---
