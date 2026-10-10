## Architectural Decision Record: AI-Generated Code Governance

An organizational Architecture Decision Record defining continuous integration gates, intellectual property safeguards, and automated vulnerability scanning for LLM-assisted pull requests.

---

### ADR Section: Status


```text
## Status
[status]
```

### Junior → FAANG: ADR Status as Engineering Communication Maturity

The Status field in an ADR is often treated as a trivial formality, but it is a professional communication signal. Engineers who maintain ADR status accurately (updating from "Proposed" to "Accepted" when a decision is finalized, adding "Superseded by ADR-XXX" when a decision changes) are demonstrating the documentation discipline that FAANG engineering organizations require for effective asynchronous decision-making. Engineers who leave ADR status stale or ambiguous are creating communication overhead for anyone who later needs to know whether the decision is current policy.

Practice writing at least one ADR for every significant technical decision you make on any project, keeping the status field accurate throughout the decision lifecycle. This habit, built before joining a FAANG company, makes ADR authorship natural rather than effortful in the fast-paced environment where ADRs are most needed.

### Senior @ FAANG: ADR Status Governance as Decision Audit Trail

At senior level, the ADR status fields across the organization's decision record are a decision audit trail. Regulatory compliance in some industries requires demonstrating that architectural decisions were made through a documented process with identifiable decision-makers. Financial services, healthcare, and government-adjacent technology companies increasingly require this documentation for security certifications. Maintaining ADR status fields accurately across the organization's decision record is the technical foundation for this compliance documentation. Senior engineers who understand the compliance implications of documentation practices position their teams for audit readiness without requiring a reactive documentation effort when a compliance review is announced.


---

### ADR Section: Context


```text
## Context
[the problem and constraints, in 2-3 paragraphs]
```

### Junior → FAANG: Problem Framing as the Hardest Engineering Skill

Writing a 2-3 paragraph context section for an ADR is harder than writing the Decision section because it requires articulating the problem without the solution. This is the same skill that makes system design interviews difficult: framing the problem precisely before proposing a solution. Engineers who can write a clear context section (what the situation is, what the constraints are, what makes the problem non-trivial) can also open a system design interview effectively, which sets the tone for the entire discussion.

Practice writing context sections for decisions that are already made: take a technology choice in a project you know well (database selection, framework choice, deployment platform) and write the 2-3 paragraph context that would have preceded the decision. The exercise forces you to articulate the constraints and problem statement that were implicit in the original decision, which builds the explicit problem-framing skill that FAANG interviewers assess.

### Senior @ FAANG: Context as Constraint Documentation

At senior level, the 2-3 paragraph context section documents the constraints that were true at decision time and may change later. "Our team of 6 engineers had experience with PostgreSQL but not with distributed NoSQL databases" is a constraint that changes as the team grows and skills evolve. "We expected 10,000 daily active users at launch" is a constraint that changes as the product scales. Recording these constraints in the context section enables future engineers to evaluate whether the decision should be revisited based on how the constraints have changed, rather than having to reconstruct the original constraints from institutional memory or code archaeology.


---

### ADR Section: Decision


```text
## Decision
[what we decided, in 1-2 specific paragraphs]
```

### Junior → FAANG: Decision Statements as Technical Communication Practice

The "1-2 paragraphs, specific" instruction for the Decision section teaches a communication principle that FAANG interviews test: be specific and direct, then explain. "We will use Redis with the cache-aside pattern for user session data, with a 24-hour TTL and lazy invalidation on user profile updates" is a specific decision statement. "We thought about using some kind of caching solution" is not. The specificity of the decision statement reflects the specificity of your thinking: engineers who have made a clear decision can state it clearly. Engineers who are still deciding produce vague decision statements.

For interview preparation, practice stating technical decisions in the 1-2 paragraph format: one paragraph for the decision (what we chose and the key parameters), one paragraph for the connection to context (why this choice given the constraints stated in the context section). This format is the verbal equivalent of the written ADR Decision section, and practicing it in writing improves your ability to deliver it verbally under interview pressure.

### Senior @ FAANG: Decision Specificity as Reversibility Signal

At senior level, the specificity of a Decision section signals how reversible the decision is. "We will use Redis for caching" is less specific and more reversible (replace Redis with Memcached later). "We will use Redis Cluster with 3 shards, lua scripts for atomic operations, and Redis Streams for the event log" is more specific and less reversible (lua scripts and Streams create Redis-specific coupling that is expensive to migrate away from). Recording the specific parameters of a decision, not just the technology choice, gives future engineers accurate information about the migration cost when evaluating whether to replace the technology. Decisions that look reversible based on the technology name alone may be deeply coupled based on the specific features used.


---

### ADR Section: Rationale


```text
## Rationale
[why this option over the alternatives, focusing on the trade-offs]
```

### Junior → FAANG: Rationale as Interview Evaluation Anchor

The Rationale section is the most interview-valuable section of an ADR because it directly trains the "why did you choose X over Y?" question format. In a FAANG system design interview, every technology choice you propose will be followed by "why not Z?" The rationale section forces you to think through this question in advance. "We chose Redis over Memcached because Redis supports data structures (sorted sets for leaderboards, sets for unique visitor counting) that we need for planned features, and because our team already has Redis operational expertise" is a rationale that directly answers "why not Memcached?"

Practice writing rationale sections for the technology choices in any project you have worked on. Focus on the specific trade-offs that made the chosen option better for your context, not on generic advantages. "Redis has more features than Memcached" is a weak rationale. "For our specific use case of caching session data with real-time leaderboard updates, Redis's sorted set data structure eliminates a join query that would otherwise be required on every leaderboard request" is a strong rationale that connects the technology capability to the specific problem context.

### Senior @ FAANG: Rationale Quality as ADR Review Standard

At senior level, the quality of the Rationale section is the primary criterion for ADR approval in code review. A rationale that says "Option A was chosen because it is better" is not reviewable. The reviewer cannot evaluate whether "better" applies to the specific context. A rationale that says "Option A was chosen over Option B because A's latency profile (P95 < 5ms) meets our SLO requirement while B's P95 is typically 20ms for our query pattern" is reviewable: the reviewer can verify the latency claims, evaluate whether the SLO requirement is correctly stated, and assess whether the comparison is fair. Setting the standard that ADR rationale sections must be specific enough to be verifiable is a senior engineering contribution to the organization's decision quality.


---

### ADR Section: Consequences


```text
## Consequences
### Positive
[list]
### Negative
[list, and be honest about the trade-offs]
### Neutral
[list]
```

### Junior → FAANG: The "Be Honest About Trade-offs" Instruction

The "(be honest about trade-offs)" note in the Negative consequences section is a reminder that professional technical documentation acknowledges the costs of decisions, not just the benefits. Engineers who write ADRs with only positive consequences either did not evaluate the alternatives seriously or are writing marketing documents rather than technical records. Interviewers at FAANG explicitly test for honest trade-off awareness because engineers who cannot acknowledge the downsides of their own designs will not catch or escalate the real problems those downsides create in production.

The Neutral consequences section is underutilized but valuable. Neutral consequences are things that change as a result of the decision without being clearly positive or negative: "teams must learn the Redis API" is neutral if the team has the capacity to learn it and negative if they do not. Including neutral consequences makes the ADR more complete and demonstrates that you thought through second-order effects, not just the immediate positive and negative impacts.

### Senior @ FAANG: Consequence Completeness as Risk Anticipation

At senior level, the completeness of the Negative consequences section is the primary measure of risk anticipation quality. A negative consequence list that captures all known risks at decision time, with their estimated probability and impact, is the foundation for the monitoring and alerting strategy: each negative consequence should have a corresponding metric or alert that would detect the consequence manifesting in production. "Negative: Redis unavailability causes cache stampede" connects directly to an alert on Redis availability and a circuit breaker in the cache client implementation. Consequence-to-monitoring mapping, done at decision time, ensures that the operational response is ready before the risk materializes.


---

### ADR Section: Alternatives considered


```text
## Alternatives Considered
### Option A: [rejected option]
[why rejected]

### Option B: [rejected option]
[why rejected]
```

### Junior → FAANG: Alternatives Considered as Decision Credibility

The Alternatives Considered section is what makes an ADR decision credible rather than arbitrary. A decision section that says "we chose Redis" without alternatives considered could mean Redis was the obvious choice, the first option evaluated, or the personal preference of the most senior engineer. With "Alternatives Considered: Memcached (rejected because no support for data structures required for leaderboard feature), in-memory cache (rejected because state is lost on service restart and does not support horizontal scaling)," the decision is credible: Redis was chosen after evaluating real alternatives and rejecting them for specific, documented reasons.

For FAANG interviews, the alternatives considered framing applies directly to system design discussions. When you propose a technology or design choice, immediately follow with "I considered X and Y but rejected them because Z." This signals that you arrived at your proposal through analysis rather than default. Interviewers often ask about alternatives precisely to test whether you considered them. Having pre-analyzed alternatives is the shortcut to confident, immediate answers to these follow-up questions.

### Senior @ FAANG: Alternatives Scope as Decision Thoroughness Signal

At senior level, the number and quality of alternatives considered signals the thoroughness of the decision process. An ADR with zero alternatives considered was made without analysis. An ADR with one alternative considered may have been anchored to a predetermined choice with a single alternative included for appearances. An ADR with three to five alternatives considered, each with specific rejection reasons, demonstrates genuine evaluation. The senior engineer reviewing an ADR should assess whether the alternatives scope is appropriate for the decision's impact: low-impact decisions can proceed with fewer alternatives, while high-impact decisions (architecture changes, data model choices, authentication system selections) warrant broader alternative analysis before deciding.


---

### ADR Section: References


```text
## References
[any relevant docs, RFCs, blog posts]
```
---
### Template 10: Godoc Documentation Pass

```text
Add godoc documentation to all exported symbols in this Go file.

Rules for godoc:
- Every exported function, method, type, constant, and variable must have a comment
- Comments begin with the name of the thing being documented
- First sentence is a complete sentence summarizing purpose
- For functions: document non-obvious parameters and return values
- For types: document the purpose and any important invariants
- For errors: document when each error is returned
- For interfaces: document the contract (what implementations must guarantee)

Do NOT add comments for:
- Unexported symbols (lowercase)
- Test functions
- Obvious things ("ID is the ID of the user" - skip these)

After adding documentation, verify:
- No spelling errors
- No sentences that just restate the name ("GetUser gets the user" → improve to "GetUser retrieves a user by ID from the repository, returning domain.ErrNotFound if no user exists with that ID.")

File:
[paste file]
```

---

### Junior → FAANG: References as Research Credibility

The References section of an ADR is where you cite the evidence that supports the decision. A decision backed by a benchmark comparison (with a link to the benchmark), an official documentation section (with a specific URL), and a production case study (with a link to the blog post or paper) is more credible than a decision based on team preference or hearsay. Building the habit of citing evidence for technical decisions, and linking to primary sources rather than secondary summaries, is a professional discipline that distinguishes engineers who make evidence-based decisions from those who make intuition-based decisions.

The godoc template at the end of this file is a concrete AI prompt for documentation work that produces measurable quality: every exported symbol must have a comment, the comment must not just restate the name, and errors must document when they are returned. Using this template to ensure godoc coverage before merging any new package is a documentation discipline that makes Go packages usable by other engineers without reading the implementation. Practicing this discipline on your own code, and requiring it in code review, builds the documentation culture that FAANG production codebases maintain.

### Senior @ FAANG: ADR References as Organizational Knowledge Graph

At senior level, the References section of ADRs forms nodes in the organization's knowledge graph. ADR-007 references the PostgreSQL documentation for a specific feature. ADR-012 references ADR-007's context to explain why it is building on the existing database choice. ADR-018 references the performance benchmark that motivated a change to the architecture established in ADR-007. These references, if maintained accurately, create a traceable decision history that enables engineers to understand not just what was decided but why, and what decisions were influenced by earlier decisions. Tooling that parses ADR references and generates a decision dependency graph is a platform contribution that makes this knowledge graph navigable at organizational scale, which is the type of high-value tooling investment that staff engineers are expected to drive.
