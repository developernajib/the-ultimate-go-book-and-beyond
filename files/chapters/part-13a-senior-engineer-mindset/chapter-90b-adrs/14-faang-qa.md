## FAANG Interview Q&A: Architectural Decision Records

These questions come up in Staff and Principal interviews where the interviewer is assessing whether you can institutionalize decision-making rather than just making decisions yourself.

### 1. Tell me about an ADR you wrote that a future engineer thanked you for.

Strong answers describe the decision context, the alternatives you captured honestly, and the specific future engineer who avoided a costly mistake because the ADR made the rejected options explicit. If you cannot name such an engineer, describe the onboarding session where a new hire reached a productive disagreement with an existing design because the ADR gave them the vocabulary.

### 2. Describe a time a team's ADR process broke down.

Common failure modes: ADRs written after the decision, ADRs that only list positive consequences, ADRs that pile up in a folder no one reads, and ADRs that become binding law rather than living records. Identify which failure mode you observed and the intervention you made. Meta and Stripe look for evidence that you treated ADR culture as an ongoing investment rather than a one-time rollout.

### 3. How do you decide which decisions deserve an ADR?

The threshold matters. Use three criteria: hard to reverse, crosses team boundaries, or requires context that will not be obvious to a future reader. Reject ADRs for decisions that pass none of the three. Be ready to explain why writing ADRs for trivial decisions is actively harmful because it dilutes the signal.

### 4. Design an ADR template for a team of 8 engineers building a new Go microservice.

Cover: title, status (Proposed / Accepted / Superseded), context, decision, alternatives with honest trade-offs, consequences (positive and negative), and links to the PR and related ADRs. Discuss the review process (2 reviewers, 48-hour objection window, merge to `docs/adr/`), the numbering scheme, and how you would enforce ADR creation when a PR introduces a new external dependency.

### 5. Walk through the ADR you would write for adopting gRPC versus continuing with REST for internal service-to-service calls.

A Staff-level answer structures the ADR around the actual forces: schema evolution (protobuf versus OpenAPI), streaming requirements, tooling maturity (grpc-go ecosystem), client-side code generation, debuggability, and the operational cost of running both protocols during the migration window. Name the consequences you accept: heavier tooling in CI, a learning curve for engineers unfamiliar with protobuf, and the observability changes required for gRPC-specific tracing.

### Junior → FAANG: Preparing Authentic Answers

These questions cannot be answered authentically without having actually written ADRs. The most important preparation for this interview section is to write real ADRs now, before you are interviewing. Start with the gRPC-versus-REST question: write the actual ADR for a service you are working on or have worked on. The process of filling in the sections forces you to do the alternatives analysis and consequences thinking that the question is probing for.

When preparing stories for question 1, be specific about the engineer who benefited and the specific mistake they avoided. Generic stories ("someone said the ADR was helpful") do not carry interview weight. Specific stories ("Maria was about to add the same Redis cluster we had removed six months earlier for memory pressure reasons, until she read ADR-007") are memorable and credible.

### Senior @ FAANG: What the Interviewer Is Measuring

Behind each of these five questions is a specific competency the interviewer is assessing. Question 1 measures whether you can demonstrate concrete impact from a practice rather than describing its abstract benefits. Question 2 measures whether you can diagnose organizational failure modes with the same rigor you would apply to system failure modes. Question 3 measures whether you have calibrated judgment about when governance adds value versus overhead. Question 4 measures whether you can design a process that is specific enough to be implementable, not just described in principles. Question 5 measures whether your ADR writing reflects the actual forces at play in a real technical decision, not a textbook discussion of tradeoffs.

Strong candidates answer all five at the same level of specificity: they name real decisions, real engineers, real tradeoffs, and real consequences. They are comfortable saying "we got this wrong initially and had to update the ADR six months later" because that demonstrates the practice is living rather than ceremonial. They connect the ADR practice to organizational outcomes: faster onboarding, fewer re-litigated decisions, lower incident rates from the class of failures caused by violating past decisions without knowing it. That connection between practice and outcome is what distinguishes staff-level ADR competency from senior-level ADR familiarity.
