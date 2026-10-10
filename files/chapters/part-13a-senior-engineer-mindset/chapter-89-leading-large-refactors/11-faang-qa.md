## FAANG Interview Q&A: Leading Large Refactors

These questions surface whether you can run a multi-quarter refactor without losing team trust, user-visible quality, or organizational patience.

### 1. Describe the largest refactor you have led. What went right and what went wrong?

Strong answers identify the scope (lines of code, services affected, engineer-quarters invested), the incremental milestones, the rollback mechanism that was in place at every milestone, and the moment the plan deviated from reality. Google and Uber interviewers look for honest admission that you underestimated something specific: scope creep, test coverage gaps, or organizational readiness.

### 2. Tell me about a time you decided not to refactor something that was technically bad.

This probes judgment. Identify the cost of the refactor, the forecast benefit, and the alternative investments that won the comparison. The best answers name the opportunity cost explicitly and describe the mitigation you put in place (guardrails, linter rules, runbook updates) to contain the technical debt without paying down the principal.

### 3. How did you coordinate a refactor across teams that did not report to you?

Focus on the artifacts you produced: the RFC with a migration guide, the codemod that made the mechanical change trivial, the dashboard tracking adoption, and the deprecation timeline with committed dates. Describe how you handled the team that pushed back past the deprecation date.

### 4. How would you migrate a Go monolith to microservices using the strangler fig pattern?

Cover the five phases: identify a bounded context, extract the first service with a read-only shadow mode, route a percentage of traffic to the new service while dual-writing, cut over fully with rollback preserved, and decommission the old code path. Discuss the data-layer decisions (shared database versus extracted data store) and why the shared-database phase should be time-boxed rather than treated as permanent.

### Junior → FAANG: Preparing Your Migration Story

Before a FAANG interview, construct one migration story that answers questions 1 through 3 simultaneously. The story should have a named system, a quantified problem, an incremental pattern (strangler fig or feature flags), a moment of unexpected complexity, and a measured outcome. Practice delivering it in two minutes, then extend to five when asked for detail. The two-minute version is your opening. The five-minute version is what you deliver when the interviewer says "tell me more."

Question 2 is the one most candidates underestimate. Choosing not to refactor is a stronger signal of engineering maturity than always choosing to refactor. Prepare this answer with as much care as the "I led a refactor" story.

### Senior @ FAANG: What L6 and L7 Answers Add

For questions 4 and 5, bar-raiser interviewers are not just scoring your pattern knowledge. They are scoring your governance instincts. For question 4, add: how did you handle the team that was still on the old service path two weeks after the cutover deadline? What enforcement mechanism existed? For question 5, add: what was the rollback criteria and who had the authority to invoke it unilaterally at 3 AM without escalating? These additions show that you design for the full lifecycle, including the organizational failure modes, not just the happy path.

### 5. Design a rollback plan for a database migration from MongoDB to PostgreSQL running in production.

A staff-level answer covers dual-write during backfill, a feature flag that routes reads to either source, a reconciliation job that samples records and alerts on drift, and a rollback path that does not require a data migration because writes have been landing in both stores. Discuss how you handle the long tail of documents that fail the normalization step and the threshold at which you would block the cutover.
