## On-Call Rotation and Alert Design

A page at 3 AM is the most expensive thing a software system can do to a human. The page wakes the engineer, ruins their sleep, costs them the next day's productivity, and slowly depletes their willingness to work on the system at all. A page that turns out to be unactionable is doubly expensive.

The job of alert design is to make every page count. The job of rotation design is to make the on-call experience sustainable.

### Good Alert vs Bad Alert

A good alert is:

- **Symptom-based, not cause-based.** Page on user impact, not on internal state.
- **Actionable.** The on-call can do something about it.
- **Specific.** Names the affected component or signal, not "something is wrong."
- **Timely.** Fires when the impact starts, not after.
- **Linkable.** Includes a runbook URL, a dashboard link, a recent-deploy log.

Examples of good alerts:

- "p99 latency above 200ms for 5 minutes."
- "Error rate above 1% for 5 minutes."
- "Burn rate above 14.4 for 1 hour."

Examples of bad alerts:

- "CPU above 80%." (Not user-impacting, the service might be working fine.)
- "Disk above 90%." (Not actionable in real time, more useful as a ticket.)
- "Memory growing." (Not specific. Growing how fast? To what limit?)
- "Service is restarting." (Restart might be intentional. The user-facing symptom matters.)

### Symptoms Over Causes

A user-facing service has user-facing symptoms: requests fail, requests are slow, requests return wrong data. Page on these.

Internal state (CPU, memory, queue depth) is a debugging signal, not a paging signal. CPU at 80% might be normal saturation that the service handles fine. CPU at 80% combined with rising p99 latency is a different story, that combination is the thing to alert on.

The Google SRE pattern: alert on SLO burn rate (chapter 21), not on internal metrics. The burn-rate alert correlates user impact, time, and severity into one signal. Use multi-window thresholds to keep noise down.

### Page Deflection

Not every alert needs to be a page. The hierarchy:

- **Page.** Wake the on-call. Reserved for user-impacting issues that need immediate human action.
- **Ticket.** Create a ticket for the next business day. For things that need a fix but can wait.
- **Email digest.** Daily summary of low-priority signals.
- **Dashboard.** Always-on visibility, no proactive notification.

Disk usage rising slowly: ticket. p99 above target: page. SSL cert expiring in 30 days: ticket. SSL cert expiring in 1 day: page.

A team that pages on every signal will have an exhausted on-call rotation and a burning team. A team that uses the hierarchy correctly has a sustainable rotation and engineers who do not dread the pager.

### Alert Fatigue

Alert fatigue is the gradual loss of urgency that follows from too many false alarms. The on-call engineer starts ignoring pages, snoozing them, or dismissing without investigation. The first real one in days gets dismissed too.

Symptoms:

- Pages per shift above 2 or 3.
- Pages with no follow-up action recorded.
- "Restart and it goes away" as a normal answer.
- The team avoiding on-call shifts.

Fixes:

- **Audit every alert.** A weekly review of every page from the last week. For each, ask: was this real? Did we take action? Should this still page?
- **Tune thresholds.** A noisy alert is worse than no alert. Tighten the threshold or add a confirmation window.
- **Convert to tickets.** Move non-urgent alerts to a ticket system.
- **Delete.** A page that has not fired correctly in three months is probably wrong. Delete it. If it should have fired, you will rebuild it.

A target: one page per on-call shift, max. Some shifts zero, some shifts two, average around one. Above that, you have alert fatigue building.

### Runbooks

Every alert has a runbook. The runbook is a document that the engineer at 3 AM can follow.

A good runbook has:

- **Symptoms.** What does this alert look like?
- **Diagnostic steps.** What dashboards, logs, queries to check first.
- **Common causes.** What has caused this in the past?
- **Mitigation steps.** Specific commands, with rollback options.
- **Escalation contacts.** Who to call if the runbook does not work.

A bad runbook is "investigate the issue and resolve it." That is not a runbook, that is the absence of one.

A great runbook is detailed enough that a new on-call engineer (six weeks on the team) can follow it successfully. The senior engineer's contribution is writing runbooks at that level of detail.

### Runbook Linkability

Every alert message includes the runbook URL. The on-call engineer's first click is the runbook, not the codebase. A trained team will check the runbook first, an untrained team will start from scratch every time.

In Prometheus alertmanager:

```yaml
- alert: HighLatency
  expr: histogram_quantile(0.99, rate(request_duration_bucket[5m])) > 0.2
  for: 5m
  annotations:
    summary: "p99 latency exceeded 200ms target"
    runbook: "https://wiki.example.com/runbooks/high-latency"
    dashboard: "https://grafana.example.com/d/abc"
```

### On-Call Sustainability

A sustainable rotation:

- **Fewer than 2 pages per shift on average.** Above this, fatigue sets in.
- **Shifts of 1 week, not 1 month.** Long shifts produce burnout.
- **Pay or compensate.** On-call is work, it should be paid extra or compensated with time off.
- **Daytime-only secondary.** A primary on-call who can sleep is more effective. Pair with a "secondary" who handles daytime escalation.
- **Follow the sun.** For global teams, on-call rotates across regions so no one is paged at 3 AM regularly.
- **Postmortems for every page.** A page that does not produce a postmortem is a page that will fire again.

### On-Call Onboarding

A new engineer's first on-call shift should not be alone. The onboarding pattern:

1. Shadow shift: ride along with an experienced on-call, no responsibility.
2. Reverse shadow: take primary responsibility, with an experienced on-call observing and ready to take over.
3. Solo: once both prior shifts went smoothly.

This pattern produces engineers who can handle their first real page calmly. The pattern of "throw them in" produces engineers who freeze on the first page and lose confidence.

### A Real Pattern: Operational Reviews

A weekly meeting (often called "Wheel of Misfortune," "Postmortem Review," or "Operational Review") with the team:

- Walk every page from the last week.
- For each: was it actionable, was the runbook helpful, what should change?
- Walk action items from prior postmortems. What is done, what is in progress, what is stale?
- Surface emerging patterns: "we paged five times for X this week, what is going on?"

The meeting is the loop that turns operational events into operational learning.

### Real Examples

A C++ message-queue service paged 8 times per shift on average. Audit revealed: 4 of the 8 were false positives from a noisy disk-usage alert that had not been tuned in two years, 2 were real but not urgent (next-business-day work disguised as urgent), 1 was urgent but had no runbook (engineer figured it out from scratch each time), 1 was the real reliability signal that warranted attention.

After triage: the noisy alert was tuned, the non-urgent ones became tickets, the unrunbooked alert got a runbook. Pages dropped to 1.5 per shift on average. Engineer satisfaction with on-call rose. The on-call rotation became sustainable, people no longer dreaded their shift.

### Senior at FAANG: The On-Call Architect

The senior contribution is the on-call program: the alerts, the runbooks, the rotation cadence, the onboarding flow, the operational review. A team with a healthy on-call program retains engineers, a team without one loses them. The cost of building this program is small compared to the cost of replacing the team.

---
