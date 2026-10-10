## 87.11 Interview Questions: Code Reviews

### Question 1: "How do you approach code reviews, and what do you prioritize?"

**What Interviewers Look For:**
- Structured approach
- Understanding of priorities
- Balance of thoroughness and speed
- Team awareness

**Strong Answer Framework:**

```markdown
# Framework: Code Review Approach

## My Process (30 seconds)
"I follow a three-pass approach:
1. Understand context (PR description, linked issue)
2. High-level review (architecture, approach)
3. Detailed review (line by line, edge cases)"

## Prioritization (45 seconds)
"I prioritize feedback in this order:
1. Security vulnerabilities (blocking)
2. Correctness bugs (blocking)
3. Missing error handling (usually blocking)
4. Design issues (blocking if architectural)
5. Performance concerns (depends on context)
6. Code clarity (suggestion)
7. Style nits (clearly marked, not blocking)

The key is distinguishing 'must fix' from 'nice to have'
and communicating that clearly."

## What I Look For Specifically (30 seconds)
"For Go code specifically, I focus on:
- Error handling (every error checked?)
- Resource cleanup (defer Close()?)
- Concurrency safety (race conditions?)
- Context propagation
- Input validation at boundaries"

## Balancing Speed and Quality (30 seconds)
"I aim for same-day review. If I can't do thorough review
quickly, I'll do a partial review with key concerns and
communicate timeline for the rest. Fast feedback is more
valuable than perfect feedback delayed a week."
```

---

### Question 2: "Tell me about a time you gave difficult feedback in a code review."

**What Interviewers Look For:**
- Ability to be constructive while honest
- Emotional intelligence
- Conflict resolution
- Focus on outcomes

**Strong Answer Framework:**

```markdown
# Framework: Difficult Code Review Feedback

## Situation (20 seconds)
"A senior engineer proposed a complex caching solution. I
saw significant issues - race conditions, memory leaks,
and over-engineering for our use case."

## Challenge (20 seconds)
"The challenge was that they were senior and invested in
the solution. I needed to raise serious concerns without
making it a battle of egos."

## Approach (60 seconds)
"I structured my feedback carefully:

1. **Started with understanding**: 'Help me understand the
   reasoning for X approach?' - maybe I was missing context

2. **Asked questions first**: 'What happens under this
   scenario?' rather than 'This fails under...'

3. **Provided data**: I ran the code with -race flag and
   shared the output showing the race conditions

4. **Suggested alternatives**: Instead of just criticism,
   I proposed a simpler approach with pros/cons

5. **Moved to sync**: After two back-and-forths in comments,
   I suggested we talk live"

## Resolution (30 seconds)
"In the conversation, I learned their approach solved a
problem I wasn't aware of. We collaborated on a solution
that addressed my concerns while keeping their key insight.
The final code was better than either of our original ideas."

## What I Learned (15 seconds)
"The best review feedback isn't about being right - it's about
getting to the best solution. Questions are more effective
than statements when giving difficult feedback."
```

---

### Question 3: "How would you handle a situation where a PR has been blocked for days due to review disagreements?"

**What Interviewers Look For:**
- Conflict resolution skills
- Ability to unblock teams
- Practical problem-solving
- Understanding of trade-offs

**Strong Answer Framework:**

```markdown
# Framework: Unblocking Review Disagreements

## Diagnosis (30 seconds)
"First, I'd understand why it's stuck:
- Is it a style disagreement? (probably not worth blocking)
- Is it an architectural concern? (worth blocking)
- Is it miscommunication? (can be resolved)
- Is it personal/political? (needs different handling)"

## For Technical Disagreements (45 seconds)
"If it's a genuine technical disagreement:

1. **Get both parties in a call** - Text loses nuance
2. **Find common ground** - What do we agree on?
3. **Identify the real concern** - Often different from stated
4. **Propose experiment** - 'Let's try both, benchmark'
5. **Time-box the decision** - 'We'll decide by EOD'

If still unresolved, bring in a neutral third party - not
to decide who's right, but to help find compromise."

## For Style/Preference (30 seconds)
"If it's style preference blocking a PR, I'd ask:
'Is this hill worth dying on? What's the cost of delay?'

Often the answer is: 'Ship it, iterate later.' We can
always improve code, but blocked PRs kill momentum."

## Prevention (30 seconds)
"To prevent future blockage:
- Establish team coding standards
- Define what's blocking vs suggestion
- Have clear escalation path
- Track review latency as team metric

On my last team, we had a '24-hour rule' - if review disagreement
goes 24 hours, it automatically escalates to tech lead."
```

---

### Question 4: "How do you review code from someone much more senior than you?"

**What Interviewers Look For:**
- Professional confidence
- Intellectual humility
- Ability to add value regardless of seniority
- Growth mindset

**Strong Answer Framework:**

```markdown
# Framework: Reviewing Senior Code

## Mindset (30 seconds)
"Seniority doesn't mean infallibility. I've caught bugs in
principal engineers' code. I've also learned a lot from
reviewing their work. Both are valuable."

## Approach (60 seconds)
"When reviewing senior engineers:

1. **Still do thorough review** - Don't rubber stamp
   because of their title. That's a disservice to the code.

2. **Ask learning questions** - 'I'm curious about this
   approach. Can you explain the reasoning?' - I might
   learn something, or my question might reveal an issue.

3. **Trust but verify** - I still check error handling,
   edge cases, tests. Experience reduces but doesn't
   eliminate mistakes.

4. **Be confident in my areas** - If I know the domain well,
   I add value regardless of their seniority.

5. **Frame feedback appropriately** - 'Did you consider...'
   rather than 'You should...' when I'm less certain."

## Example (30 seconds)
"Recently, I reviewed a Staff engineer's code. I noticed
they'd used a pattern I didn't recognize. Instead of
assuming it was wrong, I asked about it. Turns out it was
an optimization I hadn't seen - I learned something.

But I also found a nil pointer bug they'd missed. We all
make mistakes, regardless of level."

## Key Insight (15 seconds)
"Good review isn't about hierarchy. It's about multiple
perspectives making code better. I've learned more from
reviewing senior engineers than from having my code reviewed."
```

### Junior → FAANG: Preparing for the Seniority-Regardless Question

"How do you review code from someone much more senior than you?" appears in every L5 loop because it tests two things simultaneously: intellectual humility (do you defer too much) and professional confidence (do you still review rigorously). The expected answer at L5 demonstrates that you understand review is about the code, not the person, and that you have actually caught issues in senior engineers' code before.

Before your interview, identify one concrete example where you caught something in a senior engineer's code. It does not need to be a major bug. It needs to be real, and you need to describe how you framed the feedback in a way that was respectful and useful. That story answers three questions at once: your review rigor, your professional confidence, and your communication judgment.

For question 1 (how do you approach code reviews), practice limiting your answer to the framework structure in this section: process in 30 seconds, prioritization in 45 seconds, Go-specific items in 30 seconds, velocity balance in 30 seconds. Most candidates over-explain and lose the interviewer. The structured answer demonstrates that you have thought carefully about review, not just that you do it.

### Senior @ FAANG: Using These Questions in Staff Engineer Calibration

At L6 and above, these questions become calibration instruments in your own assessment of other engineers' review maturity. When a manager asks you whether an engineer is ready for L5 promotion, one of the data points you should be able to supply is: "I have reviewed their review history. They prioritize feedback correctly, they explain the reasoning behind blocking comments, and they have given constructive feedback to senior engineers without deferring unnecessarily."

The disagreement question is the highest-value calibration signal for L5 to L6 promotion decisions. Engineers at L5 resolve disagreements within their team. Engineers at L6 resolve disagreements across teams, where the power dynamics are more complex and the stakes for getting the process wrong are higher. In a calibration discussion, look for stories that involve cross-team disagreements, not just within-team ones.

"How would you handle a PR blocked for days due to review disagreements?" is also a culture diagnostic. The expected answer at L6 identifies the systemic fix alongside the immediate resolution. Not just "I would call a meeting," but "I would call a meeting to resolve this instance, and then I would propose a team agreement about how we handle review disagreements so we do not have to resolve each one ad hoc." That pattern, immediate plus systemic, is the staff engineer response.

---
