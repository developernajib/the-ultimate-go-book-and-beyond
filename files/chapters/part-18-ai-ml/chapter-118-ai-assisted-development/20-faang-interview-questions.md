## 118.15 FAANG Interview Questions

**Q: How do you review a pull request where most of the code was AI-generated?**

A: Apply the same standard as human code, with added attention to AI-specific failure modes. Read the code as if the author could not answer questions, then confirm the author can. Look for ignored errors, swallowed goroutine panics, unbounded concurrency, SQL built by string concatenation, and tests that assert nothing. Verify that the design matches the actual requirement rather than a plausible-sounding variant. Ask the author to explain one non-obvious decision in their own words. If they cannot, the PR is not ready regardless of test results.

**Q: What belongs in a CLAUDE.md file for a production Go service?**

A: A crisp description of what the service does, the tech stack and pinned versions, the directory layout, the domain language, the architectural rules that must not be broken, the security rules that are non-negotiable, the testing conventions, the Makefile targets, and an explicit list of things the AI must not do. Keep it short enough to read in one pass and specific enough that an unfamiliar assistant makes correct choices on the first try. Update it when conventions change, and review it in the same PRs as code.

**Q: When should you refuse an AI suggestion even if it compiles and passes tests?**

A: Refuse when the change touches authentication, authorization, or cryptography without a clear cited specification, when it introduces a new dependency without review, when it rewrites existing code in a style that conflicts with the codebase, when it adds speculative features beyond the request, or when it silences an error or a test. The cost of reverting a subtle security regression is far higher than the cost of rejecting a plausible-looking diff.

**Q: Tell me about a time AI assistance went wrong.**

A: This is a question about your review discipline, not about the model. Have a specific story ready with five parts: the task, what the AI generated, the review you applied, what you caught (or missed until later, which is the more honest and more interesting version), and what you changed in your process afterwards. The strongest answers name a failure mode rather than an incident, because that shows you generalized: "it wrote a cache with the mutex on a value receiver, `-race` caught it, and I now require a concurrent test on anything with a lock" is a better answer than a war story with no lesson attached. An answer of "it has never gone wrong for me" says only that you have not been reviewing carefully.

**Q: How would you measure the productivity impact of AI tooling on your team?**

A: Pick metrics that reflect outcome rather than activity. Cycle time from PR open to merge, defect escape rate into production, test coverage trend, and incident count per deploy. Run a controlled comparison where a subset of the team uses AI tooling for a sprint and the rest does not, then swap. Beware vanity metrics like lines written or AI suggestions accepted, which reward volume over quality.

The answer that separates candidates is what you say about self-reported data. METR's 2025 trial found experienced developers were about 19% slower with AI while believing they were 20% faster, so a survey asking your team whether AI helps will return a number that is not just imprecise but directionally unreliable. Collect qualitative feedback on cognitive load, since that is a real cost worth knowing about, but never let it stand in for the measurement. If you are asked to justify AI spend and the only evidence is that everyone likes it, say so plainly and go get the cycle-time data.

**Q: What is the right way to onboard a new engineer onto a team that uses AI heavily?**

A: Start with fundamentals, not tooling. A new engineer who leans on AI before they understand the codebase builds fragile intuitions. Have them read the CLAUDE.md, the architecture docs, and the last 20 PRs in their area. Assign a human mentor for the first month. Encourage AI use for boilerplate (tests, docs, repetitive refactors) and discourage it for architecture and code review. After a month, review how they used AI and recalibrate. Skill atrophy is a real risk, and early habits matter.

---

### Junior → FAANG: Interview Questions as Study Framework

These FAANG interview questions cover the full spectrum of AI-assisted engineering: code review process (how do you review AI-generated code?), failure analysis (when did AI assistance go wrong?), onboarding strategy (how do you introduce AI tools to new engineers?), and productivity measurement. Preparing a concrete, specific answer for each question before your interview is essential because these questions are open-ended and require calibrated answers based on real experience.

The onboarding question is particularly revealing because it tests whether you understand the skill development risks of AI tool adoption. The correct answer (fundamentals first, CLAUDE.md and architecture docs before AI tools, human mentorship for the first month) signals that you understand the dependency relationship between AI tool effectiveness and foundational knowledge. Engineers who say "give them AI tools on day one" have not thought through the risk that new engineers who use AI before they understand the codebase develop incorrect mental models that AI reinforces rather than corrects.

The failure analysis question (when did AI assistance go wrong?) is an opportunity to demonstrate learning from experience. Prepare a specific story: the task, what AI generated, the review you applied, the issue you caught (or did not catch until later), and what you changed about your process to prevent the same issue. Engineers who have caught and corrected AI-generated bugs have developed the review discipline that FAANG code review rounds assess.

### Senior @ FAANG: Interview Questions as Staff-Level Governance Indicators

At senior level, these interview questions have a different character: they assess whether you have thought through the organizational implications of AI tool adoption, not just the individual workflow implications. "How do you review AI-generated code?" at L4 is about personal review discipline. At L6, it is about the team review standard: what is the minimum required review for AI-assisted PRs, how is it enforced, and how do you measure whether it is working?

"When did AI assistance go wrong?" at L4 is about personal error recovery. At L6, it is about incident analysis: when AI-assisted code caused a production incident, what was the review failure that allowed it to merge, and what process change prevented recurrence? The organizational response to AI-assisted incidents (post-incident review that specifically examines the review process for AI-generated code, not just the technical cause) is a governance contribution that staff engineers lead.

The onboarding question at L6 becomes organizational AI readiness planning: how does the organization scale AI-assisted development capabilities as it hires hundreds of engineers who have varying levels of AI tool experience and foundational engineering skills? The answer involves standardized onboarding curricula, CLAUDE.md training, prompt library access, and review standard documentation that provide consistent foundations regardless of prior AI tool experience. Building this onboarding infrastructure, not just describing it in an interview, is the staff-level contribution that distinguishes L6 candidates from L5 candidates in FAANG AI engineering roles.
