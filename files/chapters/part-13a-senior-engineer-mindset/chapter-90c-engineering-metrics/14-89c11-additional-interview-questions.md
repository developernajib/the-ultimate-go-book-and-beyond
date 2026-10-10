## 90C.11 Additional Interview Questions

### "What are DORA metrics and what does each measure?"

**Strong answer**:

"DORA stands for DevOps Research and Assessment. The research, published by Nicole Forsgren and colleagues in the book *Accelerate*, identified four metrics that distinguish high-performing engineering organizations from low-performing ones.

Deployment Frequency measures how often you successfully release to production. Elite performers deploy on demand - multiple times per day. It measures delivery cadence and is correlated with organizational agility.

Lead Time for Changes measures the time from a code commit being made to that code running in production. Elite performers achieve this in less than one hour. It measures the efficiency of your entire delivery pipeline - from code to customer.

Change Failure Rate measures what percentage of deployments cause a degraded service or require remediation. Elite performers maintain below 5%. It measures deployment safety and is the counterbalance to Deployment Frequency - you cannot game frequency without this metric also suffering.

Mean Time to Recovery measures how quickly the team restores service after a production failure. Elite performers recover in less than one hour. It measures operational resilience.

Together, the four metrics balance speed (Deployment Frequency, Lead Time) against stability (Change Failure Rate, MTTR). Improving one dimension at the expense of another is immediately visible."

---

### "How do you measure developer productivity without micromanaging?"

**Strong answer**:

"The key is measuring team-level outcomes, never individual-level activity.

I measure four things at the team level: cycle time (how long does work take from start to delivery), deployment frequency (are we shipping regularly), defect escape rate (what percentage of bugs reach customers), and developer satisfaction via quarterly anonymous surveys.

I explicitly do not measure individual commit counts, lines of code, number of PRs, or story points per person. These are activity metrics that, when applied to individuals, create perverse incentives - engineers optimize the metric instead of the outcome.

For individuals, I rely on peer feedback and manager observation of qualitative signals: do their code reviews improve the codebase? Do their architectural decisions hold up over time? Do other engineers want to work with them? These are the signals that indicate actual productivity, and they cannot be gamed."

---

### "What is the difference between a leading and lagging metric?"

**Strong answer**:

"A lagging metric measures an outcome that has already occurred - it tells you what happened. A leading metric predicts a future outcome - it tells you what is about to happen.

Defect escape rate is a lagging metric: it tells you that bugs already reached customers. Flaky test rate is a leading metric: a rising flaky test rate predicts that engineers will stop trusting CI, which predicts that they will start skipping tests or deploying unverified changes, which predicts a future increase in defect escape rate.

Senior engineers focus on leading indicators because they enable intervention before problems materialize. If I see PR review turnaround time rising from four hours to twelve hours, I know cycle time is about to worsen. I can act now - before lead time degrades, before engineers get frustrated, before we miss a sprint commitment.

In practice, most teams measure only lagging indicators because they are easier to define. Building a discipline around leading indicators is a meaningful differentiator for an engineering organization."

---

### "How would you set up engineering metrics from scratch at a new company?"

**Strong answer**:

"I would follow a four-phase approach over approximately three months.

Phase one, weeks one through two: listen and baseline. Before proposing any metrics, I would interview engineers, PMs, and leadership to understand what pain they feel. Is it slow delivery? Too many incidents? Poor code quality? The pain defines which metrics matter. I would also establish baselines - you cannot measure improvement without knowing where you started.

Phase two, weeks three through four: instrument the highest-pain metric. Pick one metric that addresses the biggest pain and instrument it properly. If the biggest pain is slow delivery, I instrument cycle time end-to-end. I make the data visible in a dashboard that everyone can see.

Phase three, weeks five through eight: expand and connect metrics. Add the complementary metrics - deployment frequency needs change failure rate, cycle time needs quality metrics. Build the metric families so gaming one metric is visible through another.

Phase four, weeks nine through twelve: establish review cadence. Weekly operational reviews (are any metrics in alert state?), monthly tactical reviews (are trends improving?), quarterly strategic reviews (are we in a different DORA band?). Without a review cadence, metrics become shelfware."

---

### "How does Google measure engineering productivity?"

**Strong answer**:

"Google's Engineering Productivity Research team has published extensively on this. Their framework, described in the paper 'Measuring Engineering Productivity' (Sadowski et al., 2019), centers on the QUANTS model: Quality of code, Attention from engineers, Intellectual complexity, Tempo and velocity, and Satisfaction.

Google measures productivity at the team and project level, not at the individual level. They use a combination of automated metrics (build speed, test coverage, code review latency) and developer surveys conducted regularly.

One important insight from Google's research: they found that the most important factor in engineering productivity is not tooling speed or test coverage - it is clarity of goals. Engineers who understood what they were supposed to be working on and why were significantly more productive than those who had fast tools but unclear direction.

Google also explicitly avoids using quantitative metrics in individual performance evaluations. Performance reviews are based on peer and manager written feedback. The metrics inform team-level decisions, not individual career outcomes."

---

### "What is Goodhart's Law and how do you apply it to engineering metrics?"

**Strong answer**:

"Goodhart's Law states: when a measure becomes a target, it ceases to be a good measure. It was originally an observation in economics, but it applies directly to any situation where rational agents are evaluated against numeric targets.

In engineering metrics, Goodhart's Law manifests in every metric that is tied to individual performance. If I tell an engineer their promotion depends on achieving 80% test coverage, I will get 80% test coverage - but I will not get 80% of the defects caught. I will get coverage theater: tests that execute code without asserting meaningful behavior.

My application of Goodhart's Law is threefold. First, I use metric families rather than individual metrics, so gaming one metric is visible through its counterpart. Second, I publish the calculation methodology - transparency reduces gaming because engineers understand what the metric actually measures. Third, I validate quantitative metrics with qualitative signals quarterly. If coverage is high but engineers report low confidence in the test suite, the coverage number is deceiving.

The goal is to use metrics as diagnostic tools for the team, not as scorecards for individuals."

---

### "How do you balance quality metrics versus velocity metrics?"

**Strong answer**:

"I treat quality and velocity as complementary, not competing. This is one of the core findings of the DORA research: elite performers are both faster and more reliable than low performers. The intuition that 'you can have speed or quality but not both' is empirically false at the team level.

In practice, I balance them using the error budget concept from SRE. If a team's change failure rate is below their budget threshold, they have earned the right to deploy at high frequency. If they exceed their budget, they slow down and invest in quality improvements - better testing, canary deployments, feature flags.

This creates a natural self-correcting system. Teams that prioritize velocity at the expense of quality see their change failure rate rise, which triggers a quality investment sprint. Teams that over-invest in quality at the expense of velocity see deployment frequency fall, which triggers a process improvement sprint to reduce friction.

The key is that both types of metrics are always visible to the team simultaneously. You cannot optimize deployment frequency without watching change failure rate. You cannot optimize coverage without watching cycle time. The metrics constrain each other."

---

### "What metrics would you track for an SRE team versus a product engineering team?"

**Strong answer**:

"The distinction reflects the different value each team delivers.

For an SRE team, I focus on reliability and operational excellence metrics: SLO compliance rate by service (are we meeting our availability and latency commitments?), MTTR (how quickly do we recover?), toil percentage (what fraction of work is manual, repetitive operational work that should be automated?), on-call interruption rate (how often are engineers paged during non-business hours?), and post-mortem completion rate (are we learning from incidents?). The SRE team's output is reliability. Their metrics measure reliability outcomes.

For a product engineering team, I focus on delivery and quality metrics: deployment frequency, lead time for changes, change failure rate, and cycle time from ticket creation to deployment. I also track defect escape rate (bugs reaching customers) and developer satisfaction (to catch productivity problems early). The product team's output is features delivered safely. Their metrics measure delivery velocity and safety.

The overlap: both teams care about change failure rate and MTTR, because both teams contribute to and are affected by production incidents. But the primary focus differs. SRE optimizes for operational stability, and product engineering optimizes for delivery throughput. Metrics must reflect those different mandates."

---
