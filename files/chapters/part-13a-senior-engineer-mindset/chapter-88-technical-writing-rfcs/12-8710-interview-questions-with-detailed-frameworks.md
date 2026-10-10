## 88.11 Interview Questions with Detailed Frameworks

### Question 1: "Tell me about an RFC you wrote that had significant opposition. How did you handle it?"

**What Interviewers Are Testing**:
- Conflict resolution and consensus building skills
- Ability to incorporate feedback while maintaining technical vision
- Communication skills under disagreement
- Senior-level influence without authority

**Framework for Answering (STAR+ Method)**:

```
SITUATION (30 seconds):
- What was the RFC about?
- What was the organizational context?
- What was the scale of the proposed change?

TASK (20 seconds):
- What were you trying to achieve?
- Why was this change important?
- What was your role in driving it?

ACTION - THE OPPOSITION (1 minute):
- Who opposed it and why?
- What were their specific concerns?
  • Technical concerns (performance, complexity)
  • Organizational concerns (resources, timing)
  • Strategic concerns (direction, priorities)
- How did you respond?
  • Did you modify the proposal?
  • Did you address concerns explicitly in writing?
  • Did you schedule meetings to discuss?

ACTION - BUILDING CONSENSUS (1 minute):
- How did you find common ground?
- What compromises did you make?
- What did you refuse to compromise on and why?
- How did you document the resolution?

RESULT (30 seconds):
- What was the outcome?
- What did you learn about consensus building?
- How would you approach it differently?
```

**Example Strong Answer**:

"I wrote an RFC proposing we migrate from REST to gRPC for internal service communication. The infrastructure team strongly opposed it - they were concerned about debugging complexity and the learning curve for the organization.

I handled this by first acknowledging their concerns in a written update to the RFC. I added a section specifically titled 'Addressing Infrastructure Concerns' with three mitigations: a debugging proxy tool we'd build, a phased rollout plan starting with one service, and a training curriculum.

I also scheduled a 1:1 with the infrastructure lead to understand what would make them comfortable. Turns out they'd been burned by a previous protobuf migration that went poorly. I proposed we collaborate on success criteria - they would define what 'safe' looked like, and I'd ensure we met those criteria before each phase.

The RFC took three iterations but was approved unanimously. The key learning: opposition often comes from past experiences, not the technical merits. Understanding that history helps you address the real concern."

**What to Avoid**:
- "I pushed through despite objections" (shows poor collaboration)
- "They eventually came around" (doesn't show what YOU did)
- "The opposition was wrong" (shows inability to learn from disagreement)

---

### Question 2: "How do you decide when a technical decision needs an RFC versus just doing it?"

**What Interviewers Are Testing**:
- Judgment about when to seek consensus
- Understanding of organizational decision-making
- Ability to balance speed with alignment
- Senior-level thinking about impact

**Framework for Answering**:

```
┌──────────────────────────────────────────────────────────────────┐
│              RFC DECISION MATRIX                                 │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  HIGH REVERSIBILITY                                              │
│  ┌──────────────────────┬──────────────────────┐                 │
│  │                      │                      │                 │
│  │   JUST DO IT         │   LIGHTWEIGHT RFC    │                 │
│  │                      │                      │                 │
│  │   - Add logging      │   - New library      │                 │
│  │   - Refactor single  │   - Pattern change   │    MANY         │
│  │     module           │     within team      │   TEAMS         │
│  │   - Bug fixes        │   - Shared utility   │  AFFECTED       │
│  │   - Tests            │                      │                 │
│  │                      │                      │                 │
│  ├──────────────────────┼──────────────────────┤                 │
│  │                      │                      │                 │
│  │   DESIGN DOC         │   FULL RFC           │                 │
│  │   (Team Review)      │   (Org Review)       │                 │
│  │                      │                      │                 │
│  │   - New service      │   - API change       │    FEW          │
│  │   - Schema change    │   - Shared infra     │   TEAMS         │
│  │   - Major refactor   │   - New dependency   │  AFFECTED       │
│  │     within team      │   - Migration        │                 │
│  │                      │                      │                 │
│  └──────────────────────┴──────────────────────┘                 │
│  LOW REVERSIBILITY                                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Example Strong Answer**:

"I use a mental framework with two axes: reversibility and blast radius.

**High reversibility, low blast radius** (just do it): Adding a retry loop to one service, refactoring a function, adding tests. I can change it tomorrow if it's wrong.

**High reversibility, high blast radius** (lightweight RFC): Introducing a new library that other teams might adopt. Easy to change but worth a heads-up so others can influence the choice.

**Low reversibility, low blast radius** (team design doc): Schema migration for my team's database. Hard to undo, but only my team is affected. I'll write it up for my team to review.

**Low reversibility, high blast radius** (full RFC): Changing our authentication system, adding a shared service, changing API contracts. These affect others and are hard to undo - worth the investment in consensus.

The key heuristic: 'Would I be embarrassed if someone asked why we didn't get alignment on this?' If yes, write an RFC."

---

### Question 3: "You wrote an RFC that was approved and implemented, but six months later the approach is clearly not working. What do you do?"

**What Interviewers Are Testing**:
- Intellectual honesty and ego management
- Ability to admit and correct mistakes
- Documentation practices for evolving decisions
- Senior-level accountability

**Framework for Answering**:

```
STEP 1: ACKNOWLEDGE AND DIAGNOSE
- What specifically isn't working?
- Was it the decision or the implementation?
- What changed since the original RFC?
- What did we learn that we couldn't have known then?

STEP 2: DOCUMENT THE FAILURE
- Write an "RFC Retrospective" or update
- Include what we tried, what happened, what we learned
- Be explicit: "This approach failed because..."
- No blame, just facts and learning

STEP 3: PROPOSE A PATH FORWARD
- Option A: Sunset RFC, new RFC for new approach
- Option B: Update RFC with "lessons learned" and pivot
- Option C: Double down with modifications (rare)

STEP 4: COMMUNICATE OPENLY
- Share with original stakeholders
- Thank people who raised concerns you dismissed
- Make the learning organizational, not personal
```

**Example Strong Answer**:

"This happened to me with a caching RFC. I proposed we use Redis for session caching, and six months later we were fighting memory bloat and complexity.

First, I wrote an honest retrospective document. I included 'What we got wrong': we underestimated session size growth and overestimated our ability to tune eviction. I made sure not to blame the implementation - I owned that the design didn't account for our growth patterns.

Then I wrote a follow-up RFC proposing we migrate to a cookie-based approach with encrypted JWTs. I explicitly linked it to the original RFC and said 'RFC-123 is being superseded by this proposal based on operational experience.'

The interesting part: one of the original reviewers had raised concerns about memory, and I'd dismissed them. In the retrospective, I acknowledged that: 'Alice raised memory concerns in the original review. She was right, and we should have weighted her operational experience more heavily.'

This was humbling but important. The organization learns from documented failures. And my credibility actually increased because I was willing to publicly own and correct a mistake."

**What to Avoid**:
- Blaming the implementation team
- Pretending the original RFC was fine and 'circumstances changed'
- Quietly replacing the system without documenting why

---

### Question 4: "How do you write for an audience that includes both engineers and non-technical stakeholders?"

**What Interviewers Are Testing**:
- Communication adaptability
- Ability to convey technical concepts simply
- Understanding of different stakeholder needs
- Senior-level organizational awareness

**Framework for Answering**:

```
THE LAYERED DOCUMENT APPROACH:

┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1: EXECUTIVE SUMMARY (Everyone reads)                    │
│  - 3-4 sentences max                                            │
│  - Business impact, not technical details                       │
│  - Timeline and resources needed                                │
│  - Decision being requested                                     │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 2: OVERVIEW (Technical stakeholders read)                │
│  - Problem and solution in 1 page                               │
│  - Key trade-offs and decisions                                 │
│  - Architecture diagram                                         │
│  - Risks and mitigations                                        │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 3: DETAILED DESIGN (Implementers read)                   │
│  - Complete technical specification                             │
│  - API contracts, data models                                   │
│  - Error handling, edge cases                                   │
│  - Migration steps                                              │
├─────────────────────────────────────────────────────────────────┤
│  LAYER 4: APPENDIX (Experts reference)                          │
│  - Benchmarks, calculations                                     │
│  - Alternative analysis details                                 │
│  - Related documents                                            │
│  - Research and references                                      │
└─────────────────────────────────────────────────────────────────┘

Each layer should STAND ALONE for its audience.
```

**Example Strong Answer**:

"I structure documents in layers that different audiences can engage with at different depths.

The executive summary is for everyone - it answers 'What are we doing and why should you care?' in business terms. No jargon. For example: 'We're replacing our payment system to reduce checkout failures by 40% and save $2M annually in failed transaction fees.'

The overview is for technical stakeholders who need to understand the approach without implementing it. This includes engineering managers, architects from other teams, and product managers with technical backgrounds. I use diagrams heavily here - a picture of the architecture often conveys more than paragraphs of text.

The detailed design is for implementers. This is where I go deep on APIs, data models, error handling. I assume the reader knows our stack and can read code.

I also have a trick: I write the executive summary LAST, after I deeply understand the problem. And I test it by asking: 'Would a VP who reads only this paragraph understand what we're doing and why it matters?' If not, I rewrite it.

The key principle: every reader should be able to stop at their layer and have a complete understanding appropriate to their role."

---
