## 88.9 Production Pitfalls: Technical Writing Mistakes

### Pitfall 1: Writing Before Thinking

**Real Incident Report**: An engineer spent two weeks writing a detailed RFC for a new caching layer. After review, the fundamental approach was rejected because it didn't address the actual bottleneck. Two weeks of writing effort wasted because the problem wasn't validated before the solution was documented.

**The Anti-Pattern**:
- Jumping to solution documentation before problem validation
- Falling in love with your solution before alternatives analysis
- Writing detailed specs before proving the approach
- Skipping the "do we need this?" question

**The Better Approach**:
```markdown
# RFC Development Stages

## Stage 1: Problem Validation (BEFORE writing RFC)
- Can I explain the problem in 2 sentences?
- Do stakeholders agree this is worth solving?
- What happens if we do nothing?
- What's the cost of the problem vs cost of solving it?

## Stage 2: Solution Exploration (Light documentation)
- Sketch 2-3 approaches (not detailed)
- Quick validation with 2-3 engineers
- Identify the frontrunner

## Stage 3: Full RFC (Only after stages 1-2)
- Detailed problem statement
- Proposed solution with depth
- Alternatives with analysis
- Implementation plan

## Time investment:
Stage 1: 2-4 hours
Stage 2: 1-2 days
Stage 3: 3-5 days

Don't skip to Stage 3!
```

**Key Insight**: Amazon's "Working Backwards" starts with the press release (outcome) before any technical design. Validate the problem before documenting the solution.

### Pitfall 2: Writing for Yourself Instead of Your Audience

**Real Incident Report**: A staff engineer wrote a detailed RFC explaining a database migration. It was technically excellent, with deep MySQL internals. Product managers and frontend engineers - key stakeholders - couldn't understand it. The RFC sat in review for months because most reviewers couldn't engage with it.

**The Anti-Pattern**:
- Assuming all readers have your technical depth
- Not adjusting language for mixed audiences
- Burying the business impact in technical details
- Writing to impress rather than communicate

**The Better Approach**:
```markdown
# Audience-Aware Document Structure

## Executive Summary (for everyone)
- Problem in business terms
- Proposed solution in one paragraph
- Impact: what changes, what benefits
- Timeline and resources needed

## Overview (for technical stakeholders)
- Technical problem statement
- Proposed architecture (with diagram)
- Key trade-offs and decisions
- Risks and mitigations

## Detailed Design (for implementers)
- Complete technical specification
- API contracts
- Data models
- Migration steps

## Appendix (for deep experts)
- Benchmark data
- Alternative analysis
- Reference material

Each section should stand alone for its audience.
```

**Key Insight**: Google's design doc template explicitly requires an executive summary that a non-technical VP could understand. If you can't explain it simply, you may not understand it well enough.

### Pitfall 3: All Problem, No Solution Depth

**Real Incident Report**: An RFC had a brilliant 5-page problem analysis showing exactly why the current system was failing. The solution section was one page of hand-wavy "we'll use Kafka." Reviewers approved the problem statement, but the implementation failed because the solution was never actually designed.

**The Anti-Pattern**:
- Deep problem analysis, shallow solution specification
- "We'll figure out the details during implementation"
- Not specifying interfaces, contracts, or migration paths
- Treating the RFC as the end, not the beginning

**The Better Approach**:
```markdown
# Solution Depth Checklist

## Required in every RFC:

□ Architecture diagram showing all components
□ Data flow for primary use cases
□ API contracts (request/response for key operations)
□ Data model changes (schema, migrations)
□ Error handling approach
□ Failure modes and recovery
□ Observability (metrics, logs, traces)
□ Migration plan (how do we get from here to there?)
□ Rollback plan (how do we undo if it fails?)

## If any of these is "TBD":
The RFC isn't ready for approval.
Design it or call out as explicit future work.
```

**Key Insight**: At Stripe, RFCs must specify rollback procedures before approval. "We'll figure it out" is not an acceptable implementation plan.

### Pitfall 4: Not Getting Early Feedback

**Real Incident Report**: An engineer spent three weeks writing a detailed RFC in isolation. They proudly shared it with 30 engineers. Within a day, three different senior engineers pointed out fundamental flaws in the approach. Three weeks wasted because they didn't get feedback from the right people early.

**The Anti-Pattern**:
- Writing in isolation until "complete"
- Sharing only when polished
- Not identifying key reviewers early
- Waiting for formal review to get feedback

**The Better Approach**:
```markdown
# Early Feedback Protocol

## Before writing the full RFC:
1. Identify 2-3 people who:
   - Know the problem space deeply
   - Have veto power (tech leads, architects)
   - Will be affected by the solution

2. Share a 1-page outline:
   - Problem (2-3 sentences)
   - Proposed approach (1 paragraph)
   - Key trade-offs (bullet list)
   - Ask: "Am I heading in the right direction?"

3. Iterate on the approach before full write-up

## After draft completion:
1. Share "draft" version with early reviewers
2. Get feedback before broad distribution
3. Mark clearly: "DRAFT - seeking feedback"

## Then broader review:
1. Final version to full reviewer list
2. Specific questions you want answered
3. Clear deadline for feedback
```

**Key Insight**: Meta's diff review culture applies to docs too. Early feedback prevents expensive late-stage rewrites.

### Pitfall 5: No Decision Record After the RFC

**Real Incident Report**: An RFC was approved and implemented two years ago. New team members have questions about why the system works this way. The RFC is outdated (implementation diverged), and nobody recorded the decisions made during review. The "why" is lost - the team has to reverse-engineer decisions or guess.

**The Anti-Pattern**:
- Treating RFC approval as the end
- Not updating docs when implementation diverges
- Not recording decisions made during review
- No ADRs for significant choices

**The Better Approach**:
```markdown
# Document Lifecycle Management

## During RFC Review:
- Track all decisions made in comments/discussions
- Note which alternatives were rejected and why
- Record any scope changes

## After RFC Approval:
1. Create ADRs for key decisions:
   - What was decided
   - Why (context, constraints)
   - What was rejected and why
   - Consequences (positive and negative)

2. Update RFC as implementation proceeds:
   - Mark sections superseded by implementation
   - Link to actual code/configs
   - Note intentional divergences

## RFC Statuses:
Draft → Under Review → Approved → Implemented → Superseded

## Every 6 months:
- Review active RFCs
- Mark outdated ones as superseded
- Link to current documentation
```

**Key Insight**: ADRs (Architecture Decision Records) create institutional memory. Without them, teams re-debate the same decisions because context was lost.

### Quick Reference: Technical Writing Anti-Patterns

This table summarizes the five most common anti-patterns covered in this section. Keep it handy as a quick diagnostic tool when reviewing your own documents or providing feedback on others' RFCs. If you notice any of these symptoms in a document, the corresponding fix column tells you exactly how to address it.

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| Write before think | Detailed RFC, rejected approach | Validate problem before solution |
| Wrong audience | Technical depth for non-technical readers | Layer content for each audience |
| Shallow solution | Great problem analysis, vague solution | Require implementation detail |
| Late feedback | Big reveal, fundamental objections | Early feedback from key reviewers |
| No decision record | "Why did we do this?" | ADRs + maintained documentation |
| Perfectionist draft | Never finished, never shared | Share drafts early, iterate |

---
