# Chapter 102O: Monorepo & Build Systems for Go

*A monorepo is not just a single repository. It's an organizational philosophy: one source of truth, shared tooling, and atomic cross-service changes.*

As Go codebases grow from a handful of services to hundreds, the repository strategy you chose on day one begins to matter enormously. Polyrepos - one repository per service - feel natural early on: each team moves independently, dependencies are versioned explicitly, and CI runs in seconds. But at scale, polyrepos fracture. A shared library change requires opening a dozen pull requests across a dozen repositories. An atomic rename that touches three services spans three separate review cycles and can leave the system in an inconsistent intermediate state for hours. Downstream consumers of a shared package drift onto incompatible versions, and the integration surface becomes too large to reason about in any single context. These are the growing pains that led Google, Meta, Uber, and Twitter to consolidate into monorepos - and to invest heavily in the tooling required to make them tractable.

For Go engineers, the monorepo problem has specific dimensions that other languages do not face in the same way. Go's module system was designed with explicit versioning and decentralized module hosting as first principles - not with a 10,000-module internal monorepo in mind. Making `go.work` multi-module workspaces behave correctly, ensuring that `go test ./...` does not rebuild every binary in the repository on every CI run, and wiring Bazel or Buck2's hermetic build model to Go's toolchain requires deliberate architecture. Affected-change detection - the ability to determine precisely which services are impacted by a given commit and run only those build and test targets - is the single most important CI optimization in a large monorepo, and it requires either Bazel's dependency graph query language or custom tooling built on Go's module graph APIs.

This chapter covers the full stack of monorepo engineering for Go: choosing between single-module and multi-module workspace layouts, writing and maintaining Bazel BUILD files for Go targets, configuring remote build caching to achieve near-zero incremental CI times, implementing dependency governance and license scanning, and designing release pipelines that allow independent service versioning within a shared repository. The chapter also covers developer experience tooling - the workspace setup scripts, pre-commit hooks, and code ownership enforcement that keep a large monorepo productive rather than chaotic.

**What you'll learn in this chapter:**
- Structure Go monorepos with `go.work` multi-module workspaces and understand when to choose single-module versus multi-module layouts
- Write Bazel BUILD files for Go targets including `go_binary`, `go_library`, and `go_test` rules, and automate BUILD file generation with Gazelle
- Implement affected-change detection using Bazel's query language to run only the build and test targets impacted by a given commit
- Configure remote build caching for Bazel and Buck2 to achieve high cache hit rates and sub-minute incremental CI times on large codebases
- Manage module versioning in a monorepo including independent vs. Lockstep versioning strategies and automated version bump pipelines
- Implement dependency governance with license checking, vulnerability scanning, and import restriction rules enforced at build time
- Build custom `go generate` pipelines and workspace tooling that scale across hundreds of packages without becoming bottlenecks
- Design release engineering practices for monorepos including tag-based releases, changelog generation, and per-service promotion pipelines

**Why this matters at scale:**
Google runs the world's largest monorepo - approximately 2 billion lines of code in a single repository - and built Bazel specifically to make it buildable in minutes rather than hours. Uber's Go monorepo uses a Bazel-based build graph with remote caching to keep CI times under five minutes despite containing thousands of Go packages. The patterns this chapter teaches are direct adaptations of the systems these organizations use in production.

**Prerequisites:** Chapter 97 (Docker), Chapter 98 (Kubernetes), Chapter 102C (Terraform & IaC), Chapter 102D (GitOps), Chapter 102E (Helm & Kubernetes Advanced), Chapter 102F (Platform Engineering), Chapter 102G (Container Security & Service Discovery)

### Junior → FAANG: Understanding Why Monorepos Exist

The instinct when starting a new service is to create a new repository. That feels clean: a small codebase, one team, one CI pipeline. The pain only appears later when a shared utility needs to change and you realize you have to open pull requests in five different repositories, coordinate merges across teams, and manage the window during which some services run the old version and some run the new one. That inconsistency is what monorepos eliminate.

As a junior engineer working in a monorepo for the first time, the most important habit is understanding the dependency graph before you change anything. Ask yourself: which other packages import the package I am modifying? If the answer is "many," you need to treat the change like a public API change, not a local refactor. Use `go list -f '{{.ImportPath}}: {{.Deps}}' ./...` or the dep graph tooling from Part 4 to get a concrete answer.

Interview entry point: when asked "why monorepo?", do not say "it's simpler." Say: "atomic cross-service commits, unified dependency versions, and shared tooling at the cost of CI complexity that requires affected-change detection to stay fast." That answer shows you understand the tradeoff, not just the outcome.

### Senior @ FAANG: Architectural Decision Record for Repository Strategy

The decision to adopt a monorepo is an architectural commitment with a 5-to-10-year time horizon. At FAANG scale, reversing it requires migrating thousands of CI pipelines, rebuilding developer tooling, and rewriting cross-team contribution workflows. This means the ADR for repository strategy should be treated with the same rigor as a database selection decision.

Key dimensions to document in the ADR: team topology (are teams truly independent or deeply collaborative?), release cadence (can teams ship independently without monorepo atomicity?), compliance boundaries (do certain services require code isolation for audit reasons?), tooling maturity (does your organization have the Bazel or custom tooling expertise to keep CI times under 10 minutes as the repo grows?), and access control requirements (does every engineer get read access to every service's code?).

The governance question that separates L5 from L6 thinking: who owns the build system? A monorepo without a dedicated platform team owning Gazelle configuration, remote cache health, and CI pipeline templates will degrade into a slow, painful environment within 18 months. Platform ownership is not optional, it is a prerequisite for the monorepo strategy to succeed. Staff-level engineers at Google, Meta, and Uber all cite build system ownership as the single most important investment in monorepo health. When proposing a monorepo strategy to leadership, include a staffing plan for the build platform team alongside the technical design. The technical design without the staffing plan is incomplete.

---
