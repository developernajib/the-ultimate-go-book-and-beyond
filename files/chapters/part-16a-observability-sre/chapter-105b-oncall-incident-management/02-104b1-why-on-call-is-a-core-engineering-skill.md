## 105B.1 Why On-Call Is a Core Engineering Skill

### The FAANG Ownership Model

At Amazon, Google, Meta, and Netflix, the team that builds a service is the team that runs it. There is no separate "ops" team that absorbs pager noise while developers sleep. This is not punishment, it is a deliberate feedback loop.

When engineers carry pagers for the code they ship, every noisy alert becomes personal. Every 3 AM page for a bug that was known but deprioritized becomes a strong motivator to fix it. Every runbook step that says "ssh into the box and restart the process" becomes a ticket to automate it.

This philosophy is captured in SRE practice as **"you build it, you run it"** (coined by Werner Vogels at Amazon). It produces measurably better software because the cost of cutting corners is immediately felt by the people who cut them.

### On-Call as a Quality Signal

On-call load is one of the best proxies for software quality at the system level:

| Signal | What It Reveals |
|---|---|
| Alerts per week | Threshold tuning quality, system stability |
| Mean Time to Acknowledge (MTTA) | Alert clarity, engineer confidence |
| Mean Time to Resolve (MTTR) | Runbook quality, tooling, service debuggability |
| % pages requiring manual rollback | Release safety quality |
| Recurring incidents on same component | Technical debt |

A high-quality service has low alert volume, fast MTTA, fast MTTR, and zero recurring incidents on the same root cause.

### The Real Cost of Poor On-Call

Poor on-call practices have well-documented consequences:

**Engineer burnout.** Sleep deprivation from repeated nighttime pages degrades cognitive performance measurably. A widely cited 1997 study in Nature by Dawson and Reid found that 17 hours awake produces impairment equivalent to a blood alcohol concentration of 0.05. On-call engineers debugging critical production issues at 2 AM are not operating at full capacity.

**Alert fatigue.** When an alert fires too frequently without action, engineers train themselves to ignore it. This is the most dangerous outcome: an alert that cried wolf 200 times before the real incident is dismissed. Teams with alert fatigue have missed genuine SEV1 incidents for over an hour because the alert was normalized.

**War room theater.** Organizations without incident process degenerate into "all hands war rooms" where 15 engineers join a call, only 2 are debugging, and the other 13 are waiting to relay status updates. The coordination overhead of a war room without structure can double MTTR.

**Toil accumulation.** Without intentional toil reduction, manual remediation steps accumulate. Teams can end up spending the majority of their engineering time on operational work with no leverage, restarting services, rotating credentials, and clearing queues by hand, instead of building the automation that eliminates those tasks permanently.

### What a Staff Engineer Looks Like in On-Call

A senior engineer responds to pages and fixes incidents. A staff engineer asks:

- Why did this alert fire? Was the threshold correct?
- Why did the runbook not cover this case? How do we update it?
- Could this have been caught by a canary before it reached production?
- What is the systemic fix, not just the immediate mitigation?
- How do we make sure the same incident never pages anyone again?

Staff engineers treat each incident as a data point about their system's design and their team's process maturity.

### Junior → FAANG: Building On-Call Competence Before You Are On-Call

The first time you are on-call should not also be the first time you have read the runbooks, understood the alert routing, or used the incident management tool. Spend time before your first rotation: read every runbook for the services you are responsible for, test the alert routing by triggering a test alert, and shadow an experienced engineer through at least one incident.

The questions in the bullet points above ("could this have been caught by a canary?", "what is the systemic fix?") are not something you ask for the first time during an incident. They should be your automatic response pattern, built through repeated exposure to post-mortems and incident reviews before you are the primary on-call.

### Senior @ FAANG: On-Call Ownership as a Team Design Principle

At L6, the question is not whether engineers should be on-call for their services (they should) but how to design the team structure and support systems so that on-call is sustainable. The key design choices are: rotation size (minimum 5 engineers to avoid burnout from excessive frequency), escalation paths (who is the secondary on-call and when are they engaged), and toil budget (what percentage of each sprint is allocated to reliability improvements driven by on-call learning).

Staff engineers who have designed these structures have moved from managing individual on-call incidents to managing the on-call system. The system design is what scales: individual incident response skill is linear with headcount, but a well-designed on-call system provides leverage across the entire team.

---
