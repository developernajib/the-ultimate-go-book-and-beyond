## 88.3 The RFC Process

### RFC Lifecycle

An RFC does not go from idea to implementation in one step. It moves through a series of well-defined stages, each with its own purpose and expectations. Understanding this lifecycle helps you know what kind of feedback to expect at each stage and when your proposal is ready to move forward. Rushing through the early stages (especially the draft and discussion phases) almost always results in problems during implementation.

```
┌──────────────────────────────────────────────────────────────────┐
│                     RFC LIFECYCLE                                │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. DRAFT                                                        │
│     ├── Write initial proposal                                   │
│     ├── Share with 1-2 trusted reviewers                         │
│     └── Iterate before formal proposal                           │
│                                                                  │
│  2. PROPOSED                                                     │
│     ├── Share with stakeholders                                  │
│     ├── Open for comments                                        │
│     └── Typically 1-2 week comment period                        │
│                                                                  │
│  3. DISCUSSION                                                   │
│     ├── Address comments and concerns                            │
│     ├── Update RFC based on feedback                             │
│     ├── Schedule sync meetings if needed                         │
│     └── Build consensus                                          │
│                                                                  │
│  4. DECISION                                                     │
│     ├── Accepted: Proceed to implementation                      │
│     ├── Rejected: Document reasoning                             │
│     └── Deferred: Revisit later with conditions                  │
│                                                                  │
│  5. IMPLEMENTATION (if accepted)                                 │
│     ├── Create implementation plan                               │
│     ├── Link to RFC in code/PRs                                  │
│     └── Update RFC status as complete                            │
│                                                                  │
│  6. SUPERSEDED (eventually)                                      │
│     ├── New RFC replaces this one                                │
│     └── Link to new RFC                                          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### RFC Template

Having a consistent template ensures that every RFC covers the essential information that reviewers need to make a decision. The template below is a starting point that you can adapt to your organization's needs. The key sections - Summary, Motivation, Proposal, Alternatives Considered, and Trade-offs - appear in virtually every successful RFC format across the industry. Do not skip any of these sections, even if the answer seems obvious to you, because what is obvious to the author is rarely obvious to the reader.

````markdown
# RFC-XXXX: [Title]

**Status**: Draft | Proposed | Accepted | Rejected | Superseded
**Author**: [Name]
**Created**: [Date]
**Last Updated**: [Date]

## Summary

One paragraph explaining the proposal. What are we doing and why?

## Motivation

Why is this change needed? What problem does it solve?

- What is the current situation?
- What are the pain points?
- Who is affected?
- What happens if we do nothing?

## Proposal

### Overview

High-level description of the proposed solution.

### Detailed Design

Technical details of the implementation.

```go
// Code examples where helpful
type ProposedAPI struct {
    // ...
}
```

### API Changes (if applicable)

What APIs will change? Show before/after.

### Data Model Changes (if applicable)

What schema changes are needed?

### Migration Plan

How do we get from current state to proposed state?

## Alternatives Considered

### Alternative 1: [Name]

Description of alternative approach.

**Pros**:
- ...

**Cons**:
- ...

**Reason not chosen**: ...

### Alternative 2: [Name]

...

## Trade-offs and Risks

| Trade-off | Impact | Mitigation |
|-----------|--------|------------|
| ... | ... | ... |

## Open Questions

- [ ] Question 1?
- [ ] Question 2?

## Timeline

| Phase | Duration | Description |
|-------|----------|-------------|
| Phase 1 | 2 weeks | ... |
| Phase 2 | 4 weeks | ... |

## Success Metrics

How will we know if this is successful?

## References

- [Link to related doc 1]
- [Link to related doc 2]
````

### Junior → FAANG: The RFC Lifecycle as Interview Story Skeleton

Every behavioral interview story about a technical decision you drove should follow the RFC lifecycle implicitly. You identified a problem (Ideation), you researched and drafted a proposal (Draft), you got early informal feedback (Informal Review), you wrote it up formally (Written RFC), you managed the discussion period (Discussion), and you closed it with a decision (Decision). Engineers who structure their behavioral stories this way demonstrate process maturity that impresses FAANG interviewers.

The template in this section is immediately useful for interview preparation: write one RFC using the template for a decision you made in the past 12 months, even if you did not write an RFC at the time. The writing exercise forces you to articulate the problem statement clearly, list the alternatives you actually considered, and name the success metrics you were implicitly using. The result is both better interview preparation and a reusable reference for future RFCs.

Pay specific attention to the "Alternatives Considered" section. This is where FAANG interviewers catch shallow thinking: if you only list one alternative and it is obviously inferior to your proposal, you did not actually reason through the decision space. A strong alternatives section shows you genuinely considered other approaches and can articulate why they were rejected on specific criteria.

### Senior @ FAANG: RFC Process as Organizational Decision-Making Infrastructure

At L6 and above, the RFC process is an organizational investment, not just a writing practice. Teams that have a working RFC process make better decisions faster than teams that debate without a structure, because the format forces the author to define the problem, consider alternatives, and articulate tradeoffs before presenting to a group.

The governance layer of an RFC process includes: a definition of what requires an RFC versus what can be decided in a meeting, a designated review panel or rotation for larger proposals, an archive of past RFCs that is searchable and maintained, and a process for reopening decisions when the underlying assumptions change significantly. Staff engineers who design these governance structures are doing organizational architecture work.

RFC processes also have a consensus-building function that extends beyond the document itself. The informal socialization step, described in the lifecycle as gathering feedback before the formal RFC is submitted, is often more important than the formal review. Staff engineers who understand this build informal networks of technical opinion-shapers and bring their key concerns into the RFC early, so the formal review period is a confirmation rather than a discovery. This is not political manipulation. It is efficient decision-making that respects reviewers' time by not surprising them with known objections in the formal period.

At the maturity model level, organizations with healthy RFC processes have shorter decision-making cycles, lower rates of architectural regret (decisions that are reversed within 12 months), and better onboarding experiences for new engineers (who can understand system history through the RFC archive). These outcomes are measurable, and staff engineers who can point to improvements in these metrics after introducing or improving an RFC process have a concrete impact story.

---
