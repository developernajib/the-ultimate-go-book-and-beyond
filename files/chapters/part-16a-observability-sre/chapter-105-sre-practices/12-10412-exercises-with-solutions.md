## 105.12 Exercises with Solutions

### Exercise 1: Define SLOs for a Service

**Scenario**: You're the SRE for a user notification service that:
- Sends push notifications, emails, and SMS
- Handles 10M notifications/day
- Current metrics: 99.2% delivery success, p99 latency 2s

**Task**: Define complete SLOs for this service.

**Solution**:

```markdown
# SLO Document: Notification Service

## Service Overview
Purpose: Deliver user notifications via push, email, SMS
Traffic: 10M notifications/day (~115 req/sec average)
Dependencies: FCM, SES, Twilio

---

## SLI Definitions

### SLI 1: Availability
Definition: Percentage of notification requests that don't return 5xx
Measurement:
  numerator: sum(rate(notifications_total{status!~"5.."}[5m]))
  denominator: sum(rate(notifications_total[5m]))
Excludes:
  - Client errors (4xx)
  - Downstream failures (tracked separately)

### SLI 2: Delivery Success
Definition: Percentage of notifications successfully delivered
Measurement:
  numerator: sum(rate(notifications_delivered{status="success"}[5m]))
  denominator: sum(rate(notifications_delivered[5m]))
Notes: Tracks actual delivery, not just acceptance

### SLI 3: Latency
Definition: Time from request to notification queued
Measurement: histogram_quantile on request_duration_seconds
Thresholds:
  - P50: 200ms
  - P95: 1s
  - P99: 2s

---

## SLO Targets

### SLO 1: Availability
Target: 99.5%
Window: 30 days
Error Budget: 216 minutes/month (3.6 hours)
Rationale: New service, conservative target
Review: Q2 for potential increase to 99.9%

### SLO 2: Delivery Success (by channel)
Push Notifications: 99.0%
Email: 99.5%
SMS: 99.9% (higher cost, higher expectation)
Window: 30 days
Rationale: Channel-specific due to different reliability

### SLO 3: Latency
99% of requests complete in < 2s
Window: 30 days
Rationale: Notifications aren't real-time critical

---

## Error Budget Policy

### Budget > 50%:
- Normal operations
- Standard release cadence

### Budget 25-50%:
- Review recent changes
- Increase monitoring
- Consider slowing releases

### Budget < 25%:
- Feature freeze (reliability only)
- Daily error budget review
- Postmortems for budget consumers

### Budget exhausted:
- All hands on reliability
- No releases until budget recovers
- Executive escalation

---

## Alerting Strategy

Fast Burn (page):
  - 14.4x burn rate for 1 hour
  - Exhausts budget in ~2 days if it continues

Slow Burn (ticket):
  - 3x burn rate for 6 hours
  - Exhausts budget in 10 days if continues

---

## Dashboard Queries

# Current availability (30d)
1 - (
  sum(increase(notifications_total{status=~"5.."}[30d])) /
  sum(increase(notifications_total[30d]))
)

# Error budget remaining (%)
(0.005 - (
  sum(increase(notifications_total{status=~"5.."}[30d])) /
  sum(increase(notifications_total[30d]))
)) / 0.005 * 100

# Burn rate (1 hour)
(
  sum(rate(notifications_total{status=~"5.."}[1h])) /
  sum(rate(notifications_total[1h]))
) / 0.005
```

---

### Exercise 2: Write Incident Runbook

**Scenario**: Your Go service has an alert "DatabaseConnectionPoolExhausted" that fires when the connection pool is >90% utilized.

**Task**: Write a complete runbook for this alert.

**Solution**:

````markdown
# Runbook: DatabaseConnectionPoolExhausted

## Alert Details
- **Name**: DatabaseConnectionPoolExhausted
- **Severity**: P2 (can escalate to P1 if unresolved)
- **Impact**: New requests may fail, latency spikes
- **Services Affected**: All services using shared PostgreSQL

## Understanding This Alert

This alert fires when database connection pool utilization exceeds
90%. Causes include:
- Traffic spike exceeding pool size
- Slow queries holding connections
- Connection leaks (not closing connections)
- Database slowdown causing connection backup

Without action, connections exhaust → requests fail → outage.

---

## Quick Diagnosis (5 minutes)

### Step 1: Confirm the alert

Before taking any action, verify that the alert reflects a real and current condition rather than a stale or transient spike. Querying Prometheus directly for the connection pool utilization metric gives you an authoritative, point-in-time reading that either confirms the alert is firing for the right reason or lets you stand down quickly.

```bash
# Check current pool utilization
curl -s 'http://prometheus:9090/api/v1/query?query=pg_pool_utilization' | jq
```
Expected: Value > 0.9 if alert is valid

### Step 2: Check active connections

A saturated connection pool is often a symptom of queries that are taking too long and holding connections open, so counting the active sessions on the database host is the next logical pivot. An unusually high active connection count points toward slow query accumulation rather than a sudden traffic surge, and steers your investigation toward query-level remediation.

```bash
# SSH to database host
psql -c "SELECT count(*) FROM pg_stat_activity WHERE state = 'active';"
```
Expected: High number indicates slow queries

### Step 3: Identify slow queries

With high active connection count confirmed, the priority shifts to finding exactly which queries are responsible so they can be killed or tuned. Sorting active sessions by elapsed duration surfaces the worst offenders immediately, and any query running beyond ten seconds is a strong candidate for either termination or emergency index addition.

```bash
psql -c "
SELECT pid, now() - pg_stat_activity.query_start AS duration, query
FROM pg_stat_activity
WHERE state = 'active'
ORDER BY duration DESC
LIMIT 10;"
```
Expected: Look for queries running > 10 seconds

### Step 4: Check for recent deployments

Query slowdowns that appear suddenly often trace back to a code change that introduced a missing index, an unintended full-table scan, or a new query pattern the database planner handles poorly. Reviewing the rollout history for the affected service reveals whether a deployment correlates temporally with the onset of the issue, which can make a rollback the fastest path to recovery while a proper fix is prepared.

```bash
kubectl rollout history deployment/api-service | head -5
```
Expected: Recent deployment may correlate with issue

---

## Mitigation Actions

### If: Slow queries identified
**Action**: Kill long-running queries
```bash
psql -c "SELECT pg_cancel_backend(PID);" # Replace PID
```
**Risk**: Low - query will retry
**Duration**: Immediate effect

### If: Traffic spike
**Action**: Scale up service (spreads load)
```bash
kubectl scale deployment/api-service --replicas=10
```
**Risk**: Low
**Duration**: 2-3 minutes for pods to become ready

### If: Connection leak suspected (recent deploy)
**Action**: Rollback
```bash
kubectl rollout undo deployment/api-service
```
**Risk**: Medium - may roll back wanted changes
**Duration**: 5 minutes

### If: Database slow
**Action**: Enable connection queue and increase timeout
```bash
kubectl set env deployment/api-service \
  DB_POOL_QUEUE_SIZE=100 \
  DB_POOL_TIMEOUT=60s
```
**Risk**: Adds latency but prevents failures
**Duration**: Immediate after rollout

### Emergency: Pool fully exhausted
**Action**: Restart service (clears connections)
```bash
kubectl rollout restart deployment/api-service
```
**Risk**: Brief downtime during restart
**Duration**: 2-3 minutes

---

## Root Cause Investigation

After mitigation, investigate:

1. **Check connection metrics over time**
   Dashboard: [link to grafana dashboard]
   Look for: Gradual vs sudden increase

2. **Review logs for connection errors**
   ```bash
   kubectl logs -l app=api-service --since=1h | grep -i "connection"
   ```

3. **Check code for missing connection close**
   Common patterns:
   - Missing `defer rows.Close()`
   - Missing `defer stmt.Close()`
   - Error paths that skip cleanup

---

## Escalation

| Time | Action |
|------|--------|
| 15 min | If not mitigated, escalate to secondary on-call |
| 30 min | If unresolved, escalate to database team |
| 1 hour | If ongoing, escalate to engineering lead |

**Contacts**:
- Database team: #db-oncall (Slack)
- Engineering lead: [PagerDuty schedule]

---

## Post-Incident

- [ ] Document timeline in incident channel
- [ ] Create postmortem ticket if P1/P2
- [ ] Review for automation opportunities
- [ ] Consider lowering alert threshold (currently 90%)

---

## Related Runbooks

- [DatabaseHighLatency](./database-high-latency.md)
- [HighErrorRate](./high-error-rate.md)
- [ServiceScaling](./service-scaling.md)
````

---

### Exercise 3: Conduct Error Budget Analysis

**Scenario**: Your service has:
- SLO: 99.9% availability (30-day window)
- Last 30 days: 15 incidents consuming error budget
- Current availability: 99.85%
- 5 days remaining in the month

**Task**: Analyze error budget status and recommend actions.

**Solution**:

```markdown
# Error Budget Analysis: User Service

## Current Status

### Budget Calculation
- SLO Target: 99.9%
- Error Budget: 1 - 0.999 = 0.001 (0.1%)
- Monthly Window: 30 days = 43,200 minutes
- Total Budget: 43,200 × 0.001 = 43.2 minutes

### Consumption
- Current Availability: 99.85%
- Error Rate: 1 - 0.9985 = 0.0015 (0.15%)
- Budget Consumed: 0.0015 / 0.001 = 150%
- Overage: 50% over budget
- In Minutes: ~64.8 minutes downtime (21.6 min over budget)

### Status: CRITICAL - Budget Exhausted

---

## Incident Analysis

### Top Error Budget Consumers (last 30 days)

| Incident | Duration | Budget % | Root Cause |
|----------|----------|----------|------------|
| INC-001 | 22 min | 51% | Database failover |
| INC-004 | 15 min | 35% | Bad deployment |
| INC-007 | 8 min | 19% | Memory leak |
| INC-012 | 5 min | 12% | Network partition |
| Others | 14 min | 32% | Various |

**Analysis**: Two incidents (INC-001, INC-004) consumed 86% of budget.
These are preventable with better deployment practices and failover
testing.

---

## Recommendations

### Immediate Actions (This Week)

1. **Feature Freeze**
   - No new features until budget recovers
   - Only reliability and bug fixes
   - Enforce via PR labels

2. **Reduce Risk Exposure**
   - Postpone scheduled maintenance
   - Reduce deployment frequency
   - Add canary requirements for all deploys

3. **Improve Detection**
   - Lower alert thresholds
   - Add pre-deployment health checks
   - Enable more aggressive circuit breakers

### Medium-Term Actions (Next Sprint)

1. **Address Top Consumers**
   - INC-001: Add database failover testing to QA
   - INC-004: Implement canary deployments
   - INC-007: Add memory limit alerts

2. **Process Improvements**
   - Require load testing for changes > 100 LOC
   - Add integration test for database failover
   - Review deployment checklist

### Long-Term Actions (Next Quarter)

1. **SLO Review**
   - Consider if 99.9% is appropriate
   - May need 99.5% while system matures
   - Revisit after implementing improvements

2. **Automation**
   - Auto-rollback on error rate spike
   - Automated canary analysis
   - Self-healing for common failures

---

## Burn Rate Projections

### If Current Rate Continues:
- Remaining 5 days at current burn rate
- Will end month at ~99.82% (vs 99.9% target)
- Additional budget consumed: ~13 minutes

### To End Month at Target:
- Not achievable: budget is already 50% overspent
- Even 100% availability for the remaining 5 days ends the month at 99.85%
- Any further incident increases the overage

### Realistic Target:
- Aim for 99.95% for remaining 5 days
- Adds ~3.6 minutes to consumption
- Total month: ~99.84%

---

## Communication Template

**To: Engineering Leadership**
**Subject: Error Budget Status - User Service**

The User Service has exhausted its monthly error budget:

- Target: 99.9% availability
- Actual: 99.85% availability
- Status: 50% over budget

Two incidents accounted for 86% of consumption:
1. Database failover (preventable with testing)
2. Bad deployment (preventable with canaries)

Actions taken:
- Feature freeze effective immediately
- Added deployment review requirements
- Scheduled postmortems for both incidents

Actions planned:
- Implement canary deployments (2 weeks)
- Add database failover to QA testing (1 week)

Request: Engineering lead approval for feature freeze
until budget recovers (estimated: 10 days into next month).
```

### Junior → FAANG: Exercise Completion as Interview Preparation

The error budget communication exercise at the end is the most FAANG-relevant one. The ability to write a clear, data-driven communication to engineering leadership about a reliability situation (budget consumed, feature freeze requested, specific action items) is a skill tested in L5+ behavioral interviews.

Practice writing this communication for a hypothetical scenario before the interview. Include: current budget remaining (number and percentage), burn rate and time to exhaustion (calculated, not estimated), two to three specific action items with owners and deadlines, and a clear request for the decision you need leadership to make.

### Senior @ FAANG: Using Exercises to Define Team Standards

The post-mortem exercise and the error budget communication exercise are the foundation of an SRE practice workshop for engineering teams. An L6 engineer facilitates this workshop for each team they work with, using realistic scenarios from the team's actual service history. The workshop output is: a draft error budget policy (reviewed and refined from the exercise), a standard post-mortem template (adapted from the exercise template), and a set of SLO definitions for the team's primary services.

Running this workshop across multiple teams is an L6-scope activity: it standardizes SRE practices without requiring top-down mandates, and it gives teams the tools they need to self-govern their reliability rather than relying on a central SRE function.

---
