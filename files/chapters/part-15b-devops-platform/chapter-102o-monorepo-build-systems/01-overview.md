## Overview

Monorepos power Google, Meta, Twitter, and Uber's engineering organizations. They offer atomic commits across services, unified tooling, and enforced dependency management. For Go engineers, choosing the right monorepo strategy - and the right build tooling - is critical for maintaining fast CI times as codebases scale to millions of lines.

After this chapter you will be able to:
- Structure Go monorepos with `go.work` multi-module workspaces
- Use Bazel and Buck2 for hermetic, reproducible Go builds
- Implement affected-change detection to build only what changed
- Set up dependency management, license checking, and vulnerability scanning
- Build custom `go generate` pipelines for large codebases
- Configure fast CI with remote build caching
- Implement service versioning and release strategies in monorepos

### Junior → FAANG: Getting Oriented in a Monorepo

The first time you clone a FAANG-scale monorepo, the sheer size can be disorienting. A practical orientation strategy: start by running `go list ./...` scoped to the service you own, map out its direct imports into `internal/` and `shared/`, and read the CI configuration for that service to understand what runs on every PR. Do not try to understand the whole repo at once.

The overview in this chapter maps directly to interview questions. If asked "what does it take to run a Go monorepo at scale?", answer with these seven points: workspace layout, affected detection, hermetic builds, remote caching, dependency governance, release engineering, and developer experience tooling. Each of these has a dedicated section you will study in depth.

### Senior @ FAANG: Platform Thinking for Build Systems

An overview of a monorepo build system is really an overview of a platform product with internal engineers as customers. Each bullet in this overview represents a capability that must be maintained, monitored, and evolved. Cache hit rates degrade when toolchains are updated without invalidating stale cache keys. Affected detection breaks when engineers add implicit filesystem dependencies that the graph cannot see. License scanning falls behind when new dependency patterns bypass the allowlist check.

At the staff level, your job is not to implement each of these capabilities once. It is to define the maturity model for each: what does a "level 1" (functional), "level 2" (reliable and observable), and "level 3" (self-healing and proactively governed) capability look like for affected detection, for remote caching, for license compliance? Publishing that maturity model lets teams understand where they are and what investment is needed to get to the next level. Bar-raiser interviews at L6 and L7 probe exactly this: can you articulate the gap between "we have a thing that works" and "we have a platform capability that scales without human intervention"?

---
