## 105.11 Interview Questions: SRE Practices

### Question 1: How would you design SLOs for a new service?

**What FAANG expects:** User-journey SLIs (not infrastructure metrics), achievable targets from 30 days of historical data (not aspirational 99.99% pulled from thin air), an error-budget policy (what happens when budget is spent, feature freeze? Extra reliability work?), and multi-window multi-burn-rate alerts (2% of budget in 1h = page, 10% in 3d = ticket). Bonus for citing the Google SRE Workbook (Ch. 2 on implementing SLOs, Ch. 5 on alerting on SLOs), and naming Sloth or OpenSLO as the spec-driven approach.

**What Interviewers Look For:**
- Understanding of SLO fundamentals
- User-centric thinking
- Practical implementation experience
- Business alignment

**Strong Answer Framework:**

```markdown
# Framework: SLO Design Process

## Step 1: Understand the User Journeys (30 seconds)
"First, I identify what success looks like for users:
- For an API: Did the call succeed and return in time?
- For a website: Did the page load and function?
- For a batch job: Did it complete correctly?"

## Step 2: Define SLIs (45 seconds)
"I define measurable indicators:
- Availability: (successful requests) / (total requests)
- Latency: Percentage of requests under target threshold
- Correctness: Percentage returning valid data
- Freshness: Data staleness for async systems

Key: Measure from user perspective, not server perspective."

## Step 3: Set Initial Targets (30 seconds)
"For a new service, I'd:
1. Measure baseline for 2-4 weeks
2. Set SLO slightly above current performance
3. Target 99.5% initially, not 99.99%
4. Plan to tighten once we understand the system

Starting too aggressive leads to burned budgets and ignored SLOs."

## Step 4: Implement Measurement (30 seconds)
"I'd instrument with Prometheus:
- Histogram for latency (buckets at SLO thresholds)
- Counter for requests by status class
- Recording rules for SLO calculations
- Dashboard showing budget consumption"

## Step 5: Establish Consequences (30 seconds)
"SLOs without consequences are just metrics:
- Define error budget policy
- Get product buy-in for feature freezes
- Tie SLO health to release decisions
- Review SLOs quarterly and adjust"

## Example Answer (30 seconds)
"For my last service, I started with 99.5% availability and
P99 latency under 500ms. After 6 months of consistently
exceeding these, we tightened to 99.9% availability.
The key was measuring first, then committing to achievable
targets, and having executive buy-in for the error budget
policy."
```

---

### Question 2: You're paged at 3 AM for a P1. Walk me through your incident response.

**What FAANG expects:** Acknowledge → Assess → Communicate → Mitigate → Resolve → Retrospect. Communicate early and often (status page, stakeholders) before you have root cause. The first 10 minutes: stop the bleeding (rollback, scale up, disable feature flag) *before* debugging. Incident commander vs subject-matter-expert split in big incidents. Bonus for naming ICS (the Incident Command System borrowed from emergency services) and for knowing that Google's postmortem format and Amazon's COE (Correction of Error) are the two influential public templates.

**What Interviewers Look For:**
- Structured incident management
- Prioritization under pressure
- Communication skills
- Systematic debugging

**Strong Answer Framework:**

```markdown
# Framework: Incident Response

## First 5 Minutes: Triage
"When I get paged, I:
1. Acknowledge the page (stops escalation timer)
2. Open the alert - understand what triggered it
3. Check if it's a real incident or false positive
4. Determine severity based on impact

I'm NOT trying to fix it yet - just understand scope."

## Minutes 5-15: Assess and Communicate
"Once I confirm it's real:
1. Check dashboards - what's the blast radius?
2. Declare incident in our incident channel
3. Post initial update: what we know, what we're checking
4. If P1/P2, wake up secondary on-call

Communication template:
- WHAT: 'Payment service returning 500s'
- IMPACT: '30% of checkouts failing'
- STATUS: 'Investigating'
- ETA: 'Update in 15 minutes'"

## Minutes 15-30: Investigate
"I follow the runbook:
1. Check recent deployments (most common cause)
2. Check dependency health
3. Check resource exhaustion (CPU, memory, connections)
4. Look at logs for the time window

If I find a likely cause, I start mitigation in parallel."

## Mitigation
"I prefer fast mitigation over perfect diagnosis:
- Recent deploy? Rollback immediately
- Dependency down? Enable circuit breaker
- Resource issue? Scale up temporarily

I can do root cause analysis after users are happy."

## Resolution and Follow-up
"Once mitigated:
1. Monitor for 15-30 minutes to confirm stable
2. Post final update with resolution
3. Schedule postmortem within 48 hours
4. Go back to sleep (important for sustainability)"

## Key Principles
"- Communicate early and often
- Bias toward fast mitigation
- Don't be a hero - escalate when stuck
- Document everything for the postmortem"
```

---

### Question 3: Your team is drowning in alerts. How do you fix alert fatigue?

**What FAANG expects:** Every alert must be actionable (has a runbook, needs human action, cannot be auto-remediated). Kill symptom alerts (CPU 80%), keep SLO-burn alerts. Baseline metric: on-call shifts should see < 2 pages per 12-hour shift long-term. Bonus for citing "My Philosophy on Alerting" by Rob Ewaschuk (Google) and the alert-to-ticket ratio as a leading indicator of alert hygiene.

**What Interviewers Look For:**
- Understanding of alert design
- Actionability focus
- Data-driven approach
- Sustainable on-call practices

**Strong Answer Framework:**

```markdown
# Framework: Fixing Alert Fatigue

## Step 1: Measure the Problem (30 seconds)
"First, I'd quantify the issue:
- Alerts per on-call shift
- Acknowledgment time
- Percentage requiring action
- Time to resolve

Industry target: <10 alerts/shift, >80% actionable."

## Step 2: Categorize Alerts (45 seconds)
"I'd audit each alert:

Category A: True positive, action taken (keep)
Category B: True positive, no action possible (remove/ticket)
Category C: False positive (fix detection)
Category D: Duplicate/covered by another alert (consolidate)

Often 30-50% of alerts are in categories B-D."

## Step 3: Improve Alert Quality (60 seconds)
"For remaining alerts, I ensure:

1. **Symptom-based, not cause-based**
   Bad: 'Database CPU high'
   Good: 'User requests failing due to database timeout'

2. **Appropriate thresholds**
   Use historical data to set thresholds above noise
   Add `for` duration to filter transient spikes

3. **Clear runbooks**
   Every alert links to actionable runbook
   No runbook = delete the alert

4. **Severity alignment**
   P1: User-facing complete outage
   P2: User-facing degradation
   P3+: Create ticket, don't page"

## Step 4: Implement Burn Rate Alerting
"Replace threshold alerts with error budget burn rate:
- Only page when SLO is at risk
- Catches both fast and slow burns
- Naturally filters noise"

## Example Result
"At my last company, we went from 50 alerts/week to 8.
Process: Audited 200 alerts, deleted 60%, tuned 30%.
Result: On-call happiness improved, MTTR actually decreased."
```

---

### Question 4: Tell me about a time you conducted a blameless postmortem.

**What FAANG expects:** STAR format (Situation, Task, Action, Result). Focus on the systems-not-humans framing: ask "how was this possible?" not "who did it?". Concrete action items with owners and deadlines, tracked like any other engineering work. Bonus for naming Etsy's Debriefing Facilitation Guide (John Allspaw) as the canonical blameless-postmortem training resource, and for recognizing that a postmortem without landed action items is theater.

**What Interviewers Look For:**
- Understanding of blameless culture
- Facilitation skills
- Focus on systemic improvement
- Follow-through on action items

**Strong Answer Framework:**

```markdown
# Framework: Blameless Postmortem

## Setup (20 seconds)
"After a 2-hour outage caused by a config change, I
facilitated the postmortem with 8 engineers and 2 managers."

## Establishing Blameless Tone (30 seconds)
"I opened with:
'We're here to learn, not to blame. The person who made
the change was following our process. If someone could
make this mistake, our process allowed it. We fix the
process, not the person.'

I explicitly banned 'should have known' language."

## Structure (45 seconds)
"I used this structure:

1. **Timeline (15 min)**: Facts only, what happened when
   - Not WHY yet, just WHAT
   - Built collaboratively, filled gaps

2. **Contributing factors (20 min)**: Why did this happen?
   - I asked 'what made this possible?' not 'who caused this?'
   - We identified 5 factors, not 1 'root cause'

3. **Response analysis (10 min)**: How did we respond?
   - What helped? What hindered?
   - Detection time, communication, mitigation

4. **Action items (15 min)**: How do we prevent this?
   - Categorized: Prevent, Detect, Mitigate
   - Assigned owners and due dates
   - Prioritized P0 (must do) vs P1 (should do)"

## Key Technique (30 seconds)
"When someone said 'John should have tested the config',
I reframed: 'What in our process would have caught this?'
Answer: We didn't have config validation in CI.

The action item became 'Add config validation' - a system
fix, not a human fix."

## Follow-through (15 seconds)
"I tracked action items in our bug tracker, reviewed
completion in weekly team meeting, and closed the postmortem
only when all P0 items were done."
```

### Junior → FAANG: Interview Question Strategy for SRE Roles

SRE interviews test two types of knowledge: conceptual (SLI/SLO/SLA, error budgets, incident severity levels) and behavioral (how you respond to incidents, how you write post-mortems, how you balance reliability and velocity). Both types require preparation.

For conceptual questions, practice the definitions until they are automatic. For behavioral questions, prepare three to five specific incident stories from your experience. The STAR format (Situation, Task, Action, Result) structures the answer to cover the timeline, your specific contribution, and the measured outcome.

The post-mortem question is the most commonly asked behavioral question in SRE interviews. Prepare a story that demonstrates blameless culture, specific technical actions that mitigated the incident, and concrete improvements that resulted. The "follow-through" step (tracking action items to completion) is often the differentiator between a good answer and a great one.

### Senior @ FAANG: Bar-Raiser Signals in SRE Practice Interviews

An L6 SRE bar-raiser evaluates candidates on three dimensions beyond basic knowledge:

**Quantitative thinking.** Does the candidate naturally express reliability in numbers? "We reduced MTTR from 45 minutes to 12 minutes" is stronger than "we improved our incident response." Every claim about reliability should be backed by a metric.

**Organizational influence.** Can the candidate describe reliability improvements that scaled beyond their own service to affect multiple teams? L6 SRE work is inherently cross-team: defining standards, training other engineers, building platform tools. A candidate who has only improved their own service's reliability is at L5 scope.

**Error budget as a communication tool.** Can the candidate explain how they used error budget data to have a conversation with a product manager or engineering leader about trade-offs? This demonstrates that the candidate treats reliability as a shared organizational responsibility rather than an engineering-only concern, which is the defining characteristic of senior SRE work.

---
