# Chapter 90J: Failed Projects, Botched Migrations, and Infrastructure Disasters

*"The most expensive bugs are not the ones in your code. They are the ones in your assumptions."* - Unknown

Every generation of engineers inherits a mythology of disaster. These are not campfire stories - they are forensic
records of real organizations that lost hundreds of millions of dollars, destroyed reputations built over decades,
sent innocent people to prison, and discovered that their most fundamental assumptions about reliability, testing,
and project management were catastrophically wrong. The common thread through every incident in this chapter is not
incompetence. It is the systematic failure of organizations to respect complexity, validate assumptions, and build
the defensive infrastructure that would have contained the damage when things went wrong - as they inevitably do.

This chapter studies twenty-five of the most significant project failures, botched migrations, and infrastructure
disasters of the modern computing era, spanning from 1999 to 2025. Unlike the previous chapter's focus on
infrastructure incidents and outages, this chapter examines failures that unfolded over weeks, months, and in some
cases decades - the slow-motion disasters where warning signs were visible for years before the final collapse.
These are the failures that destroyed companies, ended careers, bankrupted small business owners, and in the case
of the Post Office Horizon scandal, resulted in the largest miscarriage of justice in British legal history.

For each incident, we reconstruct the complete timeline from the first warning signs through the catastrophic
failure and its aftermath. We identify the root causes at both the technical and organizational levels, because
every one of these disasters was caused by a combination of technical mistakes and management failures that
amplified each other. We then build production-grade Go code implementing the defensive patterns that would have
prevented or mitigated each disaster - from load testing frameworks and kill switches to migration validation
systems and circuit breakers. The goal is to give you both the historical understanding and the practical tools
to avoid repeating these mistakes in your own systems.

**Prerequisites:** Thorough grounding in Go concurrency primitives and synchronization patterns (Chapters 17--22), production resiliency and circuit breaking (Chapter 27C), distributed system design fundamentals (Chapter 58), and real-world failure analyses (Chapters 84--90I).

**What you will learn in this chapter:**

- How Healthcare.gov's launch became the most expensive website failure in history, with 55 contractors, only 23%
  of the system tested, and a final bill of $1.7 billion - and how to build load testing infrastructure in Go
  that would have caught the problems months before launch
- Why Knight Capital lost $440 million in 45 minutes because dead code from 2003 was accidentally reactivated
  during a deployment, and how to build automated kill switches in Go that detect and halt anomalous trading
- How TSB Bank's migration of 5.4 million accounts locked out 1.9 million customers for weeks, costing £330
  million, and how to build migration validation systems in Go that verify data integrity at every step
- Why Atlassian's 14-day deletion disaster was caused by confusing site IDs with app IDs, and how Go's type
  system can prevent entire categories of identifier confusion bugs
- How GitLab discovered that all five of their backup strategies had failed simultaneously when an engineer
  ran rm -rf on a production database, and how to build backup verification systems in Go
- Why a mistyped command during routine maintenance took down most of the internet for four hours and cost
  an estimated $150 million, and how to build blast radius limiting into infrastructure automation
- How Roblox was offline for 73 hours because of an interaction between Consul and BoltDB that nobody had
  anticipated, and how to build independent monitoring systems in Go
- Why Southwest Airlines canceled 16,700 flights during the 2022 holiday season because their 1990s-era
  SkySolver system could not handle the cascading disruptions, and what this teaches about technical debt
- How the Post Office Horizon scandal saw Fujitsu's buggy software send 900 innocent people to prison over
  25 years, and what this means for software liability and engineering ethics
- Why Hershey lost $100 million in Halloween orders by going live with SAP during their peak season
- How the FBI spent $170 million over five years on a case management system that was never deployed, cycling
  through five CIOs and producing nothing usable
- Why the 2010 Flash Crash erased $1 trillion in market value in minutes because trading algorithms had no
  price limits, and how to build circuit breakers in Go
- How BGP configuration errors at Rogers, Optus, and Meta took down entire countries and platforms, and how
  to build configuration validation systems
- Why Zillow lost $881 million on its iBuying program because their ML models consistently overpaid for
  houses, and how to build ML monitoring systems in Go
- A complete Failed Migrations Playbook and Infrastructure Disaster Prevention Matrix
- How Amazon's Prime Day 2018 auto-scaling failed under sudden traffic surges, and how to engineer pre-warmed elasticity in Go
- Why Twitter's Fail Whale forced the migration from a monolithic Ruby on Rails backend to scalable Go services
- How Spotify's April 2025 Envoy config update propagated invalid routing, and how to enforce progressive config rollouts
- Why Discord's ScyllaDB cluster faced cascading auth failures under pressure in 2023, and how to implement adaptive client-side backpressure
- How OpenAI's Kubernetes control plane collapsed in December 2024, and how to protect etcd against thundering herds
- The seven performance anti-patterns that kill production systems (goroutine leaks, unbuffered channel deadlocks, lock contention)
- The Gray Failure pattern: detecting subtle, partial performance degradations before total service collapse
- Telecom nation-scale outages (Rogers and Optus) and multi-region fault isolation
- Redis production disasters: accidental `FLUSHALL`, Sentinel split-brain, and eviction misconfigurations

---

### Junior → FAANG: Failed Projects as Interview Evidence for Systems Thinking

Failed projects and migrations are valuable interview material because they demonstrate systems thinking, not just coding ability. FAANG behavioral interviews ask "tell me about a project that failed and what you learned" specifically to test whether you can analyze failure at the system level (architecture, process, organizational dynamics) rather than the individual level (someone made a mistake). The incidents in this chapter give you a vocabulary for that analysis: scope creep (Healthcare.gov), feature flags without dead code removal (Knight Capital), big-bang migration without parallel operation (TSB Bank), backup untested at scale (GitLab). When answering behavioral questions about failure, use the incident pattern as a frame: "We had a Knight Capital-style problem where we were deploying code that activated a feature that was supposed to be disabled, and we didn't catch it until it had already affected production traffic." Anchoring to a known incident demonstrates that you understand the failure class, not just the specific instance.

### Senior @ FAANG: Project Failure Patterns as a Risk Assessment Framework

At L6, the incidents in this chapter are inputs to a proactive risk assessment, not just retrospective lessons. Before starting any large migration or project, you apply the failure pattern taxonomy: does this project have the scope ambiguity of Healthcare.gov? The single-point-of-failure risk of TSB Bank's big-bang cutover? The feature flag management problem of Knight Capital? The untested backup assumption of GitLab? For each pattern that applies, you define the specific mitigating controls before the project begins, not after the failure. This proactive risk assessment is the staff engineer's contribution to project governance: not just reviewing the technical design, but explicitly identifying which failure patterns the project is susceptible to and verifying that the mitigation controls are in place before the first line of code is committed.
