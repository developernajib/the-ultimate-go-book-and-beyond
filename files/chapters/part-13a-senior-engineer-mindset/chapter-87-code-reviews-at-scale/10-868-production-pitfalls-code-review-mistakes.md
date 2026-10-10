## 87.9 Production Pitfalls: Code Review Mistakes

### Pitfall 1: Reviewing Code Style Instead of Substance

**Real Incident Report**: A critical security fix sat in review for 5 days. The reviewer left 47 comments - 45 were style nits (spacing, naming preferences, comment formatting). The actual security logic received two comments, one of which missed a bypass vulnerability. The fix shipped with the vulnerability because the review focused on appearance over substance.

**The Anti-Pattern**:
- Prioritizing style over correctness
- Spending review time on automatable concerns
- Missing important issues buried in style nitpicks
- Creating PR review fatigue with low-value comments

**The Better Approach**:
```markdown
# Code Review Priority Stack

## Review in this order:

1. SECURITY (Critical)
   - Auth/authz checks
   - Input validation
   - Injection vulnerabilities
   - Secrets handling

2. CORRECTNESS (Critical)
   - Does it do what it claims?
   - Edge cases handled?
   - Error handling complete?
   - Race conditions?

3. DESIGN (Important)
   - Is this the right approach?
   - Will it scale?
   - Is it maintainable?

4. TESTS (Important)
   - Adequate coverage?
   - Testing the right things?

5. STYLE (Automate this)
   - Should be handled by linters
   - Only comment if not automatable
```

**Key Insight**: Google's code review guidelines explicitly say: "Reviewers should not require the author to polish every tiny piece of code." Focus on correctness. Automate style.

### Pitfall 2: Blocking Without Providing Alternatives

**Real Incident Report**: A reviewer left "I don't think this is the right approach" on a complex PR with no further explanation. The author spent two days guessing at alternatives, none of which satisfied the reviewer. The feature was delayed a week because the reviewer knew what they wanted but didn't communicate it.

**The Anti-Pattern**:
- Vague negative feedback ("this doesn't feel right")
- Blocking without explanation
- Expecting authors to read your mind
- Not distinguishing personal preference from technical requirement

**The Better Approach**:
```markdown
# Constructive Review Comment Template

## Instead of:
"This doesn't seem right"
"I don't like this approach"
"This could be better"

## Say:
"This approach [specific concern]. Consider [alternative] because [reason].
If you disagree, let's discuss."

## Example:
BAD: "The caching logic is wrong"

GOOD: "This caches before validation, so invalid data could
be served from cache. Consider validating first, then caching
only valid responses. Alternatively, we could add cache
invalidation on validation failure. Which approach fits
better with our patterns?"
```

**Key Insight**: Amazon's writing culture applies to code reviews. Be specific, provide options, explain reasoning. "What" without "why" doesn't help authors learn.

### Pitfall 3: Approving to Be Nice

**Real Incident Report**: A senior engineer approved a junior's PR without thorough review - they didn't want to discourage the new team member. The code had a subtle concurrency bug that caused data corruption in production. The incident was far more demoralizing to the junior than tough feedback would have been.

**The Anti-Pattern**:
- Rubber-stamping to avoid conflict
- Not reviewing thoroughly because "they know what they're doing"
- Prioritizing feelings over code quality
- Thinking your approval doesn't matter

**The Better Approach**:
```markdown
# Being Kind vs Being Nice in Reviews

## Nice (avoids discomfort, enables failure):
- Approving code you don't understand
- Skipping review because author is senior
- Ignoring concerns to avoid conflict

## Kind (honest, growth-focused):
- Taking time to understand before approving
- Asking questions when unsure
- Providing honest feedback with respect
- Blocking when necessary, with explanation

## If you're unsure:
"I don't fully understand [part]. Can you walk me through it?
I want to make sure I'm providing meaningful review."

## If you're concerned:
"I'm hesitant about [specific issue]. My concern is [reason].
Can we discuss before I approve?"
```

**Key Insight**: Netflix's "candor" value applies directly to code reviews. Honest feedback helps authors grow. Rubber stamps help nobody.

### Pitfall 4: Review Latency Killing Momentum

**Real Incident Report**: An engineer submitted a PR Friday afternoon. The designated reviewer was in a different timezone and had a full calendar. The PR sat for 4 days. By the time feedback arrived, the author had context-switched to another project and the PR sat another 3 days before revisions. A 2-hour implementation took 8 days to merge.

**The Anti-Pattern**:
- Long review queues with no SLO
- Reviewers treating reviews as low priority
- Not having backup reviewers
- Not considering timezone and calendar in reviewer selection

**The Better Approach**:
```markdown
# Code Review SLOs

## Google approach:
- First response within 24 hours (business hours)
- Same-day for urgent/small changes

## Implementation:
1. Set review SLOs for your team (24h first response is common)
2. Have backup reviewers for each area
3. Use round-robin or load-balanced reviewer assignment
4. Flag urgent reviews in PR title/labels
5. Track review latency as team metric

## Author responsibilities:
- Keep PRs small (< 400 lines ideally)
- Write good descriptions
- Self-review before requesting
- Be responsive to feedback

## Reviewer responsibilities:
- Check review queue at start and end of day
- Don't let reviews go stale over weekends
- If you can't review promptly, hand off
```

**Key Insight**: Studies show code review latency is the biggest predictor of developer satisfaction with the review process. Fast feedback loops enable fast iteration.

### Pitfall 5: Scope Creep in Review Feedback

**Real Incident Report**: A PR fixing a small bug received feedback to "while you're here, can you also refactor the surrounding code, add tests for unrelated functions, and update the documentation?" The 1-hour bug fix became a 2-week project. The bug remained unfixed for weeks while the scope kept expanding.

**The Anti-Pattern**:
- Expanding PR scope during review
- "While you're here..." requests
- Blocking on unrelated improvements
- Conflating "this should be fixed" with "this PR should fix it"

**The Better Approach**:
```markdown
# Managing Review Scope

## The PR fixes X. During review, you notice Y needs work.

## If Y is caused by this PR:
- Require it be fixed in this PR ✓

## If Y is pre-existing and unrelated:
- File a separate issue/ticket
- Comment: "I noticed Y - filed ISSUE-123"
- Do NOT block the PR on Y

## If Y is closely related but expands scope:
- Ask: "Would you prefer to address Y here or
  as a follow-up? I'm fine either way."
- Author decides

## Rule of thumb:
A PR should do ONE thing well.
The diff should be reviewable in one sitting.
```

**Key Insight**: At Stripe, "incremental over exhaustive" is a principle. Ship the bug fix. Improve the surrounding code in a separate, reviewable PR.

### Quick Reference: Code Review Anti-Patterns

The following table summarizes the most common anti-patterns covered in this section. If you recognize any of these patterns on your team, address them directly. Each anti-pattern has a straightforward fix, and the sooner you course-correct, the less organizational debt accumulates.

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| Style over substance | 50 style comments, 0 security comments | Prioritize correctness, automate style |
| Blocking without alternatives | "This is wrong" with no guidance | Specific concern + suggested fix |
| Rubber stamp approval | Approving without reading | Always understand before approving |
| Slow reviews | PRs sitting for days | Review SLOs, backup reviewers |
| Scope creep | Bug fix becomes refactor | File separate issues, don't block |
| Review by seniority | Only seniors review | Everyone reviews, all code reviewed equally |

### Junior → FAANG: Using These Anti-Patterns to Audit Your Own Review History

Each pitfall in this section maps to a failure mode that FAANG interviewers probe explicitly. Before your interview, audit your own review history for each pattern. If you find evidence that you have committed a pitfall, prepare a story about how you recognized and corrected it. "I used to leave too many style nits, but when I realized they were burying the substantive feedback, I started prioritizing correctness first and letting the linter handle style. My review quality improved because authors started engaging with the meaningful comments rather than dismissing all feedback as nit-picking." That arc demonstrates growth, which is exactly what behavioral interviews reward.

"Blocking without alternatives" is the pitfall that most often derails first-time senior engineer candidates. If your interview story about giving difficult feedback ends with "I told them their approach was wrong and we had a long discussion," without describing the alternative you proposed and why it was better, you are leaving the most important signal on the table.

Review latency is underappreciated as a FAANG culture signal. At companies with strong engineering cultures, long review latency is considered a team delivery problem, not just an individual professionalism issue. Demonstrating that you track and care about review turnaround time as a team health metric, not just your personal responsiveness, shows process maturity.

### Senior @ FAANG: Anti-Patterns as Team Health Diagnostics

At L6 and above, these anti-patterns are organizational health indicators. A team where "style over substance" is endemic has a miscalibrated review culture. A team where "slow reviews kill momentum" is a recurring complaint has a review workload distribution problem. A team where "approving to be nice" is common has an accountability gap.

Staff engineers who diagnose these patterns at the team level and design interventions, rather than addressing individual reviewers one by one, achieve cultural change at scale. The intervention for "style over substance" is not telling each engineer to stop leaving style comments. It is configuring the linter to catch style automatically and explicitly updating the review guidelines to say "style comments are only appropriate when not covered by existing linter rules." The intervention removes the temptation rather than relying on willpower.

Scope creep in review feedback is worth special attention as a staff-level concern because it is often generated by senior engineers who have good technical instincts but poor scope discipline. A senior engineer who routinely adds "while you're here" requests is not just slowing individual PRs. They are training authors to submit large, all-encompassing PRs preemptively, to avoid being asked to expand scope after submission. This creates a self-reinforcing cycle where PRs grow larger because engineers expect scope creep. The fix is modeling rigorous scope discipline publicly in your own reviews and explicitly naming when you are filing a separate ticket rather than expanding the PR.

---
