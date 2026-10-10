## FAANG Interview Q&A: Technical Writing and RFCs

These questions assess whether you can drive technical decisions through writing and whether you treat documents as leverage.

### 1. Tell me about an RFC you wrote that changed a team's direction.

Strong answers identify the decision at stake, the alternatives you evaluated, the specific concern your RFC raised that was not previously on the table, and the measurable outcome. Amazon interviewers look for documents that were genuinely two-way conversations, not one-way justifications. Include the reviewer comment that changed your own thinking.

### 2. Describe a time your writing failed to land.

This probes for self-awareness. Identify the document, the audience it missed, and what you changed in your writing afterward. Common failure modes are burying the decision under background, writing for your own peer group rather than the actual reviewers, or failing to name the alternatives that readers were secretly evaluating.

### 3. How do you decide between an RFC, an ADR, and a design doc?

The distinction matters at Staff level. RFCs propose decisions that have not yet been made. ADRs record decisions that have been made. Design docs cover the implementation shape of a decision that is already accepted. Be ready to explain why conflating the three is a common anti-pattern that produces documents everyone skims and no one trusts.

### 4. Design the RFC template your team would use for decisions that affect multiple services.

Cover the sections: context, goals and non-goals, proposal, alternatives considered (at least two, with honest trade-offs), consequences (including negative), migration plan, and reviewers. Discuss length targets (3-5 pages), the review SLA (5 business days), and how you handle dissent that arrives after the RFC is accepted. Reference MADR or Nygard formats where appropriate.

### 5. Walk through the structure of an ADR documenting a database choice between PostgreSQL and CockroachDB for a new Go service expected to handle 50k QPS.

A staff-level answer structures the ADR around the actual decision forces: consistency requirements, multi-region latency budget, operational expertise on the team, license and cost considerations, and the migration cost if the initial choice turns out to be wrong. Name the evaluation criteria before the recommendation, not after. Include the trade-offs you accept in the Consequences section so a future engineer can assess whether those trade-offs still hold.
