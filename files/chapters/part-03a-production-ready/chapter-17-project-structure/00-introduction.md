# Chapter 17: Project Structure

*A well-organized project structure is the foundation of maintainable software.*

The way you lay out a Go project on day one shapes every decision that follows: how teams divide ownership, how packages evolve without breaking each other, how new engineers onboard in hours instead of weeks. Unlike frameworks that impose a rigid scaffold, Go deliberately leaves structure to the developer, which is both a freedom and a trap. Without intentional design, codebases drift toward a tangle of circular imports, god-packages, and untestable spaghetti that no amount of refactoring can easily unwind.

Clean Architecture and Domain-Driven Design give us the vocabulary to do better. The `internal/` directory is the one boundary the toolchain itself polices: code under `internal/` can only be imported from within the directory tree rooted at `internal/`'s parent. Everything else is convention. Keeping business logic in a domain layer, free of HTTP, database, or framework dependencies, means the same rules can be tested in microseconds, reused across CLI and gRPC handlers, and swapped to a new delivery mechanism without touching a single line of domain code. Dependency injection wires everything together at the composition root, making each component independently replaceable and each unit test cheap to write.

Large organizations converge on a few of the same ideas. Ownership boundaries are drawn along package boundaries, so a `CODEOWNERS` file maps cleanly onto the code it governs. Packages are named for what they provide, not what they contain (Google's public Go style guide makes this explicit). Services that keep infrastructure at the edges, behind interfaces, can swap a data store without touching business rules. Understanding *why* those patterns were chosen, not just *what* they look like, is the fastest path to code that survives years of feature development and team growth.

**What you'll learn in this chapter:**

- What the common layout directories (`cmd/`, `internal/`, `pkg/`, `api/`, `configs/`) actually buy you, and which of them you can skip
- Why `internal/` is the only boundary the toolchain enforces, and why `pkg/` usually earns its keep less often than people assume
- How to structure packages by domain feature rather than technical layer for higher cohesion
- How to implement manual dependency injection at the composition root without reflection-heavy frameworks
- How to design a configuration system that supports multiple environments, secret injection, and hot reload
- How to map domain errors to HTTP status codes through a clean error taxonomy
- How to scaffold a testing infrastructure that covers unit, integration, and end-to-end layers from day one
- How to build a production-ready Makefile and Docker multi-stage build that fits cleanly into CI/CD pipelines

**Why this matters at scale:**

Layout stops being a matter of taste the moment more than one team has to read the code. Build systems that cache and parallelize work across a large repository depend on package boundaries being stable and dependencies being explicit, so a sloppy boundary is not just an aesthetic problem, it invalidates build caches and slows everyone down. Keeping infrastructure behind interfaces at the edges of a service is what makes it possible to point a service at a different data store, or a fake one during a chaos experiment, without editing business rules. And an org that standardizes one layout across its service catalog gets something no individual clever layout provides: an engineer can open any service and know where things live. Dropbox is the well-documented example of a company that moved substantial backend infrastructure from Python to Go and leaned on that kind of consistency. (Its desktop sync engine rewrite, famously, went to Rust instead, a useful reminder that Go's strength zone is the networked backend, not the client.)

**Prerequisites:** Chapters 1-16. Comfort with Go modules, interfaces, and basic HTTP handlers.

> **For readers new to Go:** the "standard" project layout is a convention, not a rule. Start simpler than you think you need. Most tutorials over-structure projects.
>
> **For readers already senior at a FAANG-equivalent:** the concrete benefit is in consistency across the org's service catalog. A Go codebase where every service uses the same layout is easier to navigate, staff rotations are smoother, and tooling (linters, generators, deploy configs) works uniformly.

**Chapter navigation by career stage.**

- **Junior:** read sequentially, but remember that layout preferences vary. Get comfortable with one layout and apply it consistently.
- **Senior:** the case-studies and common-mistakes sections. Recognizing over-structured vs. under-structured code and nudging PRs toward the right density.
- **Staff or Principal:** the architecture decision is "what layout does the org standardize on?". Drive consensus, document it, and apply it in onboarding.

**Staff and Principal lens: layout consistency beats layout correctness.** Any reasonable layout applied consistently across services is better than a mix of "best" layouts applied inconsistently. The staff-level decision is picking one and sticking with it. The principal-level investment is maintaining the standard as the codebase scales.

**Go version note.** The standard project layout from 2018 is one of several valid options. Modern Go often uses flatter layouts without `pkg/` (the stdlib itself does not use `pkg/`). Do not treat any layout as sacred. Pick what fits the project's scale and scope.

---
