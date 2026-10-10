# Chapter 90B: Architectural Decision Records (ADRs)

*"The palest ink is better than the best memory."* - Chinese Proverb

Every software system is shaped by hundreds of consequential decisions made by people who may no longer be on the
team. The choice to use PostgreSQL over MongoDB, to build a monolith before splitting into services, to adopt
gRPC instead of REST for internal communication - each of these decisions made sense in a specific context, under
specific constraints, with specific trade-offs in mind. When context changes and a new engineer questions the
decision, the team faces an impossible situation: they cannot evaluate whether to reverse it because the original
reasoning no longer exists anywhere. The result is either cargo-culting past decisions indefinitely or discarding
them at enormous cost without understanding what was actually being traded away.

In Go projects specifically, the absence of architectural documentation is acutely felt because Go's simplicity
and composability mean there are always multiple valid approaches to any design problem. Should this service use
interfaces throughout or concrete types where the indirection adds no value? Should this component be a separate
binary or an internal package? Should this data live in Postgres or Redis? When a Go codebase has no decision
trail, each new engineer brings their own answers and the codebase drifts toward inconsistency. ADRs give Go
teams a lightweight mechanism to record the answers and the reasoning, making the codebase legible to engineers
who joined after the decisions were made.

This chapter teaches you to write, maintain, and champion Architectural Decision Records at a level that satisfies
both the practical need for institutional memory and the organizational need for evidence of technical leadership.
You will master both dominant ADR formats, work through five real-world examples for common Go infrastructure
decisions, learn how to integrate ADRs into a Go project's directory structure with code cross-references, define
a team-wide ADR workflow, and understand exactly how ADRs contribute to senior and staff engineering promotion
cases at FAANG-level companies where documented impact is the currency of advancement.

**What you'll learn in this chapter:**
- What ADRs are, why they exist, and how they differ from design documents, RFCs, and meeting notes - and
  the criteria for choosing the right artifact for a given decision
- Michael Nygard's original ADR format and the lightweight MADR (Markdown Architectural Decision Records)
  format, with guidance on when each is appropriate for your team's workflow
- How to write a high-quality ADR: articulating context, forces, decision, consequences, and alternatives
  considered with enough detail to remain useful to an engineer reading it three years later
- The ADR lifecycle: from Proposed through Accepted, Deprecated, and Superseded, and how to manage state
  transitions without invalidating the institutional memory that earlier ADRs represent
- Five fully worked ADR examples for Go projects: selecting a database, adopting gRPC, choosing between
  monolith and microservices, selecting an observability stack, and defining error handling conventions
- Integrating ADRs into a Go project: directory structure (`docs/decisions/`), file naming conventions
  (`0001-use-postgres.md`), and cross-referencing ADRs from code comments and PR descriptions
- Defining a team-wide ADR workflow: who proposes, who reviews, who approves, and how ADRs surface during
  onboarding, code review, and architecture discussions
- The connection between ADRs and engineering promotions: how documented architectural leadership creates
  permanent, attributable evidence of technical impact visible to promotion committees

**Why this matters at scale:**
Google's design document culture, Amazon's six-page narrative process, and Uber's RFC workflow all serve the same
purpose as ADRs - creating a searchable institutional memory that lets engineering organizations scale past the
size where word-of-mouth knowledge transfer is sufficient. Netflix's engineering blog and Stripe's engineering
principles both cite documented decision-making as a core practice for maintaining architectural coherence as
teams and codebases grow.

**Prerequisites:** Chapters 84--90 (senior engineer mindset), Chapter 58 (system design fundamentals)

### Junior → FAANG: Why ADRs Matter Before You Write Your First One

Most junior engineers have never written an ADR and have never worked somewhere with a formal ADR process. The concept can feel like bureaucracy invented by people who enjoy writing over coding. That intuition is wrong in an important way: ADRs are not documentation for documentation's sake. They are the answer to "why did we do it this way?" asked six months from now, by a colleague who was not in the room, in the middle of an incident at 2 AM.

If you have ever read a codebase and found an architectural choice that seemed obviously wrong, and could not tell if it was wrong because nobody thought about it or wrong because someone thought about it and made a deliberate tradeoff, you have experienced the cost of missing ADRs. That confusion costs time at exactly the moment when time is most expensive.

Start writing decision records now, even informally. When you make a non-trivial technical choice, write a sentence about what you decided and why. Put it in a PR description, a Slack message, a comment in the code. The habit of articulating reasoning is what matters at this stage, not the format.

### Senior @ FAANG: ADRs as Organizational Governance Infrastructure

At FAANG, ADRs function as a governance mechanism that allows organizations to maintain technical coherence across hundreds or thousands of engineers without requiring top-down approval for every decision. When implemented well, they answer three organizational needs simultaneously: they transfer knowledge from the decision-makers to future implementers, they provide a basis for auditing whether past decisions should be revisited, and they create accountability by making decision rationale visible to peers who can challenge it.

The most mature ADR implementations at FAANG-scale organizations treat ADRs as living artifacts with explicit ownership. Each ADR has a named author who is responsible for keeping its status current, a reviewer set that must approve before the ADR is accepted, and a linkage to the code or configuration it governs. When the code changes in ways that contradict an accepted ADR, the contradiction is surfaced in code review and resolved explicitly, either by updating the ADR or reverting the code change.

The governance question that separates L6 from L7 thinking in this domain: who has the authority to create, accept, and supersede ADRs in your organization? At most companies, this is implicit. The implicit answer is usually "anyone can write an ADR and anyone can ignore it," which produces an ADR corpus that is both unreliable and politically contentious. The mature answer is an explicit decision rights model, documented in a meta-ADR, that specifies which categories of decisions require an ADR, which roles have acceptance authority for each category, and how disputes are resolved.

---
