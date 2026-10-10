## 87.4 Handling Disagreements

### The Disagreement Protocol

Disagreements in code reviews are normal and healthy. They often lead to better solutions than either party would have reached alone. However, unresolved disagreements that drag on for days can block progress and damage team relationships. Having a clear protocol for handling disagreements ensures they are resolved quickly and constructively, without anyone feeling steamrolled.

```
┌──────────────────────────────────────────────────────────────────┐
│              HANDLING REVIEW DISAGREEMENTS                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. CLARIFY UNDERSTANDING                                        │
│     "I want to make sure I understand your concern..."           │
│     Often disagreements are misunderstandings                    │
│                                                                  │
│  2. DISTINGUISH OPINION FROM FACT                                │
│     Is this a style preference or a bug?                         │
│     Is there data to support either position?                    │
│                                                                  │
│  3. DISCUSS, DON'T DEBATE                                        │
│     Goal is best outcome, not winning                            │
│     Be open to changing your mind                                │
│                                                                  │
│  4. MOVE TO SYNCHRONOUS COMMUNICATION                            │
│     If back-and-forth continues, talk live                       │
│     Text loses nuance                                            │
│                                                                  │
│  5. TIME-BOX THE DISCUSSION                                      │
│     If unresolved in 10 minutes, escalate                        │
│     Don't block PRs indefinitely                                 │
│                                                                  │
│  6. ESCALATE GRACEFULLY                                          │
│     Bring in a third party                                       │
│     Technical lead or senior engineer                            │
│     Not to "win" but to get perspective                          │
│                                                                  │
│  7. DISAGREE AND COMMIT                                          │
│     If decision made, support it fully                           │
│     Document the decision for future reference                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Example Disagreement Resolution

The following scenario walks through a real-world disagreement about error wrapping, showing how a structured approach leads to a resolution where both parties learn something. Notice how the conversation moves from asynchronous comments to a synchronous call once it becomes clear that text is not conveying enough nuance. The outcome is documented in the PR so future engineers can understand the reasoning.

```
SCENARIO: Reviewer wants extensive error wrapping,
          Author thinks it's over-engineering

ROUND 1 (Comment):
Reviewer: "We should wrap this error with more context"
Author: "I think the original error is clear enough"

ROUND 2 (Escalation signal):
Reviewer: "I've seen debugging issues without context.
          Let's sync briefly - open to hearing your perspective."

ROUND 3 (Sync call, 5 minutes):
- Author explains: "We have distributed tracing, error
  shows up in span context"
- Reviewer learns: Tracing provides context they didn't consider
- Agreement: Wrap at service boundary, not every level

ROUND 4 (Document decision):
Author updates PR description:
"Decision: Wrap errors at service boundary only.
Rationale: Distributed tracing provides intermediate context."

OUTCOME:
- Both learned something
- Decision documented
- No hard feelings
```

### Junior → FAANG: Disagreement Resolution as a Bar-Raising Signal

"Disagree and commit" is an Amazon Leadership Principle that appears explicitly, but the underlying skill is evaluated across all FAANG companies. The ability to voice a technical objection clearly, engage with the counter-argument honestly, and then fully commit to the outcome of the process even when you did not prevail is a senior-level behavior that many technically excellent engineers never develop.

In behavioral interviews, "tell me about a time you disagreed with a technical decision" is specifically testing for this pattern. The weak answer ends with "I ended up being right." The strong answer ends with "I committed fully to the direction we chose, documented the reasoning for future reference, and here is what I learned from how the outcome played out."

The escalation step in the disagreement protocol is particularly important to understand before your first FAANG job. FAANG organizations have explicit escalation paths because without them, disagreements become political rather than technical. Knowing when to escalate, and how to do so in a way that is clearly about the technical question and not about winning, is a judgment skill that distinguishes L5 from L4.

### Senior @ FAANG: Designing Disagreement Resolution Processes for Teams

At L6 and above, the individual-level disagreement protocol becomes a team-level governance question: what is the process by which technical disagreements get resolved, documented, and preserved for future reference?

Teams without a written disagreement resolution process default to whoever is most senior or most persistent, which is neither fair nor technically optimal. Staff engineers who introduce explicit escalation paths, time-boxing conventions, and documentation requirements for resolved disagreements create an environment where disagreements are productive rather than exhausting.

The "disagree and commit" principle has a governance corollary: once a decision is made, the team should be able to reference the written rationale when the decision is later questioned. ADRs serve this purpose explicitly: they capture not just what was decided but what alternatives were considered and why they were rejected. A team that documents its disagreements as ADRs develops institutional memory that prevents the same debates from recurring every six months. Staff engineers who evangelize this practice are doing governance work with compounding returns.

The most challenging disagreement scenario at senior levels is not engineer-versus-engineer but engineer-versus-business-pressure. A product manager wants to ship despite a known technical concern. A deadline is approaching and the reviewer's blocking comment is standing in the way. Staff engineers who have developed clear principles for when to hold the line and when to document the risk and ship anyway, and who can explain that decision framework under interview pressure, are demonstrating exactly the kind of principled judgment that the bar-raiser is looking for.

---
