## 105B.6 Incident Response Process

### Incident Severity Classification

| Severity | Definition | Response Time | Examples |
|---|---|---|---|
| SEV1 | Complete service outage or data loss. All users impacted. | Page immediately. Response within 5 min. | Payment service down. Database corrupted. |
| SEV2 | Significant degradation. Majority of users impacted. | Page within 15 min. | Error rate > 10%. All writes failing. Latency > 10x normal. |
| SEV3 | Partial degradation. Minority of users impacted. | Ticket. Response within 4 hours. | Single region degraded. Non-critical feature broken. |
| SEV4 | Minor issue. Users likely unaware. | Ticket. Response within 2 days. | Slightly elevated latency. Cosmetic UI issue. |

### Incident Commander Role

Every SEV1 and SEV2 incident needs an Incident Commander (IC). The IC is not necessarily the most senior technical person. They are the person responsible for:

1. **Maintaining the incident timeline**: documenting what happened, when, and who did what
2. **Communication**: providing status updates to stakeholders on a defined cadence
3. **Coordination**: ensuring the right people are in the room, tasks are assigned, nothing falls through
4. **Decision authority**: breaking ties when engineers disagree on mitigation approach
5. **Mitigation vs investigation balance**: reminding engineers to stabilize first, root-cause later

The IC is NOT responsible for the technical diagnosis. They should have one primary engineer diagnosing and one secondary engineer executing mitigation steps, while the IC coordinates.

**IC checklist during incident:**
```
[ ] Declare incident severity
[ ] Create incident channel (#incident-YYYY-MM-DD-service)
[ ] Assign roles: Primary Diagnostician, Secondary, Comms
[ ] Post initial status update within 10 minutes of declaration
[ ] Update status every 15-20 minutes during active incident
[ ] Notify stakeholders at 30-minute mark if not resolved
[ ] Capture timeline in real time
[ ] Call mitigation (not necessarily root cause) when service recovers
[ ] Schedule postmortem within 24-48 hours
[ ] Post final incident summary
```

### Communication Cadence

During an active incident, silence is the enemy. Stakeholders (product managers, support teams, executives) filling the information vacuum with speculation is worse than a delay in resolution.

**Communication template during incident:**

```
INCIDENT UPDATE - [Service] - [Time]
======================================
Severity: SEV[1/2]
Status: INVESTIGATING / MITIGATING / RESOLVED

IMPACT
What users are experiencing: [specific user-facing symptoms]
Estimated users affected: [number or percentage]
Start time: [HH:MM UTC]
Duration so far: [X minutes]

CURRENT ACTIONS
What we are doing right now: [specific actions]
Who is working on it: [names or team]
Next update in: [15 minutes]

WHAT WE KNOW
Root cause hypothesis: [if known]
Mitigations attempted: [list]

WHAT WE DO NOT KNOW YET
[be honest about unknowns]
```

Post this to:
- Incident Slack channel
- Status page (if customer-visible)
- Stakeholder email/Slack if SEV1

Update every 15-20 minutes until resolved.

### Mitigation vs Root Cause

One of the most important mental shifts in incident response: **stabilize first, investigate later.**

When a service is on fire, the goal is to stop the bleeding. Rollback. Restart. Scale out. Kill bad queries. Disable the feature. Whatever gets the service healthy.

Do not refuse a rollback because "the code is correct and the root cause must be something else." Do not keep a degraded service running while you investigate the root cause perfectly. Users are impacted every second. Restore service first.

Once the service is healthy:
- Preserve diagnostic artifacts (goroutine dumps, heap profiles, logs)
- Schedule postmortem
- Investigate root cause from a position of safety

This is called the **"stop the bleeding, then do surgery"** approach.

### Tools

| Tool | Purpose | Notes |
|---|---|---|
| PagerDuty | On-call scheduling, alert routing, escalation policies | Industry standard. Expensive but reliable. |
| Opsgenie | On-call scheduling, alert routing | Being retired by Atlassian: no new sales since June 2025, support ends April 2027. Functionality moved into Jira Service Management. |
| FireHydrant | Incident management workflow, runbook integration | Purpose-built for incident management. |
| Incident.io | Slack-native incident management | Excellent for teams heavily using Slack. |
| StatusPage | Customer-visible status page | Atlassian product. Simple and effective. |
| Rootly | Incident management with strong automation | Good for larger orgs. |

### Junior → FAANG: Tool Familiarity Is Not the Same as Incident Response Competence

Many engineers think being good at incident response means being fast with PagerDuty and Slack. Tool familiarity is table stakes: the real skill is knowing what questions to ask and in what order. Does the alert correspond to a known failure mode? Did anything change recently (deploy, config change, traffic spike)? Is the impact growing or stable? These questions should be your first actions, before any tool.

For interviews, describe your incident response process independently of the specific tools your previous team used. Interviewers care about your thinking process, not whether you used PagerDuty or Opsgenie.

### Senior @ FAANG: Incident Management Tool Selection and Integration

At L6, incident management tool selection is an architectural decision with long-term implications. The tool must integrate with your alert routing (Alertmanager or PagerDuty), your communication platform (Slack or Teams), your status page (Statuspage.io), and your post-mortem system (a GitHub repo or Notion). Evaluating tools requires mapping these integrations and assessing the operational overhead of maintaining them.

Larger organizations benefit from purpose-built incident management tools (FireHydrant, Rootly, Incident.io) over vanilla PagerDuty because they provide structured incident workflows: automatic role assignment (IC, communications lead, technical lead), automated status page updates from Slack commands, and post-mortem generation from the incident timeline. The organizational time savings from structured workflows justify the tool cost at scale, but the time savings only materialize if the workflows are adopted consistently. Tool adoption without process adoption is expensive infrastructure.

---
