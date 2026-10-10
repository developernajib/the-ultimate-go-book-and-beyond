## 84.2 Leading Without Authority

### Building Influence

Influence is the currency of technical leadership. Unlike managers who can assign work directly, technical leaders must earn the ability to shape decisions through five distinct sources of power. Each source can be deliberately cultivated over time. The strongest technical leaders invest in all five, because relying on just one (such as expertise alone) limits your effectiveness when you need to drive change across teams with different priorities.

```
┌──────────────────────────────────────────────────────────────────┐
│                  SOURCES OF INFLUENCE                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. EXPERTISE POWER                                              │
│     ├── Deep technical knowledge                                 │
│     ├── Track record of solving hard problems                    │
│     ├── Recognized subject matter expert                         │
│     └── Build: Study, practice, share knowledge                  │
│                                                                  │
│  2. RELATIONSHIP POWER                                           │
│     ├── Trust built over time                                    │
│     ├── History of collaboration                                 │
│     ├── Known for being helpful                                  │
│     └── Build: Help others, be reliable, follow through          │
│                                                                  │
│  3. INFORMATION POWER                                            │
│     ├── Access to relevant data                                  │
│     ├── Understanding of context                                 │
│     ├── Knowledge of what's happening                            │
│     └── Build: Stay connected, attend meetings, ask questions    │
│                                                                  │
│  4. NETWORK POWER                                                │
│     ├── Connections across teams                                 │
│     ├── Know who to go to for what                               │
│     ├── Can bring right people together                          │
│     └── Build: Coffee chats, cross-team projects, visibility     │
│                                                                  │
│  5. COMMUNICATION POWER                                          │
│     ├── Clear, persuasive communication                          │
│     ├── Good listener                                            │
│     ├── Effective technical writing                              │
│     └── Build: Practice writing, seek feedback, iterate          │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Influencing Without Authority - Framework

Proposing a change that affects other teams requires a structured approach. You cannot simply announce what you think is best and expect people to follow. Instead, you need to map the affected stakeholders, build a compelling case backed by data, and engage strategically by winning over allies before making a formal proposal. The following Go-style framework illustrates the key components of an influence campaign.

```go
// Influence framework in practice

type InfluenceApproach struct {
    // 1. Understand the landscape
    Stakeholders     []Person
    CurrentState     SystemState
    DesiredState     SystemState
    Blockers         []Blocker

    // 2. Build your case
    Data             []Evidence
    BenefitsToOthers map[Person][]Benefit
    Risks            []Risk
    Mitigations      []Mitigation

    // 3. Engage strategically
    Allies           []Person
    Skeptics         []Person
    Approach         ApproachType
}

// Example: Proposing a new architecture
func ProposeNewArchitecture() {
    // 1. Do your homework
    // - Understand current pain points
    // - Research solutions
    // - Talk to stakeholders informally

    // 2. Write RFC/Design Doc
    // - Clear problem statement
    // - Proposed solution with alternatives
    // - Trade-offs and risks
    // - Migration path

    // 3. Build coalition
    // - Share draft with allies first
    // - Incorporate feedback
    // - Address concerns before public proposal

    // 4. Formal proposal
    // - Present in architecture review
    // - Be open to feedback
    // - Seek commitment, not just agreement

    // 5. Follow through
    // - Lead implementation
    // - Measure results
    // - Share wins
}
```

### Practical Influence Tactics

The difference between a proposal that gets adopted and one that gets ignored usually comes down to preparation. A weak approach relies on opinion, while a strong approach relies on data, prototypes, and addressing concerns before they are raised. The following example shows how to turn a vague idea ("we should use a new testing framework") into a concrete, well-supported proposal that people can say yes to.

```
SITUATION: You want to introduce a new testing framework.

WEAK APPROACH:
"We should use X because it's better."
- No data, no understanding of concerns
- Dismissive of alternatives
- No migration plan

STRONG APPROACH:

1. RESEARCH:
   - Current testing pain points (survey team)
   - Time spent on test maintenance
   - Coverage gaps
   - What other teams use

2. BUILD CASE:
   - "We spend 20% of sprint time fixing flaky tests"
   - "Framework X addresses flaky tests with built-in retry and isolation"
   - "Company Y and Z use this with success"
   - "Here's a prototype I built"

3. ADDRESS CONCERNS:
   - "Migration will take 3 sprints, not blocking feature work"
   - "I'll handle training and documentation"
   - "We can run both frameworks during transition"

4. GET BUY-IN:
   - "Sarah and Mike have reviewed and support this"
   - "I'd like to propose a pilot on our next feature"
   - "Can we commit to evaluating after 4 weeks?"

5. FOLLOW THROUGH:
   - Run pilot, measure results
   - Share findings transparently
   - Iterate based on feedback
```

### Junior → FAANG: Building Credibility Before You Have a Title

Influence without authority is a learnable skill, but it requires deliberate practice before your first leadership role. The five sources of influence described in this section (expertise, relationships, track record, communication, and reliability) are all things you can develop as an individual contributor.

The most actionable investment for a pre-FAANG candidate: become the engineer on your team who writes the best design docs. Consistent, clear written communication builds credibility faster than almost anything else because it is visible, referenceable, and scales. Every doc you write is a proof point that you can think through a problem systematically and communicate it to others.

In FAANG interviews, the "leading without authority" behavioral question usually appears in the form: "Tell me about a time you changed someone's mind on a technical decision." Prepare a story where the other person initially had a different view, where your approach was based on evidence and reasoning rather than seniority, and where the outcome was measurable. Bonus points if you can articulate what you would do differently.

### Senior @ FAANG: Influence at Organizational Scale

At L6 and above, leading without authority is not occasional, it is the primary mode of operation. You are influencing teams you do not manage, architects you cannot direct, and VPs who have their own priorities. The five sources of influence from this section are now operating at organizational scale.

The most powerful lever at this level is track record, specifically, predictive credibility. If you have consistently identified the problems that became critical 6 to 12 months later, people listen to your concerns proactively. Building this reputation requires doing the unglamorous work of writing down your predictions, sharing them with leadership, and following up after the outcome becomes clear. This is different from being right in hindsight. It requires the discipline to put your assessment on record before the outcome is known.

Governance intersects heavily with authority-free leadership. At FAANG, there are many decisions where no single engineer has formal authority but a decision must still be made. The engineer who can hold this space effectively: write the options down clearly, facilitate a real discussion, surface the disagreement to the right level if needed, and then execute the decision with genuine commitment regardless of which option was chosen, is operating at principal level. The ability to disagree and commit is explicitly listed in Amazon's Leadership Principles because it is genuinely rare and genuinely valuable. Build and demonstrate it consistently.

---
