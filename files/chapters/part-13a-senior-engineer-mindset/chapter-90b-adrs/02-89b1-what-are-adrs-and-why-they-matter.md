## 90B.1 What Are ADRs and Why They Matter

### The Problem ADRs Solve

Every software system is the sum of thousands of decisions. Some decisions are trivial - which variable to name what. Others are consequential - which database to use, which communication protocol to adopt, whether to go monolithic or microservices. For trivial decisions, forgetting is fine. For consequential decisions, forgetting is dangerous.

Consider a team that chose to use MongoDB three years ago. The engineers who made that decision are gone. The new team is struggling with complex aggregation queries, consistency guarantees, and schema evolution. Nobody can explain why MongoDB was chosen. Was it the right choice at the time? Were PostgreSQL and Cassandra evaluated? What were the constraints? Was this a deliberate decision or simply "the tech lead liked MongoDB"?

Without documentation, these questions are unanswerable. The new team has three choices: live with the decision forever, reverse it at enormous cost, or make the same mistake again.

Architectural Decision Records (ADRs) are lightweight documents that record the significant architectural decisions made on a project, the context in which they were made, and the consequences of those decisions. They are the institutional memory of a software system.

### The Definition

An ADR is a short text document that captures an important architectural decision made in a project. It includes:

- **What** was decided
- **Why** it was decided (the context and forces at play)
- **What the consequences** are - both positive and negative

The term was popularized by Michael Nygard in his 2011 blog post "Documenting Architecture Decisions." Since then, it has become a standard practice at mature engineering organizations including Google, Netflix, Uber, Airbnb, and Amazon.

### FAANG Promotions and Documented Decisions

At senior and staff engineer levels, promotion committees specifically look for evidence of architectural leadership. Verbal influence is invisible to promotion committees. Documented influence is permanent.

When you write and champion an ADR, you create a durable artifact that demonstrates:

- **Technical judgment**: You evaluated alternatives and selected the best option given constraints
- **Communication**: You articulated complex trade-offs clearly to diverse stakeholders
- **Leadership**: You drove consensus and documented the outcome for future engineers
- **Accountability**: You were willing to attach your name to a decision and its consequences

Consider two engineers with identical technical skill. Engineer A makes great architectural decisions verbally in meetings. Engineer B makes the same decisions but documents them as ADRs, gets them reviewed, and links them from code comments. In six months, Engineer A's impact has faded from memory. Engineer B's impact is visible, searchable, and attributable.

At Google, every design document goes through a review process. At Amazon, the "six-page narrative" and Working Backwards documents serve a similar purpose. ADRs are the lightweight version of this practice - cheap enough to write for medium-sized decisions, durable enough to last a decade.

### ADRs as Institutional Memory

Software systems outlive the engineers who build them. The average tenure at a tech company is two to three years. A system built with no decision documentation will, within five years, be run almost entirely by people who were not present for the foundational decisions.

This creates a specific failure mode: **archaeology-driven development**. Engineers spend days or weeks trying to understand why the system is built the way it is before they can safely change it. Worse, they frequently arrive at incorrect conclusions, leading to changes that violate hidden invariants.

ADRs prevent archaeology. When a new engineer asks "why do we use event sourcing in the order service?", the answer is one `git log` or search away. The ADR explains the context, the alternatives considered, and the consequences - both intended and observed over time.

Beyond individual understanding, ADRs create a culture of intentionality. Teams with ADR practices tend to make better decisions because the act of writing forces clarity. You cannot write "we chose PostgreSQL because it's good" as an ADR. You must articulate the actual reasons. This discipline catches weak reasoning before it becomes an entrenched bad decision.

### The Cost of Undocumented Decisions

Let's make the cost concrete. Consider a microservices platform at a mid-size company:

**Cost of undocumented decision: Use Kafka for all async communication**

- Six months after adoption, a new team builds a feature using RabbitMQ because nobody told them about Kafka. Now you have two message brokers.
- Cost of dual broker maintenance: 2 engineers × 0.5 days/month = 1 engineer-day/month
- Over three years: 36 engineer-days ≈ $50,000 at FAANG compensation

**Cost of writing the ADR at the time**: 2 hours

The asymmetry is striking. A two-hour investment in documentation prevented a three-year, $50,000 mistake.

This is why staff engineers at mature companies are often judged not just on the quality of their technical decisions but on the quality of their decision documentation. A great undocumented decision is worth half a great documented decision.

### Junior → FAANG: The Cost of Missing Context

The $50,000 asymmetry in this section is not an edge case. It is the normal experience of every engineering team that skips decision documentation. As a junior engineer, you will encounter these situations regularly: you will look at a choice in the codebase, think "this seems wrong," spend time investigating, and then discover either that it was wrong and nobody remembers why it was done that way, or that it was correct and nobody remembers why it was necessary.

Both outcomes are expensive. Both are preventable with an ADR that would have taken two hours to write.

The first-job habit to build: whenever you investigate why something was done a certain way, and discover the answer, write it down. A comment in the code, a PR description, a team wiki page. This habit costs almost nothing and prevents future colleagues, potentially including your future self, from repeating the same investigation.

### Senior @ FAANG: Quantifying ADR Value to Engineering Leadership

The $50,000 example in this section is the kind of quantification that resonates with engineering directors and VPs, but only if you can connect it to real numbers from your organization. Staff engineers who want to establish or expand an ADR practice need to build the business case, not just the technical one.

The concrete calculation: estimate the average time engineers spend per month on "archaeological" investigations of undocumented decisions. In a team of 10 engineers where each spends two hours per month on this, you have 20 engineer-hours at an all-in cost of perhaps $5,000 to $10,000 per month. An ADR practice that reduces that by 50% pays for the time spent writing ADRs within weeks.

At Google, the value of institutional memory is treated as a first-order concern at the staff and principal level. Engineers who leave the company without documenting the decisions they owned create what internal teams call "decision debt": situations where the org must either re-derive the reasoning, accept the status quo without understanding it, or discover through failure that the original decision had conditions attached that have since been violated. Decision debt compounds exactly like technical debt, and is similarly invisible until it becomes a crisis.

The governance implication for FAANG-scale organizations: ADR completeness should be a factor in team health reviews, not just code quality. A team with excellent test coverage but poor decision documentation is carrying hidden risk that will surface during rapid headcount changes, org restructurings, or large-scale migrations.

---
