## Postmortem Template

A postmortem is the artifact a team produces after an incident. Done well, it is the most valuable engineering document the team writes that quarter. Done poorly, it is a blame-allocation exercise that nobody reads twice.

This chapter is the template, the conventions that make a postmortem worth reading, and the cultural moves that make a team write good ones.

### Blameless: The Foundational Move

A postmortem is blameless if it focuses on systems, not people. The system, not the engineer, allowed the bug to ship. The system, not the SRE, took 40 minutes to detect the regression. The system, not the on-call team, lacked the runbook.

Why blameless? Because every engineer has been the cause of an incident at some point in their career. A blame culture produces engineers who hide mistakes, not engineers who learn from them. A blameless culture produces postmortems that are honest, which means they are useful.

Concrete language differences:

- Blame: "Alice deployed the bad config."
- Blameless: "The deployment system did not flag the config as risky, and the config landed without canary."

The blameless version is more accurate (Alice did deploy, but the system also failed) and produces better action items (improve the deploy system).

### The Template

A canonical postmortem has these sections.

#### Title and Summary

One sentence: what happened, when, and the user-visible impact. Two paragraphs at most.

> **Title**: 2026-04-19 Search latency p99 elevated for 47 minutes due to allocator memory pressure.
>
> **Summary**: Between 14:03 and 14:50 UTC on 2026-04-19, the global Search service experienced p99 latency elevated to 380ms (normal: 65ms). The cause was tcmalloc memory pressure in the v158 binary that had rolled out at 13:55. A rollback to v157 at 14:50 returned latency to normal. User-visible impact: roughly 0.4% of search queries received slower-than-target responses for 47 minutes.

#### Impact

Quantified. Errors per minute, requests affected, customers affected, revenue impact (if estimable), SLO budget consumed.

> **Impact**:
> - 0.4% of queries served above the 200ms target latency.
> - Total error budget consumed: 8% of monthly budget.
> - No availability impact (no errors, only slow responses).
> - Customer-visible: yes, for the slow queries, no support tickets received.

#### Timeline

A minute-by-minute record from the first event to the resolution. Use UTC, never local time. Include both technical events and human actions.

> **Timeline (UTC)**:
> - 13:55 v158 begins canary at 1%.
> - 14:03 Latency alert fires at 1% canary (p99 > 200ms for 5min).
> - 14:05 On-call (Bob) acknowledges, investigates.
> - 14:11 Bob notices RSS on canary instances is 40% higher than control.
> - 14:18 Bob escalates to memory expert (Carol).
> - 14:22 Carol identifies tcmalloc bucket exhaustion in the heap profile.
> - 14:35 Decision to roll back, rollback initiated.
> - 14:42 Rollback complete on canary, latency returns to normal.
> - 14:50 Rollback complete fleet-wide, incident closed.

#### Root Cause

What actually went wrong, technically. Be precise.

> **Root cause**: A change to the tokenizer (commit `a3f24b`) introduced a per-query `std::vector<int64_t>` of variable size, typically 200KB. The allocation pattern hit a tcmalloc size class that had inadequate caching for this rate, causing repeated central-cache fills under load. The contention manifested as additional latency and elevated CPU.

#### Contributing Factors

Reasons the bug shipped, beyond the proximate cause. Often three or four.

> **Contributing factors**:
> 1. The benchmark suite did not include a high-QPS workload that would have surfaced the contention.
> 2. The canary signal threshold (10% latency increase) was higher than this regression's signal at 1% traffic, the alert threshold caught it via 5-minute average rather than at canary start.
> 3. The tokenizer change had been reviewed only for correctness, not memory profile.
> 4. tcmalloc's central-cache exhaustion under this allocation pattern was a known issue but not documented in our team's runbook.

#### Detection

How was the incident detected, and how long did it take?

> **Detection**: 8 minutes from canary start to alert (canary started 13:55, alert at 14:03). Above target for first-detect (target: 5 minutes).

#### Mitigation

What action ended the impact?

> **Mitigation**: Rollback to v157.

#### Action Items

Specific, owned, prioritized fixes.

> **Action items**:
> - **P0**: Roll forward fix for the tokenizer (avoid the large vector allocation). Owner: Alice. ETA: 2 days.
> - **P0**: Add a high-QPS allocation-pressure benchmark to the regression suite. Owner: Bob. ETA: 1 week.
> - **P1**: Tighten canary latency threshold from 10% to 5%. Owner: Bob. ETA: 3 days.
> - **P2**: Document tcmalloc central-cache contention in team runbook. Owner: Carol. ETA: 2 weeks.
> - **P3**: Add per-allocation-size telemetry. Owner: Dan. ETA: 1 month.

#### Lessons Learned

What does the team know now that it did not before?

> **Lessons learned**:
> - Canary signal at 1% traffic can be too small to surface allocator contention, we need direct allocator metrics, not just user-facing latency.
> - Memory-profile review should be part of the review process for changes that touch hot paths.

#### What Went Well

Often skipped, always valuable. The team's wins should be reinforced.

> **What went well**:
> - On-call response was fast (acknowledged in 2 minutes).
> - Escalation to a memory expert added the right expertise without delay.
> - The rollback path executed cleanly in under 8 minutes.

### What to Avoid

**Action items that are aspirational but not actionable.** "Be more careful" is not an action. "Add a clang-tidy check that flags vector allocations larger than 64KB in the tokenizer module" is.

**Root cause as singular.** Real outages have multiple causes. The five-whys exercise (ask "why" five times in succession) often reveals systemic issues. Use it.

**Blame disguised as system critique.** "The on-call engineer did not respond fast enough" is blame. "The alert routing was set to a paging policy of 5 minutes, this should be 2 minutes for SLO-affecting alerts" is a system fix.

**Focus on the proximate cause.** Yes, the tokenizer change caused the leak. The deeper cause might be that the team's review process does not require allocator-pressure analysis. The deeper cause is the more valuable action item.

**Postmortem-as-document with no follow-up.** The postmortem is the input to the action-item tracking system. Without follow-up, postmortems are write-only.

### The Postmortem Review

A team meeting once per week or two: walk through every recent postmortem. Read the action items. Check progress. Update statuses. Close out the completed ones. Re-prioritize the stale ones.

This meeting is the difference between postmortems-as-theater and postmortems-as-engineering.

### A Severity Scale

Postmortems should be calibrated by severity. A canonical scale:

- **Sev 1**: Major customer impact, all-hands response, exec notification. Postmortem mandatory, reviewed by whole team and leadership.
- **Sev 2**: Significant customer impact, on-call team responds. Postmortem mandatory, reviewed by team.
- **Sev 3**: Minor customer impact or internal-only impact. Postmortem optional, lightweight format.
- **Sev 4**: Near-miss, no impact but worth recording. Brief writeup.

The severity drives the depth and the audience. A Sev 1 postmortem is a project. A Sev 4 is a paragraph.

### A Real Example: Cause vs Trigger

A C++ database service had a postmortem where the trigger was "an SQL query with a deeply-nested subquery overflowed the recursion stack." The proximate cause was the missing depth check. The root cause, identified through five-whys, was that the team had not adopted Coverity, which would have flagged the unchecked recursion.

The action items targeted both: a specific fix for the recursion check, and a project to adopt Coverity for the codebase. The Coverity project would not have happened without this postmortem, six months later it had caught a dozen unrelated bugs.

### Senior at FAANG: The Cultural Investment

The senior contribution is investing in the postmortem culture. Writing the first few yourself, with care. Coaching new engineers through their first postmortem. Defending blamelessness in the rare moments when leadership wants to assign blame. The result is a team that learns from incidents, instead of one that hides them. Over years, that compounds.

---
