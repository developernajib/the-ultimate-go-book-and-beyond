## 87.6 Scaling Code Reviews

### Challenges at Scale

The code review process that works well for a five-person team often breaks down completely at fifty or a hundred engineers. As teams grow, you lose the shared context that allows everyone to review everything, and bottlenecks form around domain experts. Understanding how challenges shift at different team sizes helps you anticipate problems and put the right processes in place before they become painful.

```
SMALL TEAM (5-10 engineers):
- Everyone reviews everything
- High context, low overhead
- Bottleneck: key reviewers

MEDIUM TEAM (20-50 engineers):
- Need review rotation
- Context fragmentation
- Bottleneck: domain experts

LARGE ORG (100+ engineers):
- Formal ownership (CODEOWNERS)
- Review SLOs needed
- Bottleneck: cross-team reviews
```

### Scaling Strategies

Scaling code reviews requires a combination of automation, clear ownership, and process discipline. The goal is to ensure that every PR gets a timely, thoughtful review from someone with the right context, without any single person becoming a bottleneck. These strategies work together: CODEOWNERS ensures the right people are assigned, rotation prevents burnout, and automated checks free reviewers to focus on substance rather than style.

```
┌──────────────────────────────────────────────────────────────────┐
│                   SCALING STRATEGIES                             │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. CODEOWNERS                                                   │
│     Define ownership by directory/file pattern                   │
│     Auto-assign reviewers                                        │
│     Ensure expert review                                         │
│                                                                  │
│     # CODEOWNERS file                                            │
│     /internal/payments/  @payments-team                          │
│     /internal/auth/      @security-team @auth-team               │
│     *.go                 @go-readability                         │
│                                                                  │
│  2. REVIEW ROTATION                                              │
│     Round-robin assignment                                       │
│     Prevents bottlenecks                                         │
│     Spreads knowledge                                            │
│                                                                  │
│  3. TIERED REVIEWS                                               │
│     Junior → Senior for complex changes                          │
│     Any → Readability reviewer for style                         │
│     Mandatory security review for auth code                      │
│                                                                  │
│  4. REVIEW SLOs                                                  │
│     First response within 4 hours                                │
│     Completion within 24 hours                                   │
│     Track and report on metrics                                  │
│                                                                  │
│  5. AUTOMATED CHECKS                                             │
│     Linting, formatting (don't review what bots can)             │
│     Security scanning                                            │
│     Test coverage gates                                          │
│                                                                  │
│  6. PR SIZE LIMITS                                               │
│     Encourage small, focused PRs                                 │
│     Auto-flag large PRs for splitting                            │
│     Target: <400 lines changed                                   │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Review Guidelines Document

A written review guidelines document is essential for any team larger than a handful of engineers. It sets shared expectations for both authors and reviewers, reducing friction and ensuring consistency. The following is a detailed template that covers PR preparation, review priorities, response times, and approval criteria. Adapt it to your team's specific needs and tools.

```markdown
# Code Review Guidelines

## For Authors

### Before Submitting
- [ ] PR description explains what and why
- [ ] Tests added/updated
- [ ] Self-reviewed the diff
- [ ] CI passes
- [ ] PR is reasonably sized (<400 lines)

### PR Description Template

A well-structured PR description front-loads the context reviewers need before they read a single line of diff. Without it, reviewers must reverse-engineer intent from code, which slows the review and increases the chance they miss a logical flaw while focusing on style. The template below enforces the minimum viable context: what changed, why it changed, and how to verify it works. These are the three questions every reviewer silently asks.

```

## What
[Brief description of changes]

## Why
[Link to issue/ticket and context]

## Testing
[How this was tested]

## Rollback
[How to rollback if needed]
```

### When Responding to Feedback
- Respond to all comments
- Use "Done" or explanation
- Don't take feedback personally
- Ask for clarification if unclear

## For Reviewers

### Review Priorities
1. Correctness and bugs
2. Security issues
3. Design and architecture
4. Readability and maintainability
5. Style (if not covered by linter)

### Response Time
- First response: within 4 working hours
- Complete review: within 1 working day
- If busy, communicate delay

### Comment Etiquette
- Be kind and constructive
- Suggest solutions, not just problems
- Mark nitpicks clearly (nit:)
- Acknowledge good code

### Approval Criteria
- Logic is correct
- Tests are adequate
- No security issues
- Readable and maintainable
```

### Junior → FAANG: Demonstrating Scale Awareness Before You Have Scale

FAANG interviews for L5 and above include system design questions that test whether you can think ahead to scale. The same thinking applies to process design. When asked "how would you set up code review for a new team?", a junior-level answer describes what they do today. A senior-level answer anticipates where the bottlenecks will appear as the team grows from 5 to 20 engineers and puts the infrastructure in place before the pain arrives.

Study the CODEOWNERS syntax and review SLO patterns in this section because they are directly referenced in FAANG senior loop system design and process design questions. Candidates who can describe specific tooling and why each tool addresses a specific scaling failure mode demonstrate operational maturity.

The "PR size limits" strategy is an interview test in itself. When a FAANG interviewer asks "what would you do about a team that regularly submits 2,000-line PRs?", the expected answer identifies the root causes (feature branches, fear of partial merges, lack of feature flag infrastructure) and proposes solutions that address the underlying incentives, not just the symptom.

### Senior @ FAANG: Review Infrastructure as Platform Engineering

At L6 and above, code review scaling is a platform engineering problem. The tools, processes, and norms that support review at 100+ engineers require the same investment discipline as internal APIs and developer tooling.

CODEOWNERS files need to be maintained the same way service ownership does. Stale CODEOWNERS entries, pointing to engineers who have left or teams that no longer own the code, produce wrong reviewer assignments that waste time and miss critical review coverage. Staff engineers who treat CODEOWNERS as a living document and build processes to keep it current are investing in review pipeline reliability.

Review SLOs are a governance instrument. Tracking first-response time and total review time as team-level metrics, and reviewing them in engineering effectiveness discussions, creates the accountability structure that keeps review from becoming a bottleneck. Staff engineers who introduce review SLO tracking and then actually hold the team accountable to them, through regular readouts and escalation procedures, are doing engineering management at the process level.

The tiered review system described in this section, different review requirements for different change categories, is an access control model. It defines who has the authority to approve what, under what conditions, and with what documentation. This is organizational governance. Staff engineers who have designed and implemented tiered review systems have done architectural work on the engineering process itself, and that experience belongs in their interview stories for principal and distinguished engineer conversations.

---
