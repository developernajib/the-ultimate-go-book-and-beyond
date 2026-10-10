## 90B.6 Common Mistakes

Even teams that adopt ADRs with the best intentions often fall into predictable traps. These mistakes do not come from laziness. They come from misunderstanding what makes an ADR valuable. Each mistake below includes a description of what goes wrong, why it is harmful, and a concrete fix you can apply immediately. If you are reviewing your team's existing ADRs for quality, use this list as a diagnostic checklist.

### Mistake 1: Writing ADRs After the Decision Is Already Made

The most common ADR failure mode is retroactive documentation. An engineer makes a decision, implements it, and then writes an "ADR" that is really a justification document - alternatives were never seriously evaluated, the context is incomplete, and the consequences are uniformly positive.

Retroactive ADRs are recognizable by:
- No alternatives with honest trade-off analysis
- Consequences section only lists positives
- No mention of constraints that ruled out alternatives
- Written in past tense: "We chose X because..."

**Fix**: Write ADRs in the Proposed state before committing to an implementation. The act of writing the alternatives section often reveals options not initially considered.

### Mistake 2: ADRs That Are Too Long

ADRs that exceed three pages lose readers. Engineers will skim or skip them entirely. The context section should be thorough enough to explain the decision to a future engineer with no prior context, but it is not a design document. Reserve deep technical detail for design docs or code comments.

**Fix**: If your ADR exceeds three pages, split it. One ADR should document one decision. If you find yourself writing two ADRs' worth of content, you have two decisions.

### Mistake 3: ADRs That Are Too Short

The opposite mistake: a one-paragraph ADR that provides no useful context. "We chose PostgreSQL because it's good" tells a future engineer nothing about what alternatives were evaluated, what constraints existed, or what trade-offs were accepted.

A useful test: give the ADR to an engineer who joined the company after the decision was made. If they cannot answer "why not MongoDB?" after reading the ADR, the context section is insufficient.

**Fix**: Always include at least two alternatives that were seriously evaluated with honest trade-off analysis for each.

### Mistake 4: Not Maintaining ADR Status

ADRs that remain in Accepted state long after the decision they document has been superseded are worse than no ADRs. They actively mislead engineers. A new engineer reading an accepted ADR for a deprecated service will act on stale information.

**Fix**: Add ADR maintenance to your engineering rituals. When a major architectural change is implemented:
1. Check whether it supersedes any existing ADRs
2. Update superseded ADRs to Superseded status with a link to the new ADR
3. Review the ADR index quarterly in engineering all-hands or architecture reviews

### Mistake 5: Storing ADRs Outside Version Control

ADRs in Confluence pages, Notion databases, or Google Docs pages that are not linked from the repository create disconnection between decision records and code. When the documentation platform is migrated, ADRs are lost. When the code is searched, ADRs are not found.

**Fix**: ADRs must live in the repository, in `docs/adr/`, version-controlled as markdown. Mirror them to Notion/Confluence for discoverability if needed, but the canonical source is the repository.

### Mistake 6: No Connection Between ADRs and Code

ADRs that are never referenced from code are invisible. Engineers encounter unfamiliar patterns in code and spend hours in archaeology mode, never discovering that there is an ADR explaining the rationale.

**Fix**: As part of the ADR acceptance process, add a "Links" section with the path to the primary implementation, and add an ADR reference comment to the relevant package-level doc comment.

### Mistake 7: Treating ADRs as Binding Law

Once an ADR is accepted, it is a record of a decision made under specific constraints at a specific time. It is not a law that cannot be changed. If circumstances change - new technology, new scale requirements, new team capabilities - a new ADR can supersede the old one.

Engineers should feel empowered to challenge accepted ADRs. The right mechanism is: write a new ADR proposing the change, explain the new context that justifies revisiting the decision, and go through the review process.

**Fix**: Add this note to your ADR template: "This ADR was accepted under the constraints described in the Context section. If those constraints have materially changed, consider proposing a superseding ADR."

### Mistake 8: Using ADRs for Trivial Decisions

ADRs add overhead. Using them for decisions that don't warrant documentation wastes engineers' time and dilutes the signal-to-noise ratio of the ADR repository. If every minor technical preference is an ADR, engineers stop reading them.

**Fix**: Use the decision criteria from section 90B.2. Reserve ADRs for hard-to-reverse, cross-team, or context-heavy decisions. Keep the threshold high enough that each ADR is worth reading.

---

### Core Principles of Effective ADRs

Architectural Decision Records are one of the most impactful practices available to senior and staff engineers. They solve the fundamental problem of institutional memory in software systems: decisions made under specific constraints, by engineers who may have left the company, are invisible to the engineers who later maintain and extend those systems.

The core principles of effective ADRs:

1. **Write them before the decision is finalized** - ADRs in Proposed state drive better decisions, not just better documentation
2. **Include honest trade-off analysis** - alternatives must be fairly evaluated, and consequences must include negatives
3. **Keep them short** - two to three pages maximum, and split if necessary
4. **Maintain their status** - superseded ADRs must be updated, and stale Accepted ADRs are actively harmful
5. **Store them in version control** - `docs/adr/` in the repository is the canonical home
6. **Link them from code** - package-level doc comments and code comments reference relevant ADRs
7. **Use the right format** - Nygard for simple decisions, MADR for decisions where alternatives matter
8. **Use ADRs for the right decisions** - hard-to-reverse, cross-team, or context-heavy decisions only

At the staff engineer level, your ADRs are part of your professional record. They demonstrate that your architectural influence is intentional, evidence-based, and durable - qualities that promotion committees at FAANG explicitly evaluate.

Start with the next architectural decision you make. Write an ADR before the decision is finalized. Get it reviewed. Merge it. Reference it from the code. Within three months, this practice will be second nature - and the engineers who join your team six months later will thank you.

### Junior → FAANG: Recognizing Mistakes in Your Own ADRs

The most common mistake for a first-time ADR author is writing a solution document rather than a decision document. A solution document describes what you built. A decision document describes why you chose this approach over the alternatives. If your ADR's context section could be replaced by the first paragraph of a feature spec, it is probably a solution document.

Practice reading your own ADR draft from the perspective of an engineer who joins your team in two years. Does that engineer, with no context on the current situation, understand: what problem was being solved, what was tried or considered, what was chosen, what constraints shaped the choice, and what the expected consequences are? If the answer to any of those questions is no, the ADR has a gap.

Retrospectively writing ADRs for past decisions is a useful practice exercise. Find a decision your team made three to six months ago that was not documented. Interview the people who made the decision. Reconstruct the context, alternatives, and reasoning. The difficulty of that reconstruction is direct evidence of how much value the original ADR would have had.

### Senior @ FAANG: Using Common Mistakes as a Review Rubric

The mistake patterns in this section can be operationalized as a structured review checklist that staff engineers use when reviewing ADRs from their teams. Converting the mistakes into yes/no checklist items: "Does this ADR document a decision rather than a solution?" "Does the context section explain why this decision was consequential?" "Does the alternatives section include options that were genuinely considered, not strawmen?" "Does the consequences section name at least one negative outcome honestly?"

At FAANG, the ADR review process functions as a quality gate on technical decision-making. A reviewer who approves an ADR that makes these mistakes is not just accepting a low-quality document. They are accepting a decision-making process that skipped the analysis those sections represent. The review is the enforcement point for the reasoning standard, not just the documentation standard.

The "post-hoc rationalization" mistake is particularly important to detect in high-stakes decisions. When a team writes an ADR after a decision has already been implemented, and the ADR reads as a defense of the implementation rather than a record of a deliberated choice, the organization has no actual governance artifact. It has a cover document. Staff engineers who identify this pattern should investigate whether the actual decision-making process included the alternatives analysis the ADR implies. If it did not, that is a process gap worth addressing explicitly.

---
