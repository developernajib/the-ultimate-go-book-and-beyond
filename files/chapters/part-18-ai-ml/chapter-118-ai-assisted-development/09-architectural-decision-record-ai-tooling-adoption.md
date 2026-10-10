## Architectural Decision Record: AI Tooling Adoption in Engineering

A formal Architecture Decision Record (ADR) defining team-wide policies, security boundaries, and code review criteria for adopting generative AI coding assistants.

---

### ADR Section: Status accepted


```text
## Status: Accepted
```

### Junior → FAANG: ADR Status Fields as Engineering Decision Discipline

The Status field in an ADR (Architecture Decision Record) seems trivial but carries important information. "Accepted" means the decision is current policy and engineers must follow it. "Proposed" means it is under discussion and engineers should contribute to the discussion. "Deprecated" means the decision has been superseded and engineers should follow the replacement ADR. "Superseded by ADR-XXX" means there is a newer decision that applies. Knowing how to read ADR status, and how to update it when decisions change, is part of engineering documentation literacy that FAANG interviewers now expect.

For AI-assisted development, the ADR status can be maintained with AI assistance: ask the AI to review an existing ADR and update the status field based on a description of what changed, or ask it to generate a "Superseded by" note and a link to the new ADR. The AI's role is documentation maintenance, but the engineering judgment about when a decision is superseded and what the new decision is remains the engineer's responsibility.

### Senior @ FAANG: ADR Lifecycle Governance

At senior level, ADR status is a governance artifact. An organization with 50 ADRs where 30 are "Accepted" but were written 3 years ago, 10 are "Proposed" and have been stalled for 6 months, and 10 are "Deprecated" but engineers still follow them because they were not informed of the deprecation has an ADR system that produces false confidence rather than useful guidance. Senior engineers are responsible for reviewing the ADR inventory periodically, updating status fields to reflect current reality, identifying decisions that need to be revisited, and communicating status changes to the team. Without this governance, the ADR system becomes a historical archive rather than a living decision record.


---

### ADR Section: Context


```text
## Context
[describe the situation]
```

### Junior → FAANG: The Context Section as Problem Framing

The Context section of an ADR is the hardest section to write well because it requires articulating the problem without implying the solution. "We need to choose a database" is not a context statement. It is a vague requirement. "Our service processes 5,000 write operations per second with a 99.9% uptime requirement, and our team has operational expertise in relational databases but not NoSQL" is a context statement. It describes the situation, the constraints, and the relevant prior knowledge that make the decision necessary and bounded.

For FAANG interviews, the ability to frame a problem clearly in context is assessed in system design rounds. "What is the context for this design?" is often the first question. Practice writing context statements for the systems you have worked on: what was the situation, what were the constraints, and what made the problem non-trivial? This practice develops the problem framing skill that is one of the clearest differentiators between L4 and L5 engineers in FAANG calibration.

### Senior @ FAANG: Context Quality as ADR Utility Predictor

At senior level, the quality of an ADR's Context section is the best predictor of the ADR's long-term utility. ADRs with thin context sections ("we decided to use X") cannot be evaluated or updated years later because the circumstances that made X the right choice are not recorded. ADRs with rich context sections ("given Y constraints and Z requirements, and given that our team had A experience level with B technology") can be evaluated years later: if the constraints and requirements still apply, the decision probably still holds. If they have changed, the ADR signals that the decision should be revisited. Teaching engineers to write rich context sections, and reviewing context quality in ADR reviews, is a staff-level engineering culture contribution.


---

### ADR Section: Decision


```text
## Decision
[what we decided]
```

### Junior → FAANG: Decision Clarity as Engineering Communication

The Decision section of an ADR should state what was decided in a single, unambiguous sentence, followed by a brief rationale. "We will use PostgreSQL with raw SQL via pgx/v5" is a decision statement. "We considered PostgreSQL, MySQL, and MongoDB. PostgreSQL was selected because the team has operational expertise with it, it meets our consistency requirements, and pgx/v5 provides the performance we need without an ORM abstraction layer." This is a decision statement with rationale. The rationale connects the decision to the context, showing that the decision follows from the constraints rather than being arbitrary.

For FAANG interviews, the Decision section teaches you to be direct about conclusions rather than hedging. Engineers who cannot state a clear technical decision (because they want to leave all options open) are perceived as indecisive at FAANG calibration. Practice stating decisions clearly: "Given the constraints, I would use X because Y and Z. The trade-off is A, which we accept because B." This directness, backed by reasoning, is the communication pattern that L5 and above FAANG engineers are expected to use consistently.

### Senior @ FAANG: Decision Authority and Organizational Decision-Making

At senior level, the Decision section is also where decision authority is recorded. An ADR that says "we decided X" without naming who made the decision is ambiguous: was this a team consensus, a tech lead decision, or a directive from engineering leadership? Recording decision authority (e.g., "decided by the platform team with input from service owners") creates accountability and clarifies who owns reversing the decision if circumstances change. Senior engineers define the decision authority model for their area: which decisions require team consensus, which can be made by the tech lead, and which require engineering director approval.


---

### ADR Section: Consequences


```text
## Consequences
### Positive
[benefits]
### Negative
[trade-offs]
```

### Junior → FAANG: Consequences as Trade-off Analysis Practice

The Consequences section is where the engineering judgment in a decision is most visible. An engineer who lists only positive consequences did not think critically about the decision. An engineer who lists only negative consequences did not understand why the decision was made. The correct structure is balanced: list the genuine benefits and the genuine costs, with enough specificity that a reader can evaluate whether the trade-off is appropriate for the context. "Positive: no ORM overhead, explicit query control, easy performance tuning. Negative: more verbose code, no automatic schema migrations, raw SQL requires more review discipline."

For FAANG interviews, trade-off analysis is the most assessed skill in system design rounds. Every design choice has consequences. Practice the habit of immediately asking "what are the negative consequences of this choice?" for every design decision you make. Interviewers who ask "what are the trade-offs?" are specifically looking for whether you have thought beyond the happy path. Engineers who can name specific negative consequences and explain why they are acceptable given the context demonstrate the senior-level judgment that FAANG looks for in promotion candidates.

### Senior @ FAANG: Consequences as Risk Registry

At senior level, the negative consequences in ADRs form a risk registry for the organization's technical decisions. "We use raw SQL, which requires more review discipline" is a risk that should appear in the code review checklist. "We use PostgreSQL, which requires operational expertise our team currently has but may not always have" is a hiring and knowledge management risk. Treating the negative consequences section of ADRs as a living risk list, reviewed periodically and updated as circumstances change, is a systematic approach to technical risk management that staff engineers implement as part of organizational engineering governance.


---

### ADR Section: Alternatives considered


```text
## Alternatives Considered
[what we rejected and why]
```

### Debugging Workflow

**AI-assisted root cause analysis**:

During a production incident, AI is a fast generator of hypotheses. It is not a first responder, and it does not get to touch anything. Redact logs before they leave your machine, and see Section 118.6 for the full rules:

```bash
claude -p "I have a production incident. Here is the error:
[paste error]
Here are the relevant logs, redacted:
[paste logs]
Here is the code path that was executing:
[paste relevant code]

What are the most likely root causes, ranked? For each, tell me what
evidence would confirm or rule it out."
```
**Reading unfamiliar codebases**:

```bash
# Use Claude Code to onboard to a new service
claude "Give me a tour of this codebase.
# (run from the repo root, so it can read the code rather than guess) I'm joining the team and need to understand:
1. What this service does
2. The main data flows
3. Key design decisions and why they were made
4. Potential problems or technical debt
5. Where to start reading if I'm implementing a new feature"
```
**Explaining complex code**:

```bash
claude -p "Explain this code in plain English. Assume I'm a mid-level engineer
who knows Go but is unfamiliar with this codebase:
[paste complex code]

Then explain why each design decision was made."
```
### Code Review with AI

**Pre-PR AI review workflow**:

```bash
# Before opening a PR, run AI review (-p reads the piped diff and exits)
git diff main...HEAD | claude -p "Review this diff for:
1. Security vulnerabilities
2. Concurrency bugs
3. Missing error handling
4. Go anti-patterns
5. Missing tests for new code
6. Documentation gaps

Be specific. Cite the file and line number.
Distinguish between must-fix (blocks PR) and should-fix (nice to have).
If you are unsure whether something is a real problem, say so."
```

This supplements human review. It does not replace it, and a clean result from it is not evidence that the diff is correct. See the two lists below for where the line falls.
**What AI catches reliably in code review**:
- Style and formatting issues
- Missing godoc comments
- Obvious null/nil dereferences
- Duplicate code
- Unused variables
- Missing error checks (when obvious)
- Simple security patterns (SQL concatenation, weak crypto)

**What AI misses in code review**:
- Business logic correctness (it doesn't know your domain)
- Whether this change is the right solution to the actual problem
- Architecture-level violations (it may not have full context)
- Performance impact without profiling data
- Complex race conditions in non-trivial concurrent code
- Whether tests actually test the right behavior

---

### Junior → FAANG: Alternatives Analysis as Design Depth Signal

The Alternatives Considered section and the debugging workflow content in this file cover two distinct skills: structured decision-making through alternative analysis, and AI-assisted debugging as a productivity multiplier. Both are assessed in FAANG interviews. For alternatives analysis, the key discipline is stating why each alternative was rejected, not just listing what was considered. "We considered GORM but rejected it because of N+1 query risk and our team's preference for explicit SQL" is stronger than "we considered GORM." The rejection reason demonstrates that you evaluated the alternative seriously rather than dismissing it without analysis.

The AI-assisted debugging workflow (paste error, paste logs, paste code path, ask for root cause analysis) is a skill that significantly accelerates incident response. Practice this workflow on past debugging sessions: take a bug you solved manually and work through it with AI assistance, comparing the AI's diagnosis to what you found. This practice develops intuition for which debugging context is necessary for the AI to produce useful diagnoses (the full error including stack trace, the relevant code path, the logs from the time window around the incident, any recent code changes) versus what is noise. Building this intuition makes you faster at preparing incident context for AI analysis during real incidents.

The code review section distinguishes what AI catches reliably from what it misses. The "catches" list (style issues, missing nil checks, simple SQL injection patterns) are things you can automate in CI. The "misses" list (business logic correctness, architecture violations, complex race conditions) are things that require the human reviewer's domain knowledge. For FAANG code review interviews, be prepared to distinguish between feedback that is mechanical (can be given by a linter or AI) and feedback that requires judgment (requires knowledge of the business domain, the system architecture, or the team's conventions).

### Senior @ FAANG: Alternatives Documentation as Organizational Decision Memory

At senior level, the Alternatives Considered section is the most valuable part of an ADR for future readers because it prevents re-litigating decisions that were already made. "We considered MongoDB but rejected it because of our team's lack of operational expertise and our requirement for ACID transactions" is organizational memory: six months later when a new engineer proposes MongoDB, the ADR provides the historical context for why it was not chosen, without requiring the original decision-makers to relitigate it in a meeting.

The debugging workflow section, viewed from an organizational perspective, is a team capability that should be documented and shared. Engineers who have developed effective AI-assisted debugging workflows should document them in the team runbook: which debugging scenarios benefit most from AI assistance, what context to include in the prompt, what to do when the AI's diagnosis is incorrect (provide more context, try a different framing, fall back to manual analysis). This documentation prevents each engineer from discovering the effective debugging workflows independently and accelerates new team members' productivity.

The code review limitations list is a risk communication artifact for engineering leadership discussions about AI tool adoption. When leadership asks "can we use AI to reduce code review burden?", the answer is: AI can reliably cover the mechanical checklist items (formatting, obvious nil dereferences, simple security patterns) and reduce the time reviewers spend on these items. But it cannot replace human judgment for business logic correctness, architecture violations, and complex concurrency bugs, which are the highest-risk categories of code review. An honest capability assessment, backed by this specific limitations list, is more persuasive than either overpromising (AI will replace code review) or underpromising (AI cannot help with code review).
