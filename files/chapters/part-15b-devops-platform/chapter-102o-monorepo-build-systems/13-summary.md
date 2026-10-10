## 102O.11 Mid-Chapter Synthesis: Core Monorepo Patterns

| Topic | Key Tool/Pattern |
|-------|-----------------|
| Multi-module workspace | `go work init`, `go work use`, `go work sync` |
| Affected detection | `git diff --name-only base...HEAD` + service mapping |
| Bazel builds | `gazelle`, `go_binary`, `go_test`, remote cache |
| Custom build tool | Parallel `go build` with semaphore |
| Dep graph | `golang.org/x/tools/go/packages` + cycle detection |
| License check | `google/go-licenses csv ./...` |
| Vuln scan | `govulncheck ./...` |
| CI matrix | GitHub Actions `strategy.matrix` from affected services |
| Versioning | CalVer or SemVer per service, git tags |
| Linting | `golangci-lint` with full rule set |

### Junior → FAANG: Using the Summary as a Study Checklist

Before a system design or infrastructure interview, scan this table and confirm you can explain the "why" for each row in one sentence. If you can say "affected detection uses `git diff --name-only base...HEAD` plus service mapping to avoid rebuilding unaffected services," you understand the tool. If you can only say "we use affected detection," you do not.

The rows with the highest interview return on investment: the workspace row (explains `go.work`), the affected detection row (explains the CI scaling problem), and the CI matrix row (explains how GitHub Actions parallelizes across services). These three together answer the most common monorepo CI question: "how do you keep CI fast as the monorepo grows?"

### Senior @ FAANG: Summary as Platform Capability Map

This table is also a platform capability map. Each row represents a capability that requires ownership, monitoring, and a defined maturity level. A complete platform roadmap assigns each row to an owning team, a current maturity level (1-3), a target maturity level, and a timeline. Capabilities that are missing or at maturity level 1 in a fast-growing organization are risks: they will become painful at some predictable future scale.

At staff level, the summary table is a conversation starter with engineering leadership: "here are the 10 capabilities required for a healthy Go monorepo at our scale. Here is where we are on each. Here is the investment required to reach target maturity. Here is what happens if we do not invest." That framing translates technical platform work into business risk language, which is the communication pattern expected at L6 and above.

---
