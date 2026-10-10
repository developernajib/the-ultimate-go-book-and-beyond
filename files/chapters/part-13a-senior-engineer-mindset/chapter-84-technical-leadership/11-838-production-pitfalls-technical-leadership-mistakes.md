## 84.10 Production Pitfalls: Technical Leadership Mistakes

### Pitfall 1: Leading with Authority Instead of Influence

**Real Incident Report**: A senior engineer was promoted to tech lead and immediately started mandating coding standards, architecture decisions, and code review processes without team input. Within three months, two senior engineers left, and the team's velocity dropped 40%.

**The Anti-Pattern**:
- Assuming title grants automatic respect
- Making unilateral technical decisions
- Using "because I said so" as justification
- Not explaining the reasoning behind decisions

**The Better Approach**:
- Build credibility through demonstrated expertise
- Propose ideas and gather feedback before mandating
- Document reasoning in ADRs so everyone understands "why"
- Let others reach the same conclusion through discussion

**Key Insight**: At Google, technical leadership explicitly comes from expertise, not hierarchy. The phrase "I'm the tech lead, so..." is a red flag that someone is relying on authority rather than influence.

### Pitfall 2: Solving Problems Instead of Enabling Others

**Real Incident Report**: A tech lead noticed a junior engineer struggling with a complex bug. Instead of coaching, they took over the keyboard and fixed it in 30 minutes. The junior engineer learned nothing, felt demoralized, and the same class of bug appeared in their code two weeks later.

**The Anti-Pattern**:
- Taking over when others are stuck
- Providing solutions instead of asking guiding questions
- Prioritizing speed over learning
- Creating dependency on your problem-solving

**The Better Approach**:
```markdown
# Coaching Instead of Solving

## Wrong (Solving):
"Let me look at that... oh, the issue is here,
 you need to add a context timeout."

## Right (Coaching):
"Walk me through what you've tried so far."
"What happens when you add logging here?"
"What would happen if the database is slow?"
"What Go patterns do we use for timeout handling?"
```

**Key Insight**: Stripe explicitly trains tech leads to "multiply" rather than "add." Adding means doing work yourself. Multiplying means enabling 10 engineers to be 10% more effective - a bigger total impact.

### Pitfall 3: Being a Technical-Only Leader

**Real Incident Report**: A brilliant architect was promoted to staff engineer. They continued shipping great code but avoided all meetings, didn't build relationships with product managers, and refused to participate in hiring. After two years, they were still struggling to get their initiatives prioritized because they had no organizational influence.

**The Anti-Pattern**:
- Avoiding "politics" and organizational work
- Not building relationships outside engineering
- Viewing soft skills as optional
- Only communicating through code

**The Better Approach**:
```
TECHNICAL LEADERSHIP TIME ALLOCATION (Senior/Staff Level):

IC5/L5 Engineer:    80% technical, 20% organizational
Senior/Staff:       60% technical, 40% organizational
Principal:          40% technical, 60% organizational

"Organizational" includes:
- Building cross-team relationships
- Communicating with stakeholders
- Participating in hiring
- Mentoring and coaching
- Strategic planning
```

**Key Insight**: Netflix's "context, not control" philosophy requires leaders who can set context - which is fundamentally about communication and relationships, not just technical decisions.

### Pitfall 4: Perfectionism That Blocks Progress

**Real Incident Report**: A tech lead blocked a PR for six weeks because the code "wasn't elegant enough," despite it being correct, tested, and meeting requirements. The feature was a time-sensitive business need, and the delay cost the company a major partnership.

**The Anti-Pattern**:
- Blocking on style preferences disguised as "quality"
- Perfect as the enemy of good enough
- Not distinguishing blocking issues from nice-to-haves
- Endless iteration on already-working code

**The Better Approach**:
```markdown
# PR Feedback Prioritization

## BLOCKING (Must fix before merge):
- Security vulnerabilities
- Data correctness issues
- Missing error handling for critical paths
- Obvious performance problems (O(n²) on large data)

## SUGGEST (Should fix, but not blocking):
- Missing tests for edge cases
- Inconsistent naming with codebase
- Could be more idiomatic

## NIT (Nice to have, author's choice):
- Style preferences
- Alternative approaches that aren't clearly better
- "I would have done it differently"
```

**Key Insight**: Amazon's "bias for action" principle applies to code reviews. Blocking should be reserved for real problems, not aesthetic preferences.

### Pitfall 5: Invisible Leadership Work

**Real Incident Report**: A staff engineer spent six months cleaning up technical debt, unblocking teams, and mentoring juniors - all high-impact work. At performance review, their manager said: "I don't see evidence of Staff-level impact." The engineer had done the work but hadn't documented or communicated it.

**The Anti-Pattern**:
- Assuming good work speaks for itself
- Not documenting your impact
- Working without visibility
- Avoiding self-promotion as "bragging"

**The Better Approach**:
```markdown
# Making Leadership Work Visible

## Weekly/Bi-weekly:
- Update your brag document with accomplishments
- Send brief status updates to stakeholders
- Share learnings in team channels

## Monthly:
- Summarize impact metrics (teams unblocked, debt reduced)
- Present at team meetings or brown bags
- Write internal blog posts about solved problems

## Quarterly:
- Compile impact narrative for reviews
- Connect your work to business outcomes
- Get testimonials from people you've helped
```

**Key Insight**: At Meta, "make your impact legible" is explicit guidance for senior ICs. Your work helping others doesn't count if leadership doesn't know about it.

### Quick Reference: Technical Leadership Anti-Patterns

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| Authority over influence | "Because I'm the tech lead" | Build consensus, explain reasoning |
| Hero problem-solver | Taking over instead of coaching | Ask questions, guide to answers |
| Technical-only focus | Avoiding meetings, relationships | Invest in organizational skills |
| Perfectionism | Blocking PRs for style | Prioritize feedback (blocking/suggest/nit) |
| Invisible work | Impact unknown at review time | Document and communicate regularly |
| Lone wolf | Not sharing knowledge | Write docs, present, mentor |

### Junior → FAANG: Pitfalls as Interview Preparation Material

Each pitfall in this section is a behavioral interview question in disguise. "Technical debt accumulation" maps to: "Tell me about a time you had to balance shipping quickly vs doing it right." "Communication failures" maps to: "Describe a situation where a miscommunication caused a problem and how you resolved it."

Prepare one genuine story for each major pitfall category where you either fell into the pitfall yourself or navigated a team through it. The story where you personally made the mistake and corrected it is usually more compelling than one where you expertly avoided it. Humility and self-correction are stronger signals than claimed perfection.

One pitfall to specifically prepare for: scope creep. Almost every engineering project encounters it, and the ability to describe how you held scope boundaries, communicated tradeoffs, and made deliberate decisions about what to cut is a core senior engineer signal that FAANG interviewers frequently probe.

### Senior @ FAANG: Systemic Prevention vs Individual Correction

At staff and principal levels, fixing individual leadership mistakes is not the job. Reducing the systemic frequency of those mistakes across the organization is. This requires understanding the root causes of each pitfall, not just the surface symptoms.

"Invisible work" is not a personal failure of self-promotion. It is often a systemic failure of how work is tracked and communicated in the organization. The staff engineer who introduces a lightweight weekly digest, a structured planning process that surfaces cross-team dependencies, or a consistent artifact standard for design reviews is attacking the root cause rather than coaching individuals one at a time.

The governance question for each pitfall: what organizational structure or process incentivizes this mistake? Lone wolf behavior is often incentivized by reward systems that credit individual contribution more than collaboration. Technical debt accumulation is often incentivized by shipping velocity metrics that do not account for future maintenance cost. If you only correct individual behavior without changing the incentive structure, the pitfall will recur with the next engineer in that role. Senior engineers operate on the incentive structure.

---
