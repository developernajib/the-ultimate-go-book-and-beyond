## 84.3 Making Technical Decisions

### Decision-Making Framework

Every technical decision follows a predictable lifecycle, from understanding the problem to executing and learning from the outcome. Having an explicit framework prevents common mistakes like jumping to solutions before understanding constraints, or making decisions without documenting the reasoning. This six-step process ensures that decisions are thorough, well-communicated, and reviewable by others in the future.

```
┌──────────────────────────────────────────────────────────────────┐
│               TECHNICAL DECISION FRAMEWORK                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. FRAME THE PROBLEM                                            │
│     ├── What problem are we solving?                             │
│     ├── Who is affected?                                         │
│     ├── What are the constraints?                                │
│     └── What does success look like?                             │
│                                                                  │
│  2. GATHER OPTIONS                                               │
│     ├── What are the alternatives?                               │
│     ├── What are others doing?                                   │
│     ├── What have we tried before?                               │
│     └── What would we do if we had unlimited resources?          │
│                                                                  │
│  3. EVALUATE TRADE-OFFS                                          │
│     ├── What are the pros/cons of each?                          │
│     ├── What are the short-term vs long-term implications?       │
│     ├── What's reversible vs irreversible?                       │
│     └── What's the cost of being wrong?                          │
│                                                                  │
│  4. DECIDE                                                       │
│     ├── Use data where available                                 │
│     ├── Apply judgment where data is lacking                     │
│     ├── Document the reasoning                                   │
│     └── Commit to the decision                                   │
│                                                                  │
│  5. COMMUNICATE                                                  │
│     ├── Share the decision and reasoning                         │
│     ├── Address concerns                                         │
│     ├── Get commitment, not just agreement                       │
│     └── Set review points                                        │
│                                                                  │
│  6. EXECUTE AND LEARN                                            │
│     ├── Monitor the results                                      │
│     ├── Be willing to change course                              │
│     └── Document learnings for next time                         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Types of Technical Decisions

Not all decisions deserve the same level of analysis. Amazon popularized the concept of "one-way doors" (irreversible decisions) versus "two-way doors" (easily reversible decisions). Understanding this distinction is critical because it tells you how much time and rigor to invest. Spending three weeks analyzing a two-way door wastes time, while rushing through a one-way door can create problems that persist for years.

```
ONE-WAY DOOR (Irreversible):
├── Major architecture changes
├── Technology migrations
├── API contracts (breaking changes)
├── Data model fundamentals
└── Approach: Careful analysis, broad input, documentation

TWO-WAY DOOR (Reversible):
├── Internal implementation details
├── Tool choices
├── Process experiments
├── Feature flags
└── Approach: Bias for action, experiment, iterate

RECOGNITION:
Ask: "If this is wrong, how hard is it to fix?"
- Hard/expensive to fix → One-way door → Be careful
- Easy to reverse → Two-way door → Move fast
```

### Decision Documentation Template (ADR)

An Architecture Decision Record (ADR) is a short document that captures a single architectural decision along with its context and consequences. ADRs are one of the most powerful tools a technical leader can introduce, because they create a searchable history of why decisions were made. When a new team member asks "why do we use PostgreSQL instead of MongoDB?", the answer lives in an ADR rather than in someone's memory. The following template shows the standard structure used at many top engineering organizations.

```markdown
# ADR-001: Use PostgreSQL for Primary Database

## Status
Accepted

## Context
We need to choose a primary database for our new microservice.
Requirements:
- ACID transactions for financial data
- Complex queries for reporting
- Expected data volume: 100GB initially, 1TB in 3 years
- Team familiarity: 5 engineers with SQL experience

## Decision
We will use PostgreSQL 17.

## Alternatives Considered

### MySQL
- Pros: Familiar to team, proven at scale
- Cons: Window functions less mature, JSON support weaker
- Reason rejected: PostgreSQL better for complex queries

### MongoDB
- Pros: Flexible schema, easy to get started
- Cons: Multi-document ACID transactions available since 4.0 but add latency and complexity compared to native SQL transactions
- Reason rejected: SQL transaction model simpler for our financial data patterns

### DynamoDB
- Pros: Fully managed, infinite scale
- Cons: Expensive at scale, limited query flexibility
- Reason rejected: Cost and query limitations

## Consequences
- Good: Team can use existing SQL skills
- Good: Strong query capabilities for reporting
- Bad: Need to manage infrastructure (or use RDS)
- Bad: Horizontal scaling requires sharding

## Review Date
2026-06-01 - Review performance and scaling decisions

## Participants
- Author: [Name]
- Reviewers: [Names]
```

### Junior → FAANG: Decision-Making as a Demonstrable Skill

One of the clearest signals of engineering maturity in an interview is the ability to articulate how you make decisions, not just what decisions you made. When a FAANG interviewer asks "how did you choose between option A and option B?", the weak answer describes the options. The strong answer describes the framework: what constraints were in play, what the reversibility of each option was, who was consulted, and what the monitoring plan looked like post-decision.

Practice narrating your decision-making process out loud. Record yourself answering the question "walk me through a technically complex decision you made in the last year." Listen back. If your explanation focuses on the technical details of the options rather than the reasoning process, that is what to fix. The six-step framework in this section is a solid scaffold for structuring those answers.

One entry-level gap to address: the tendency to treat "the technically best option" as automatically the right decision. FAANG interviewers are looking for engineers who understand that the right decision depends on context: team size, timeline, reversibility, organizational risk tolerance, and business priorities. Show that you reason about all of these, not just the technical quality of the solution.

### Senior @ FAANG: Decision Governance and Institutional Memory

At senior levels, decision-making quality is measured not just by outcomes but by the quality of the decision-making process and the institutional memory it creates. A great technical decision made with no documentation leaves the organization dependent on the people who were in the room. A good decision made with thorough ADRs, risk documentation, and monitoring plans creates lasting value regardless of who stays or leaves.

Senior engineers at FAANG are expected to design decision-making processes, not just use them. This means: defining which categories of decision require RFC review vs which can be made by a single engineer with a written rationale, establishing the rollback criteria before a change is deployed, and creating the feedback loop that revisits significant decisions at 3, 6, and 12 month intervals to evaluate whether the rationale still holds.

The most common failure mode at L6 is making a decision that was correct at the time but never revisited as context changed. An architecture chosen when the team had five engineers may be actively harmful when the team has fifty. The staff engineer who builds a decision review calendar, periodically surfacing past decisions for relevance evaluation, creates a form of institutional hygiene that most organizations lack. This is the kind of proactive governance work that distinguishes L7 candidates from L6 candidates in bar-raiser rounds.

---
