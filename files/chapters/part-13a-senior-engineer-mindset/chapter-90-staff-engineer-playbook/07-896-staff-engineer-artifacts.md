## 90.6 Staff Engineer Artifacts

### What to Produce

At staff level, your primary work product shifts from code to artifacts that enable others to make better decisions and build better systems. These artifacts include strategy documents, design specifications, operational improvements, and developer experience tools. The diagram below categorizes the types of output expected from staff engineers, and while you will not produce all of them every quarter, you should be consistently creating artifacts across several of these categories.

```
┌──────────────────────────────────────────────────────────────────┐
│              STAFF ENGINEER OUTPUT                               │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  STRATEGIC DOCUMENTS                                             │
│  ├── Technical vision (1-3 year)                                 │
│  ├── Architecture RFCs                                           │
│  ├── Technology recommendations                                  │
│  └── Post-mortems and retrospectives                             │
│                                                                  │
│  DESIGN ARTIFACTS                                                │
│  ├── System design documents                                     │
│  ├── API specifications                                          │
│  ├── Architecture diagrams                                       │
│  └── ADRs (Architecture Decision Records)                        │
│                                                                  │
│  OPERATIONAL IMPROVEMENTS                                        │
│  ├── Runbooks and playbooks                                      │
│  ├── Monitoring dashboards                                       │
│  ├── Incident response procedures                                │
│  └── On-call documentation                                       │
│                                                                  │
│  DEVELOPER EXPERIENCE                                            │
│  ├── Developer guides                                            │
│  ├── Template repositories                                       │
│  ├── Internal tools and scripts                                  │
│  └── Onboarding documentation                                    │
│                                                                  │
│  CODE                                                            │
│  ├── Core libraries and frameworks                               │
│  ├── Reference implementations                                   │
│  ├── Critical path features                                      │
│  └── Technical debt reduction                                    │
│                                                                  │
│  KNOWLEDGE SHARING                                               │
│  ├── Tech talks and presentations                                │
│  ├── Blog posts (internal and external)                          │
│  ├── Training materials                                          │
│  └── Mentorship documentation                                    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Technical Vision Template

A technical vision document is one of the most important artifacts a staff engineer can produce because it gives the entire engineering organization a shared understanding of where you are heading and why. Writing a compelling vision requires you to articulate the current state honestly, paint a clear picture of the desired future state, and lay out a credible roadmap for getting there. The template below provides a starting structure that you should customize for your organization's culture and the specific domain you are addressing.

```markdown
# Technical Vision: [Area/Domain]

**Author**: [Name]
**Date**: [Date]
**Timeframe**: [1-3 years]

## Executive Summary

One paragraph: Where we are, where we're going, why it matters.

## Current State

### What We Have
- Description of current systems
- Current architecture diagram
- Known limitations

### Pain Points
- Scalability issues
- Developer experience problems
- Operational challenges

## Future State

### Vision
Where we want to be in [timeframe].

### Target Architecture
[Diagram of future state]

### Key Improvements
- Improvement 1 and its impact
- Improvement 2 and its impact

## Strategic Themes

### Theme 1: [Name]
What we'll focus on and why.

### Theme 2: [Name]
...

## Roadmap

### Phase 1: Foundation (Q1-Q2)
- Key initiatives
- Expected outcomes

### Phase 2: Scale (Q3-Q4)
- Key initiatives
- Expected outcomes

### Phase 3: Optimization (Year 2)
- Key initiatives
- Expected outcomes

## Success Metrics

How we'll know we succeeded.

| Metric | Current | Target | Timeline |
|--------|---------|--------|----------|
| ... | ... | ... | ... |

## Risks and Dependencies

| Risk | Mitigation |
|------|------------|
| ... | ... |

## Open Questions

Things we need to figure out.
```

### Junior → FAANG: Start Writing Artifacts Now

Artifacts are the mechanism through which staff engineers prove they were right. Without them, engineering judgment evaporates: decisions get re-litigated, credit gets diffused, and the reasoning behind past choices becomes archaeology. As a junior engineer, building the habit of documenting your thinking is the most direct investment you can make in your future staff-level effectiveness.

Start small. After any non-trivial technical decision, write a paragraph: what was the problem, what options were considered, what was chosen and why. Store it where your team can find it. Over time, those paragraphs compound into a body of work that shows how you think. When you interview for staff, those documents are evidence.

Design docs do not have to be long to be valuable. A one-page proposal with a clear problem statement, two or three options, and a recommendation with tradeoffs is more useful than a ten-page document that exhausts the reader before reaching the recommendation. Practice brevity. FAANG interviewers reviewing writing samples are evaluating judgment as much as knowledge.

### Senior @ FAANG: Artifacts as Organizational Memory and Governance

At FAANG, staff engineer artifacts serve a function beyond individual decision-making: they are the organization's memory of why its architecture looks the way it does. Systems designed for one scale get inherited by teams at ten times that scale who do not know why certain choices were made. A well-maintained artifact library prevents costly re-litigation and protects against the failure mode of reintroducing a previously rejected solution because nobody remembered it had been tried.

The most mature engineering orgs at FAANG treat artifacts as first-class deliverables with review, approval, and archival processes equivalent to code. An RFC that was approved two years ago but never updated to reflect changed circumstances is not neutral: it is actively misleading. Staff engineers are responsible for keeping their artifacts current or explicitly marking them as superseded. Stale artifacts are a form of technical debt in the documentation layer.

Technical strategy documents deserve particular attention. A strategy doc that has not been tested against reality within six months of publication should be suspected. The best staff engineers at Amazon and Google publish a strategy, then actively gather feedback from teams implementing against it, and issue explicit revisions when the strategy turns out to be wrong. The willingness to publish a revision that contradicts an earlier document, with clear reasoning, is a signal of intellectual honesty that earns credibility faster than any sequence of decisions that happened to be correct.

Governance structures around artifacts become essential at scale. Who has the authority to approve an ADR? Who needs to be consulted before a design doc is finalized? What happens when two design docs from different teams propose incompatible approaches? Staff engineers who help establish and maintain those governance structures are doing org-level work that compounds in value as the organization grows. Engineers who write excellent individual artifacts but ignore the governance layer are optimizing locally at the cost of organizational coherence.

---
