## 90B.11 Interview Questions: Extended Set

At senior and staff engineer interviews, you will be expected to demonstrate not just that you can write an ADR, but that you understand the organizational dynamics around architectural decision-making. Interviewers want to see that you can handle disagreement constructively, know when to write an ADR versus when it is overhead, and understand how different companies approach documented decisions at scale. The questions below are modeled on real staff and principal engineer interview questions at FAANG companies, with strong answers that demonstrate the depth of understanding interviewers look for.

The following questions extend those covered in earlier sections, targeting staff engineer and principal engineer interviews at FAANG and FAANG-adjacent companies.

### Q: What makes a good ADR versus a bad one? Give a concrete example of each.

**Strong answer**:

A good ADR has four characteristics. First, it was written before the decision was finalized - this is the most important property, because writing the alternatives section frequently reveals options that were not initially considered. Second, it honestly evaluates alternatives, including their strengths. An ADR that dismisses every alternative with a sentence is unconvincing and unhelpful to future engineers. Third, it is specific about constraints: "we needed sub-10ms P99 latency at 50k RPS with a team of three with no DBA experience" is useful context. "we needed a fast, scalable database" is not. Fourth, the consequences section is honest - it acknowledges the negatives of the chosen option.

A bad ADR is written retroactively, lists two token alternatives with one-sentence dismissals, omits any mention of constraints, and has a consequences section that lists only positives. It is indistinguishable from a press release.

Concrete example of a bad ADR context section: "We evaluated several database options and chose PostgreSQL because it is reliable and well-supported." This tells a future engineer nothing.

Concrete example of a good context section: "At the time of this decision, the user service processed 8,000 writes per second, was operated by a team with no dedicated DBA, required ACID transactions for financial records, and had a hard requirement to be operational in three weeks. The MongoDB Atlas contract from the previous architecture expired on 2024-06-01."

### Q: How do you handle disagreement during the ADR process?

**Strong answer**:

The ADR process is designed to surface disagreement early, when it is cheapest to resolve. When reviewers disagree on the decision, the first step is to identify whether the disagreement is about facts, values, or predictions.

Disagreements about facts - "option B has 2x the write latency of option A" - should be resolved with data. Write a benchmark. The ADR author should include the benchmark results in the Links section.

Disagreements about values - "operational simplicity is more important than raw throughput" - are harder. They should be explicit in the ADR. The Decision Drivers section exists to surface the value judgments behind the decision. When engineers disagree on weights in the scoring matrix, the disagreement should be documented: "Operations team weighted operational complexity at 40%. Platform team weighted throughput at 40%. The final weighting of 30%/30% represents the negotiated position."

Disagreements about predictions - "I don't think we'll reach 100k RPS in 18 months" - should be resolved by making the prediction explicit and adding a review trigger: "If traffic exceeds 80k RPS, this ADR should be reviewed for supersession."

At FAANG companies, the escalation path for unresolved disagreements is typically: author escalates to tech lead, tech lead escalates to staff engineer, staff engineer may call an Architecture Review meeting. The goal is to avoid decision-by-committee while ensuring that the most important disagreements are heard.

### Q: When should an ADR be superseded versus amended?

**Strong answer**:

An ADR should be superseded when the decision itself changes - when the team has made a new decision that contradicts or replaces the old one. Once an ADR moves to Accepted, it is a historical record. Amending it would destroy the record of what was known and decided at a specific point in time.

An ADR should be amended only in narrow cases: correcting a factual error that would be actively misleading (a wrong benchmark number, a broken link), or adding a postscript with updated context that does not change the decision. The amendment should be clearly labeled with the date it was added.

The rule of thumb: if you are changing the decision, write a new ADR. If you are correcting the record, amend with a dated postscript.

### Q: How do FAANG companies manage architectural decisions at scale?

**Strong answer**:

The mechanisms vary by company culture, but there are common patterns.

Google uses design documents heavily. The standard is a "design doc" - a prose document with specific sections (background, goals, non-goals, design, alternatives considered, open questions). For platform-level decisions, these go through an Architecture Review Process with a committee of senior engineers. The equivalent of ADRs is the decision section of the design doc, which is preserved after the doc is implemented.

Amazon uses the six-pager: a six-page narrative prose document that must be written without bullet points or slides. The six-pager forces clear thinking because you cannot hide weak reasoning behind bullet points. For major architectural decisions, the six-pager is reviewed in a "silent reading" session where attendees read for the first 20 minutes before discussion. Principal Engineers at Amazon have veto authority on decisions that affect their domain.

Meta uses RFCs (Request for Comments) for infrastructure decisions, roughly equivalent to ADRs with more emphasis on community comment periods.

Stripe has an internal "Service Spec" format that combines the design document and ADR into a single artifact, reviewed by the on-call engineer rotation.

The common thread: at scale, all FAANG companies have a documented decision artifact, a structured review process, and a designated class of senior engineers with authority to approve or block significant decisions.

### Q: What is the relationship between ADRs and RFCs?

**Strong answer**:

ADRs and RFCs serve related but distinct purposes. An RFC (Request for Comments) is a proposal mechanism - it describes a proposed change, solicits feedback, and documents the discussion. It is optimized for the deliberation phase: the comment thread is the primary artifact.

An ADR is a decision record - it documents the outcome of a deliberation, including the context, alternatives, and reasoning. It is optimized for future readability: a future engineer with no context reads it to understand why the system looks the way it does.

The relationship is: an RFC can produce an ADR. The deliberation happens in the RFC. The outcome is recorded in the ADR. The RFC comment thread is linked from the ADR's Links section as supporting context, but the ADR is the canonical record of the decision. Future engineers read the ADR, not the RFC thread.

Some teams use only one artifact. Amazon's six-pager serves as both RFC and ADR. Google's design docs serve both purposes. For smaller teams, a single document with a "deliberation" phase and a "decision" phase is simpler to maintain.

### Q: How do you use ADRs to onboard new team members?

**Strong answer**:

ADRs are onboarding infrastructure. A new engineer who reads the ADR history of a service can reconstruct the system's intellectual history: what constraints existed at each point in time, what alternatives were rejected and why, and which decisions are approaching the end of their useful life.

The onboarding exercise I have used: assign the new engineer to read all ADRs in the service they are joining and write a "decision archaeology" document. The document answers three questions: What are the three most significant decisions in this system's history? Is there one decision you would reconsider today, and why? Is there a constraint visible in the ADRs that you believe no longer applies?

The exercise accomplishes two things. The new engineer builds a mental model of the system's evolution in one to two days instead of weeks of pairing. The team gets a fresh pair of eyes on potentially stale decisions. The document the new engineer produces often identifies candidates for supersession that the team is too close to see.

ADRs are also the answer to "why does the code look like this?" questions. The first time a new engineer asks "why do we use eventbridge instead of SQS here?" the answer should be "read ADR-0042."

### Q: What is a lightweight ADR process for a five-person startup?

**Strong answer**:

The full ADR process with decision matrices, review boards, and CI linting is appropriate for a 50+ engineer organization. For a five-person startup, the overhead would slow the team without proportional benefit.

The minimum viable process:
- Nygard four-section format only (Status, Context, Decision, Consequences)
- Write ADRs only for decisions that are hard to reverse or would confuse a new hire - target one or two per month
- Store in `docs/adr/` from day one
- Review is a PR with the CTO as required reviewer. auto-merge after 48 hours with no blocking objection
- No CI lint beyond a simple filename format check

The critical investment is `docs/adr/` from day one. The directory costs nothing to create. Retrofitting ADRs into a messy documentation structure at Series B - when the founding team is no longer available to explain the history - is expensive. The startup that writes twelve ADRs in its first year will find them invaluable when it hires its first senior engineer.

### Q: How do you ensure ADRs stay current and don't become stale?

**Strong answer**:

Stale ADRs are worse than no ADRs because they actively mislead engineers. Two mechanisms prevent staleness.

The first is process: add ADR maintenance to your architectural change checklist. Whenever a significant refactor, migration, or new system is introduced, the engineer responsible checks whether any existing ADRs are affected and updates their status. This is also part of the PR template: "Does this PR supersede any existing ADRs?"

The second is tooling: a CI check that looks for ADRs in Accepted state that reference services, libraries, or patterns that have been removed from the codebase. This requires a link between ADRs and code - which is why the convention of referencing ADRs from package-level doc comments is valuable. The linter can verify that the referenced code paths still exist.

At the process level, a quarterly architecture review is the right venue for a full ADR audit. The staff engineer responsible for a domain reviews all ADRs in Accepted status and marks any that should be Deprecated or reviewed for supersession. This keeps the corpus healthy without requiring daily attention.

### Junior → FAANG: Practicing With Interview Questions Before the Interview

The questions in this section are the kind that FAANG bar-raisers ask to probe whether a candidate has genuinely practiced decision documentation or merely read about it. If you have written ADRs, you can answer these questions with specific examples. If you have not, you will answer them abstractly, and abstract answers do not pass the bar.

Before a FAANG interview, find three real decisions from your current or past work that would have benefited from an ADR. Write the ADR for each one retrospectively. The process will surface the specific language you need for the interview: the problem context, the alternatives you actually considered, the tradeoffs you actually accepted, and the consequences you actually experienced. That specificity is what makes interview answers credible.

### Senior @ FAANG: Using These Questions in Hiring Calibration

These questions function as a calibration rubric for distinguishing staff-level from senior-level ADR practice. The question about keeping a large ADR corpus current is specifically a staff-level question: it requires organizational thinking, tooling investment, and process design, not just individual documentation skill. A candidate who answers it by describing personal habits rather than organizational systems is answering at the senior level.

The question about integrating ADRs into the development lifecycle is a bar-raiser signal question: strong answers describe specific workflow integrations the candidate designed or championed, with concrete outcomes. Weak answers describe workflows the candidate read about or would hypothetically implement. The distinction is the difference between "I implemented a PR template check that surfaced three ADR gaps in the first month" and "I think it would be good practice to add an ADR check to the PR template."

When calibrating at the staff level, use these questions in combination rather than individually. A candidate who handles the "keeping corpus current" question at staff level but the "workflow integration" question at senior level is likely genuinely at the L5-to-L6 boundary and may need one more year of scope expansion before being ready. A candidate who handles both at staff level and can describe the governance implications of each answer is clearly operating at the L6+ level.

---
