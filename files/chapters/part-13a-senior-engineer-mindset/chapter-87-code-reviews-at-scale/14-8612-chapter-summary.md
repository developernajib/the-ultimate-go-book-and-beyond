## Summary

### Key Takeaways

These final takeaways distill the chapter into actionable principles you can apply starting with your very next code review. Each point represents a habit that separates effective reviewers from those who go through the motions.

1. **Reviews are about the code, not the person** - Keep it constructive
2. **Prioritize your feedback** - Blocking vs suggestion vs nit
3. **Explain the why** - Teaching is part of reviewing
4. **Automate what you can** - Linting, security, coverage
5. **Handle disagreements gracefully** - Sync > async for conflicts
6. **Scale thoughtfully** - Ownership, rotation, SLOs

### Review Checklist for Reviewers

Walking through a checklist in a fixed order prevents the common failure mode where a reviewer dives into style details and misses a security flaw buried deeper in the diff. Reading the PR description and tests first establishes the author's intent, so every subsequent judgment about correctness and design is grounded in what the code is actually supposed to do rather than what the reviewer assumes it does.

```
┌──────────────────────────────────────────────────────────────────┐
│                  REVIEWER CHECKLIST                              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  BEFORE REVIEWING:                                               │
│  □ Read PR description and linked issue                          │
│  □ Understand the context and problem                            │
│                                                                  │
│  DURING REVIEW:                                                  │
│  □ Check tests first (understand expected behavior)              │
│  □ High-level: Is the approach sound?                            │
│  □ Security: Auth, injection, secrets safe?                      │
│  □ Correctness: Bugs, edge cases, error handling?                │
│  □ Go-specific: Errors handled, resources cleaned up?            │
│  □ Design: Maintainable, appropriate abstraction?                │
│  □ Tests: Adequate coverage, right things tested?                │
│                                                                  │
│  FEEDBACK:                                                       │
│  □ Categorize comments (blocking, suggestion, nit)               │
│  □ Provide specific, actionable feedback                         │
│  □ Suggest alternatives when blocking                            │
│  □ Acknowledge what's done well                                  │
│                                                                  │
│  AFTER REVIEWING:                                                │
│  □ Respond to author's questions promptly                        │
│  □ Re-review addressed feedback                                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Quick Reference: Feedback Categories

This table provides a quick reference for categorizing your review comments. Consistently labeling your feedback helps authors prioritize their work and understand your expectations at a glance. When in doubt about whether something is blocking, ask yourself: "Would merging this cause a bug, security issue, or data loss?" If yes, it is blocking.

| Category | When to Use | Blocking? |
|----------|-------------|-----------|
| BLOCKING | Security, bugs, crashes | Yes |
| SHOULD FIX | Missing tests, poor design | Usually |
| SUGGESTION | Better approaches, optimization | No |
| QUESTION | Need clarification | No |
| PRAISE | Good code, clever solutions | No |
| nit | Minor style preferences | No |

### Junior → FAANG: Making the Reviewer Checklist a Pre-Submit Habit

The reviewer checklist in this section is the most practically useful interview preparation tool in the chapter because it is also the tool you use in actual reviews. Completing the checklist on your next five reviews before you click "submit" builds the muscle memory that produces consistently high-quality reviews under interview simulation conditions.

Focus on the sequence: PR description first, tests second, high-level approach third, then correctness and security. Candidates who have practiced this sequence consistently can reproduce it under interview pressure without thinking about it. Candidates who know the checklist intellectually but have not practiced it get flustered when the interviewer interrupts the flow.

The feedback category quick reference table is worth committing to memory because it removes ambiguity from the interview scenario. When an interviewer shows you a code snippet and asks you to review it, being able to say "this is a blocking issue because it will cause a nil panic in production under this specific condition" shows exactly the level of precision FAANG expects at L5.

### Senior @ FAANG: The Checklist as an Onboarding Infrastructure Investment

At L6 and above, the reviewer checklist becomes part of the onboarding infrastructure you build for new engineers joining your team.

The highest-value version of the checklist for a new hire is not a document they read. It is a paired review session where they apply the checklist alongside a senior engineer who narrates their thinking as they go through each step. That session, recorded or documented as a worked example, becomes a reference artifact that new reviewers can return to independently.

The "Quick Reference: Feedback Categories" table in this section should exist as a pinned message in your team's code review channel. Not as a reminder to current engineers who already know it, but as the first thing a new engineer sees when they join the channel and submit their first review. Onboarding infrastructure is review culture at its most leverage-efficient: invest once, benefit for every engineer who joins the team for years afterward.

Staff engineers who have built this kind of review onboarding infrastructure can describe it specifically in interview contexts: "I built a paired review curriculum for new hires that includes three worked example reviews, a team coding standards document, and a shadow period where new engineers observe senior reviews before participating independently. Time-to-independent-review dropped from six weeks to two as a result." That is a measurable, scoped, staff-level contribution to review culture.

---

**Next Chapter: Technical Writing & RFCs** - We'll cover how to write clear technical documents, RFCs, and design docs that drive decisions and build consensus.
