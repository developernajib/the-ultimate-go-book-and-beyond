# Chapter 105: SRE for Go Services

> *"Hope is not a strategy."* (Google SRE Book)

Site Reliability Engineering was born at Google in 2003 when Ben Treynor Sloss was handed a production system and told to run it like a software problem. The core insight: treating operations as a software engineering discipline, with code, automation, and rigorous measurement, produces more reliable systems than armies of manual operators running runbooks. That insight, formalized in Google's 2016 SRE book and widely adopted since, gave the industry a common vocabulary and framework for thinking about reliability: Service Level Indicators (SLIs) quantify user experience, Service Level Objectives (SLOs) set the target, and error budgets translate the abstract concept of "reliability" into a concrete engineering resource that can be spent or conserved.

For Go engineers specifically, SRE practices shape how services are designed from the ground up. Error budgets influence feature velocity decisions: if you've burned your 30-day budget in the first week, deploying risky changes is off the table. Runbooks become executable Go programs rather than wiki pages. Alerting is grounded in user-facing SLIs rather than noisy infrastructure metrics like CPU percentage. Toil, the repetitive, automatable operational work that scales with traffic, is tracked and systematically eliminated through Go tooling: automated canary analysis, self-healing controllers, and chaos experiments that verify resilience claims before incidents reveal them.

Incident management and postmortems are the feedback loop that prevents the same failure from recurring. Blameless postmortems, a cornerstone of SRE culture, focus on systemic causes rather than individual mistakes, producing action items that harden the system rather than punishing the engineer who made a reasonable decision with incomplete information. This chapter translates SRE theory into practical Go implementation: instrumented SLI collection, error budget burn-rate alerts, runbook automation, and a postmortem-driven culture that improves reliability over time rather than merely reacting to it.

**What you'll learn in this chapter:**
- Defining SLIs, SLOs, and SLAs: request success rate, latency percentiles, availability windows, and error rate targets
- Implementing error budget calculations in Go and surfacing them as Prometheus metrics and Grafana panels
- Multi-window, multi-burn-rate alerting (the Google SRE approach) for catching slow and fast budget burns
- Writing production-grade runbooks as structured documents linked directly from alert annotations
- Incident management lifecycle: detection, triage, mitigation, resolution, and communication protocols
- Conducting blameless postmortems: timeline reconstruction, contributing factors, and action item tracking
- Toil identification and automation: measuring toil percentage per on-call rotation and eliminating it with Go tooling
- Capacity planning: traffic forecasting, load testing, and setting infrastructure headroom targets

**Why this matters at scale:**
Google's SRE organization enforces strict error budget policies across hundreds of products, and teams that exhaust their error budget freeze feature deployments until reliability is restored. Companies operating hundreds of microservices, Spotify among them, have adopted SRE practices to cut incident response times through standardized runbooks and automated rollback. Amazon's culture of operational excellence, built on similar principles, underpins the reliability commitments of AWS services consumed by millions of businesses. For any Go team operating services with meaningful uptime expectations, SRE practices are the difference between reactive firefighting and proactive reliability engineering.

**Prerequisites:** Chapters 102-103 (OpenTelemetry and Prometheus/Grafana), familiarity with Kubernetes deployments, and access to a staging environment where alerting and error budget dashboards can be validated.

### Junior → FAANG: SRE as a Mindset, Not Just a Title

Many engineers think SRE is a job title that only applies at Google-scale companies. In reality, the SRE mindset (treat reliability as a quantifiable engineering problem, use data to prioritize reliability work, balance reliability and velocity through error budgets) applies at any company with more than one production service.

For a first job, the most important SRE habits are: define what "up" means for your service before it goes to production, write a runbook for every alert, and participate in post-mortems with a focus on system improvements rather than blame. These habits are observable in interviews: "tell me about a production incident you responded to" is a common question, and the best answers describe a structured response, a blameless post-mortem, and a concrete system improvement that resulted.

### Senior @ FAANG: SRE as Organizational Design

At senior and staff level, SRE is not just a set of practices but an organizational design question. Google's model separates SRE from product engineering as a distinct function. Many FAANG-adjacent companies embed SRE practices in product engineering teams without a separate function. Neither is universally correct: the right model depends on organization size, service count, on-call load, and reliability investment appetite.

An L6 engineer can articulate the trade-offs: a separate SRE function provides deep reliability expertise and consistent standards but creates a dependency and communication overhead. An embedded SRE model (product engineers own their on-call) creates faster feedback loops but requires more reliability education investment for every team. Staff-level engineers who have designed or influenced this organizational structure have a concrete story to tell in L7 interviews.

---
