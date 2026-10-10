# Part XIIIB: Software Architecture Patterns

*"Architecture is the decisions that are hard to change."* - Martin Fowler

Choosing the right architecture for a system is one of the most consequential decisions an engineer can make. A poor architectural choice can cost months of rework, degrade team productivity, and create technical debt that compounds for years. At FAANG companies, senior engineers and staff engineers are expected to evaluate architectural trade-offs rigorously, select patterns that match the problem's complexity, and articulate their reasoning clearly to both technical and non-technical stakeholders. This part gives you the vocabulary, frameworks, and Go-specific implementation knowledge to make these decisions confidently.

The software industry often falls into the trap of treating microservices as the default answer to every architectural question. In reality, the most effective architects draw from a rich palette of patterns - hexagonal architecture for testability and port isolation, clean architecture for dependency rule enforcement, vertical slice architecture for feature-team autonomy, and modular monoliths for systems that need the organizational benefits of modularity without the operational complexity of distributed services. Understanding when each pattern is the right choice, and when it is the wrong one, is what separates architects from developers who simply follow trends.

Event-driven architecture adds another critical dimension. Modern systems increasingly rely on events for decoupling, scalability, and real-time processing. Understanding the differences between event notification, event-carried state transfer, and event sourcing - and knowing when to use choreography versus orchestration - is essential for designing systems that scale gracefully and evolve without requiring coordinated deployments across teams.

**What this part covers:**
- Chapter 90D: Architecture Patterns in Go - Hexagonal architecture, clean architecture, vertical slice architecture, modular monolith design, pattern selection criteria, and Go-idiomatic implementations of each
- Chapter 90E: Event-Driven Architecture Patterns - Event notification, event-carried state transfer, event sourcing, CQRS, choreography versus orchestration, and implementing event-driven systems in Go

**How to use this part:**
Read Chapter 90D first to understand the structural patterns, then proceed to Chapter 90E for event-driven patterns. These chapters complement each other - the structural patterns define how you organize code within a service, while event-driven patterns define how services communicate and evolve. Compare the patterns against production systems you have worked with to develop intuition for when each one applies.

**FAANG relevance:**
Architecture pattern selection is a core evaluation criterion in senior and staff-level system design interviews. Interviewers expect you to justify your architectural choices with specific trade-offs rather than defaulting to a single pattern. Questions like "Would you use microservices or a modular monolith here?" and "How would you decouple these services?" are common. On the job, FAANG teams regularly debate architecture patterns during design reviews, and engineers who can articulate the strengths and weaknesses of each approach drive better technical decisions across the organization.

---
