## Summary

| Topic | Key Tool/Pattern |
|-------|-----------------|
| Multi-module workspace | `go work init`, `go work use`, `go work sync` |
| Affected detection | `git diff --name-only base...HEAD` + service mapping |
| Bazel builds | `gazelle`, `go_binary`, `go_test`, remote cache |
| Bazel hermetic builds | Sandboxed actions, content-addressed cache keys, pinned toolchains |
| Bazel remote execution | RBE via BuildBuddy/EngFlow, `--jobs=500`, critical path parallelism |
| Gazelle codegen | `gazelle update-repos`, `gazelle fix ./...`, CI drift check |
| Nx affected analysis | Project graph, `nx affected --target=build`, task pipelines |
| Turborepo caching | `turbo.json` pipeline, Vercel or self-hosted remote cache |
| Tool selection | go.work (<10 devs), Nx (polyglot), Bazel (200+ devs) |
| Conventional commits | `feat:`, `fix:`, `feat!:` for automated versioning |
| Changelog generation | `git-cliff`, `cliff.toml`, grouped by type |
| Go major versions | `/v2` module path suffix, import path update |
| Release bot | Go + `go-github` API, conventional commit parsing, PR creation |
| Release trains | Biweekly scheduled GitHub Actions workflow |
| Go module proxy | Athens self-hosted, `GOPROXY`, `GOPRIVATE` |
| Custom build tool | Parallel `go build` with semaphore |
| Dep graph | `golang.org/x/tools/go/packages` + cycle detection |
| License check | `google/go-licenses csv ./...` |
| Vuln scan | `govulncheck ./...` |
| CI matrix | GitHub Actions `strategy.matrix` from affected services |

### Junior → FAANG: Using the Summary Table as a Decision Checklist

A summary table like this one is most useful when you treat it as a decision checklist, not just a reference. Before opening a PR that introduces new tooling or changes an existing process, locate the relevant row and ask: is the tool I am choosing consistent with what the team already uses? If the team uses `git-cliff` for changelog generation and you propose a different tool, there is a coordination cost that may not be worth the marginal benefit.

The "tool selection" row is the most important for early-career engineers: `go.work` for small teams, Nx for polyglot at mid-scale, Bazel for large engineering organizations. Learning when to escalate tooling complexity is a judgment call that comes with experience, but this row gives you a concrete threshold to reason from. Do not introduce Bazel to a 5-engineer team. Do not stay on `go.work` with a 300-engineer organization.

Interview entry point: for any summary table like this, be prepared to explain the tool in each row and the tradeoff that led to choosing it over the alternatives. Interviewers use summary tables as a starting point for "tell me more about X" probes.

### Senior @ FAANG: Reading Summary Tables as Architecture Audits

At senior level, a summary table like this is an architecture audit checklist. For each row, the question is not "do we use this tool?" but "is our use of this tool producing the intended outcome, and do we have a way to measure that?" Bazel for hermetic builds: what is our cache hit rate, and is it above the SLO? `govulncheck` for vulnerability scanning: what is our mean time to patch, and is it within the policy window? `golangci-lint` for linting: are we tracking false positive rate, and is anyone systematically disabling rules without review?

The pattern that distinguishes L6 from L5 thinking in platform roles: L5 engineers know what tools to use. L6 engineers know what outcomes the tools should produce, how to measure those outcomes, and what to do when the measurement shows the tool is not achieving the intended outcome. This table is incomplete without a corresponding metrics table showing the KPI for each tool and the current value versus target. That metrics view is what staff-level engineers add to architecture reviews.

### Junior → FAANG: Building a Personal Reference from This Table

Before your next platform or infrastructure interview, convert this table into a set of flashcards: tool or pattern on one side, one-sentence explanation of why it exists on the other. The "why" is more important than the "what" in interviews. "Athens self-hosted Go module proxy" as a why becomes: "makes builds reproducible and internet-independent by caching all external dependencies internally, which is required for compliance and eliminates the reliability dependency on public module infrastructure."

The rows with the highest interview signal: Bazel hermetic builds, Bazel remote execution, Nx affected analysis, and release trains. These four topics appear across Google, Amazon, Meta, and Netflix infrastructure interviews because they represent the engineering investments that make large-scale monorepos viable.

### Senior @ FAANG: Summary as a Platform Roadmap Template

This summary table is a platform capability inventory. For each row, a platform team should be able to answer: who owns this capability, what is its current reliability SLO, what is the on-call escalation path when it fails, and what is the next planned improvement? Capabilities without owners degrade silently. Capabilities without SLOs cannot be prioritized against product work. Capabilities without on-call paths cause production outages that engineers cannot escalate effectively.

At staff level, publishing this inventory as a quarterly platform health report, with a traffic-light status for each capability and a trend line showing improvement or regression, is the communication artifact that keeps engineering leadership informed and that justifies platform team headcount requests with evidence. The difference between "we need more platform engineers" and "our remote cache hit rate dropped from 88% to 71% last quarter because we did not have capacity to address the toolchain upgrade, and that 17-point drop cost each engineer 23 minutes of additional CI wait per day" is the difference between an unconvincing request and a funded roadmap item.

---

### Navigation

- **Previous Chapter**: [Chapter 102G - Container Security & Service Discovery](../chapter-102g-container-security-service-discovery/00-introduction.md)
- **Next Part**: [Part XV-C - Networking Protocols & Real-Time Communication](../../part-15c-networking-protocols/00-part-intro.md)

