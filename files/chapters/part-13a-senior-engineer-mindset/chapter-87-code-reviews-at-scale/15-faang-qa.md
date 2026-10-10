## FAANG Interview Q&A: Code Reviews at Scale

These questions probe whether you can scale code-review culture beyond your immediate team and whether you use reviews as a deliberate leverage point rather than a gatekeeping chore.

### 1. Describe a code review that changed how you thought about a problem.

Strong answers describe a specific reviewer comment that reframed the design space, not just caught a bug. Include what the reviewer said, why it landed, and how you have since applied the lesson to your own reviews of others. Google interviewers weight this heavily for readability-reviewer-adjacent roles.

### 2. Tell me about a time you had to give difficult feedback in a code review.

Focus on tone, specificity, and the outcome. Avoid examples where you simply rejected the PR. The best answers describe a conversation where the author left feeling respected and with a clearer understanding of the design principle at stake. Amazon interviewers probe for Earn Trust here.

### 3. How have you scaled code review practices across a team of 30+ engineers?

Cover CODEOWNERS for distributing review load, automated pre-review checks (formatter, linter, race detector, coverage delta), team-level PR size norms, SLO on review turnaround time, and deliberate pairing of junior and senior reviewers. Meta and Stripe expect you to name specific metrics you used to diagnose health and the anti-patterns you addressed.

### 4. How would you design a code review culture for a new Go service owned by 4 engineers that will grow to 20?

Discuss the initial norms (PR size cap, required CI gates, at least one domain reviewer), the tooling you would put in place before growth (CODEOWNERS, auto-assignment, branch-protection rules), and the rituals you would add as the team crosses 10 engineers (weekly review-pattern readouts, explicit readability review for new hires). Anticipate the dysfunctions that emerge at 15-20 engineers: drive-by nits, senior-engineer review hoarding, and bikeshedding.

### 5. Walk through how you would approach a 2,000-line Go PR that refactors a core package.

A senior-level answer asks the author to split the PR first. If a split is genuinely impossible, structure your review in passes: first the interface changes, then the concurrency model, then the tests, then line-level readability. Explain which classes of feedback you would block on and which you would leave as non-blocking suggestions. Discuss how you would handle a PR this large if the author is a senior engineer who pushes back on the split request.
