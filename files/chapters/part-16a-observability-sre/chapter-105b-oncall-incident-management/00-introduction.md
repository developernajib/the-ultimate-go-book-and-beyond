# Chapter 105B: On-Call & Incident Management for Go Engineers

*"The goal of on-call is not to fix things faster. It is to build systems that need fixing less often."* (Adapted from the Google SRE Book)

On April 21, 2011, Amazon Web Services suffered a networking misconfiguration in its US-East-1 region that triggered a cascade of EBS failures, taking down Reddit, Foursquare, Quora, and hundreds of other services for over twelve hours. The incident cost Amazon millions and exposed a critical dependency that thousands of companies had never audited. On August 1, 2012, Knight Capital Group lost $440 million in 45 minutes when a partial software deployment reactivated dead code and an automated trading system began flooding the market with erroneous orders. No runbook existed for that failure mode, and by the time the correct remediation was identified, the damage was done. On January 31, 2017, GitLab lost six hours of production data when an engineer, exhausted after a long night of incident response, accidentally deleted the wrong database directory on the wrong server. The scheduled backups turned out to be broken, recovery came from a six-hour-old snapshot, and data for roughly 5,000 projects was permanently lost. These incidents share a common thread: not technical impossibility, but human systems that failed under pressure.

On-call engineering is where the quality of everything else becomes visible. An unclear alert surfaces a poorly chosen SLI. A slow acknowledgment surfaces an ambiguous runbook. A twelve-hour MTTR surfaces a system that was never designed for debuggability. A recurring incident surfaces technical debt that was deprioritized through three planning cycles. The Google SRE model, now adopted in various forms by Uber, Netflix, Stripe, Cloudflare, and virtually every high-scale engineering organization, treats on-call not as a tax on engineers but as the feedback loop that drives reliability improvement. When the people who build a system also run it, every page is a direct incentive to eliminate its cause.

This chapter teaches on-call engineering as a first-class discipline for Go engineers. You will design SLO-based alerting that pages on user impact rather than system internals, write runbooks that are actually useful at 3am, build Go services instrumented for maximum debuggability during outages, conduct blameless postmortems that produce action items that actually ship, and systematically measure and eliminate the toil that makes on-call rotations unsustainable. The techniques here are drawn directly from the practices documented in the Google SRE Book, the SRE Workbook, and the operational playbooks of the organizations that have operationalized them at scale.

**What you'll learn in this chapter:**
- The FAANG on-call ownership model: "you build it, you run it," alert ownership, and how on-call load functions as a software quality signal
- SLO-based alerting design: error budget burn rate alerts, multi-window multi-burn-rate thresholds, and avoiding the symptom vs. cause alerting anti-pattern
- Implementing SLO alerting in Go with Prometheus: recording rules, alerting rules, and the Alertmanager routing that gets the right page to the right person
- Production runbook structure: decision trees, diagnostic commands, escalation paths, and the difference between runbooks that help and runbooks that are ignored
- Incident command structure: incident commander, communications lead, and scribe roles, and how to run a focused incident call without war room theater
- Blameless postmortem methodology: timeline reconstruction, contributing factor analysis, and writing action items with owners and due dates that ship
- Instrumenting Go services for debuggability: structured logs with correlation IDs, distributed traces that span service boundaries, and dashboards designed for incident diagnosis
- Toil identification and elimination: measuring operational work, distinguishing toil from engineering work, and building automation that removes manual remediation permanently

**Why this matters at scale:**
Google's SRE organization manages thousands of services across millions of servers with on-call rotations where engineers average fewer than two pages per 12-hour shift, achieved not by having fewer incidents but by relentlessly eliminating alert noise, building automation, and enforcing postmortem action items. Netflix's Chaos Engineering practice, which deliberately injects failures into production to surface reliability gaps before they become incidents, emerged directly from their on-call learning that unknown failure modes are more dangerous than known ones.

**Prerequisites:** Chapter 104 (Prometheus and metrics), Chapter 103 (OpenTelemetry and distributed tracing), Chapter 20 (structured logging), Chapter 105 (SLOs and error budgets)

### Junior → FAANG: Why On-Call Experience Matters in Interviews

Interviewers at FAANG companies ask about on-call experience not to assess how many incidents you have handled, but to understand how you think under pressure and whether you possess mature operational judgment. A junior engineer who has been on-call for six months at a small company and has learned from each incident will often interview better than one who has only studied SRE concepts theoretically.

If you have on-call experience, prepare three stories: one where you responded well and resolved an incident quickly, one where you made a mistake and what you learned, and one where the incident revealed a system design flaw that you subsequently fixed. These three stories cover the full range of on-call maturity signals an interviewer looks for.

If you do not have on-call experience yet, read published post-mortems from Google, Cloudflare, and GitLab. Practice diagnosing the incidents mentally before reading the resolution. This builds pattern recognition that transfers to interview scenarios.

### Senior @ FAANG: On-Call as a Metric for Engineering Culture

At L6, the on-call health of a team is a leading indicator of engineering culture and technical debt. A team that routinely has high alert volume, frequent escalations, and post-mortems without completed action items is a team with accumulated technical debt and insufficient automation investment. An L6 engineer uses on-call metrics (pages per rotation, MTTR, false positive rate, action item completion rate) to diagnose team health and make the case for reliability investment to leadership.

Google's two-pages-per-shift target is not arbitrary: it represents the maximum alert volume that keeps engineers engaged and responsive without causing fatigue. Above that threshold, engineers start filtering alerts rather than investigating them. An L6 engineer who has driven a team's on-call volume below this threshold through alert tuning, automation, and reliability improvements has a concrete, quantified achievement that is a strong signal in staff-level promotion cases.

---
