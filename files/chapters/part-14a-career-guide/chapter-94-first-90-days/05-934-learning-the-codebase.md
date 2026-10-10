## 94.4 Learning the Codebase

Every new engineer faces the challenge of understanding a large, unfamiliar codebase that was written by many people over many years. The key is to approach it systematically rather than randomly reading files or trying to understand everything at once. Start with the big picture, what services exist, how they communicate, and where data is stored, then progressively zoom into the areas your team owns. Taking notes and drawing diagrams as you learn will help you retain information and also produce documentation that helps future new hires.

### Systematic Exploration

The three-phase progression from overview to depth to contribution mirrors how compilers work: you cannot resolve symbols until you have parsed the top-level structure. Jumping straight into fixing bugs without the architectural overview leads to local fixes that violate system-wide invariants, while spending too long at the overview phase without touching real code leaves you with theoretical knowledge that does not transfer to day-to-day work. The phase boundaries are approximate, let the complexity of the codebase and the urgency of team needs adjust the pace.

```
WEEK 1-2: OVERVIEW
• Read architectural documentation
• Understand service boundaries
• Map data flow for key features
• Identify key repositories

WEEK 2-4: DEPTH
• Set up and run locally
• Trace a request end-to-end
• Understand testing approach
• Review recent PRs

WEEK 4-8: CONTRIBUTION
• Fix small bugs
• Add tests
• Improve documentation
• Make small improvements

LEARNING STRATEGIES:
• Read code before asking questions
• Make notes as you learn
• Draw architecture diagrams
• Ask "why" not just "how"
```

### Questions to Answer

These questions form a dependency graph: you cannot understand the PR process without knowing the code style, and you cannot reason about on-call impact without understanding SLAs. Work through them roughly in the order listed, system architecture first, then code conventions, then team process, because each layer of understanding makes the next layer faster to acquire. When you can answer all of them confidently, you have crossed from "new hire" to "productive contributor."

```
ABOUT THE SYSTEM:
• What are the main services/components?
• How do they communicate?
• Where is the data stored?
• How is the system deployed?
• What are the SLAs/SLOs?

ABOUT THE CODE:
• What's the code style?
• How are tests organized?
• What patterns are used?
• What's the PR process?

ABOUT THE TEAM:
• How is work prioritized?
• How are decisions made?
• What's the on-call rotation?
• How are releases done?
```

### Junior → FAANG: Systematic Codebase Learning and the Go-Specific Approach

Early-career engineers often approach a new codebase by reading files sequentially or by starting where the code they need to change lives. Both approaches produce slow and shallow understanding. The most effective approach at early career is structural: start with the entry points (main packages and their dependencies), trace one request through the system from ingress to egress, and understand one complete data flow before reading anything else.

For Go codebases specifically: read the go.mod file first to understand the module structure and external dependencies. Then read the main packages to understand what services exist and how they are wired together. Then read one service's handler layer and trace down into the business logic and data access layers. This top-down structural read is faster than bottom-up file browsing and produces a more accurate mental model.

Go-specific signals to look for: how does the team handle errors (are errors wrapped with context using fmt.Errorf and %w, or are they returned bare, does the team use sentinel errors or typed errors). How is dependency injection handled (constructor functions taking interfaces, or package-level globals). How is concurrency managed (explicit goroutine lifecycle management with WaitGroups and contexts, or fire-and-forget goroutines). These patterns tell you what the team values and what the code review bar is.

### Senior @ FAANG: Codebase Archaeology and Technical Debt Assessment at L6

At senior level, learning the codebase includes understanding not just how it works but why it works this way and what it would take to change it. This requires a different set of questions: what was the original design and what pressures caused the current divergence from it, which parts of the codebase are actively maintained and which are effectively in maintenance mode, and where are the load-bearing seams where a change would require careful coordination.

The most effective senior codebase learning practice is git blame combined with incident history. Reading the commit messages and linked issues for the most-changed files in the repository tells you which parts of the system have been the most painful to operate and why. Cross-referencing with incident post-mortems gives you a picture of the failure modes that the team has already experienced. This context is worth more than any amount of code reading for understanding where your effort as a senior engineer would have the highest impact.

The ADR and technical debt assessment you produce from this exercise should be treated as a working document that you refine over your first 90 days. By day 90, you should have a prioritized list of the three to five most important technical improvements you believe the team should make, with rough effort estimates and expected impact. This document is the foundation of the technical leadership you will be expected to exercise in months four through twelve.

---
