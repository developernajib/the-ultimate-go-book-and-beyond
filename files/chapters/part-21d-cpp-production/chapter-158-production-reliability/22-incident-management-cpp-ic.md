## Incident Management

A C++ service is on fire. Latency is at 10x baseline, errors are spiking, customers are tweeting. Three engineers are typing in Slack at once, each running a different command. The dashboard has six tabs open. Nobody knows who is in charge.

This is the moment that incident management exists for. A trained team treats this moment like a controlled burn. An untrained team adds chaos to chaos and turns a 30-minute incident into a 3-hour one.

### The IC Role

The Incident Commander (IC) runs the incident. The IC does not necessarily debug. The IC coordinates.

Responsibilities:

- Declare the incident (severity, scope).
- Assign roles (debugger, communicator, scribe).
- Run the bridge (Slack channel, Zoom call, war room).
- Make decisions about mitigation.
- Communicate up (to leadership) and out (to support, to customers).
- Declare resolution.

The IC is not the most senior engineer. The IC is the engineer with the most coordination bandwidth at that moment, often a mid-level engineer with practice.

This is counterintuitive but correct. The senior engineer is the most valuable person at the keyboard, debugging. Pulling them away to do coordination wastes their expertise. The IC is the air-traffic controller, the debugger is the pilot.

### The Roles

A real incident has more than just an IC:

- **Incident Commander.** Coordinates.
- **Investigator / Debugger.** Heads-down on the actual problem. Possibly multiple, each on a different theory.
- **Scribe.** Maintains the timeline document in real time. Every important event, every decision, every action.
- **Communicator.** External-facing. Updates the status page, sends customer emails, talks to support.
- **Subject-matter expert.** Pulled in for specific component knowledge.

Roles are explicit. The IC announces them at the start of the incident and posts them in the channel topic.

### The Communication Discipline

The bridge has rules:

- **One conversation at a time.** Sub-conversations splinter the room. The IC vetoes them.
- **Decisions are announced.** "We are going to roll back to v157, executing now."
- **Hypotheses are labeled as hypotheses.** "I think it might be a thread-pool starvation issue, but I have not confirmed yet."
- **Confirmed facts are labeled as facts.** "Confirmed: tcmalloc bucket exhaustion."
- **Status updates on a cadence.** Every 15 or 30 minutes, the IC posts a summary, even when nothing new has happened.
- **No silent debugging.** An engineer who is heads-down for 20 minutes posts a "still working on X, no update yet" so the IC knows they are alive.

Tooling: a dedicated Slack channel per incident, plus a Zoom or voice bridge. The Slack channel is the timeline of record. The voice bridge is for fast-cycle discussion.

### Mitigation Before Root Cause

The cardinal rule: stop the bleeding first. Find the cause later.

A team that insists on understanding the bug before mitigating will spend two hours diagnosing while the user impact continues. A team that rolls back, flips the kill switch, or sheds load can stop the impact in five minutes and then debug at leisure.

Standard mitigation candidates, in order of speed:

1. **Roll back.** If a recent deploy is suspect, rolling back is fast and reversible.
2. **Flip a kill switch.** If a feature flag is suspect, flipping it is fastest.
3. **Shed load.** Reduce the request rate, drop low-priority traffic.
4. **Failover.** Move traffic to a different region or zone.
5. **Restart.** A blunt instrument, sometimes the right one.

The rule of thumb: if mitigation is reversible (rollback, flag flip), do it. If you find later that it was not the cause, you have lost only the cost of the mitigation, not the time of investigation.

### Escalation Criteria

When does the IC escalate?

- The incident has lasted longer than X minutes (often 30 for Sev 1, 60 for Sev 2).
- The team cannot mitigate without help.
- The blast radius has expanded.
- Leadership wants a status (proactively pull them in if the incident is going to be visible).

Escalation paths are defined in advance: the on-call directory lists the IC's escalation contact, the deeper expert, the leadership contact. The IC does not figure out who to call during the fire.

### War-Room Hygiene

Some operational rules:

- **No food fights.** A blameless culture starts during the incident, not after.
- **One IC at a time.** Handoffs are explicit. "I am handing IC to Carol. Carol, do you accept?" "Accepted." Status updated.
- **Take breaks.** Long incidents (>2 hours) need handoff. An exhausted IC makes worse decisions than a fresh one.
- **Sleep is mitigation.** A senior engineer running on three hours of sleep is a liability. If the team has the depth, send them home and bring in the next shift.
- **The user, not the engineer, is the customer.** Decisions favor what is best for the user, not what is convenient for the engineer.

### A Real Incident Walkthrough

A C++ ad-serving service had a bidder backend hang. The IC walkthrough:

```
T+0:    On-call paged. Latency p99 at 800ms (target 100ms).
T+1:    Acknowledged. IC declared (the on-call themselves, with a debugger
        from the team they paged in).
T+3:    Triage: rolled back the recent deploy as a precaution. Latency does
        not improve.
T+5:    Investigator notes the connection pool is pinned at 100% to one
        bidder. Hypothesis: that bidder is slow.
T+8:    IC decides to circuit-break the suspect bidder via the dynamic flag.
T+9:    Latency drops to 200ms. Better but not target.
T+12:   Investigator finds a second slow bidder. IC adds it to the breaker.
T+13:   Latency at 110ms. Within tolerance.
T+15:   IC posts an "incident mitigated" status. Team continues investigating.
T+30:   Root cause: a network appliance upstream of the two bidders had a
        firmware bug, dropping packets. IC notifies the network team.
T+45:   Status update to leadership. Customer support notified.
T+90:   Network team rolls back the firmware. Bidders return to health.
        Circuit breakers are released.
T+95:   Incident resolved.
```

Key moves:

- The IC made decisions fast, without waiting for full root cause.
- Rollback was tried first as a cheap test, not the cause, but cost only 2 minutes.
- Mitigation (circuit-break the slow bidders) preceded full understanding.
- Communication cadence kept everyone aligned.

A team without practice would have spent the same 95 minutes mostly debugging instead of mitigating, and the user impact would have been 95 minutes long instead of 13.

### Practice

Incident management is a skill, and skills atrophy. Game days (chapter 11) double as practice for the IC role. Run scheduled drills: a mock outage, a real IC running the simulated response. Critique the run. Improve.

A team that runs an IC drill once per month is a team where the on-call engineer at 3 AM does not freeze. A team that has never drilled is a team where the first real incident is also the IC's first incident.

### When to Stand Down

The IC declares the incident over when:

- The user-visible impact has ended.
- The team has agreed on monitoring period to confirm stability.
- The follow-up work is captured in tickets.
- The postmortem owner is assigned.

A premature stand-down (closing too soon) leads to a recurring incident. A delayed stand-down keeps the team on alert unnecessarily. Pick the right moment.

### Senior at FAANG: The Coordinator

The senior contribution is being the calm, structured presence in the room. The IC who keeps the conversation focused, the senior who makes the call to mitigate before debugging, the engineer who refuses to pile blame on a tired colleague at 3 AM. Incident management is a cultural artifact as much as a process, senior engineers shape the culture more than they shape the process.

---
