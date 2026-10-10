## Learning Objectives

By the end of this chapter, you will:
- Understand the tradeoffs between monorepo and polyrepo strategies across dimensions of atomic commits, dependency management, CI scale, team autonomy, and tooling complexity
- Be able to write Bazel BUILD files for Go targets, including `go_binary`, `go_library`, `go_test` rules, and managing external dependencies with `gazelle`
- Know how to configure and use Go workspaces (`go.work`) for multi-module monorepos, enabling local cross-module development without replace directives
- Be able to implement affected-only CI - detecting which services are impacted by a change and running only the relevant build and test targets - using Bazel's query language or custom tooling
- Understand remote caching for build systems, including Bazel remote cache configuration, cache key design, and measuring cache hit rates to optimize CI throughput
- Know how to manage module versioning in a monorepo, including independent vs. Lockstep versioning strategies and automating version bumps across dependent modules
- Be able to implement release engineering practices for monorepos including changelog generation, tag-based releases, and promotion pipelines per service
- Know how to build developer tooling for monorepo productivity: workspace setup scripts, local development proxies, code ownership enforcement, and pre-commit hooks

### Junior → FAANG: Mapping Objectives to Interview Questions

Each learning objective in this list corresponds to a category of question that appears in infrastructure and platform engineering interviews at FAANG companies. The most common entry-level version of these questions sounds like: "explain what a Go workspace is and when you would use it," or "how would you make CI faster in a monorepo?" Answering these well requires knowing the mechanics: what `go.work` actually does (resolves imports to local paths instead of the module registry), why affected detection matters (avoids rebuilding all services when one changes), and what makes Bazel builds hermetic (sandboxed actions with content-addressed caching).

Before moving to later parts of this chapter, make sure you can answer each objective in one or two sentences from memory. That forces you to internalize the "why" behind each tool rather than just recognizing its name.

### Senior @ FAANG: Scoping Technical Strategy to Organizational Stage

These learning objectives cover the full capability surface of a mature monorepo platform. A senior engineer's job is to identify which of these capabilities are urgent versus which are premature optimization for your organization's current size and team maturity.

A useful framework: map each objective to a prerequisite. You cannot implement effective affected-change CI until you have a reliable dependency graph. You cannot achieve high remote cache hit rates until your builds are hermetic. You cannot enforce dependency governance until you have a known-good baseline of current dependency licenses. This sequencing matters because investing in release engineering automation before your builds are reproducible results in a release pipeline that ships non-deterministic artifacts, which is worse than a manual release process.

At the L6/L7 level, the skill being tested is not "do you know how to use Bazel?" but "can you build a multi-quarter roadmap that sequences these capabilities correctly given the constraints of team size, existing technical debt, and business priorities?" The learning objectives here are the building blocks of that roadmap.

