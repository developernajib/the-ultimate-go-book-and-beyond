## 102O.9 Common Mistakes

| Mistake | Problem | Solution |
|---------|---------|----------|
| Not using `go.work` for multi-module | Painful `replace` directives | `go work init` for local development |
| Building all services on every commit | Slow CI (30min+ builds) | Implement affected-change detection |
| No remote build cache | Repeated compilation | Bazel remote cache or GitHub Actions cache |
| Shared module with no backward compatibility | Breaking all dependents | Semantic versioning + API stability |
| `go generate` not in CI | Generated files drift from source | Run and verify `go generate ./...` in CI |
| Missing `go.work.sum` in CI | Non-reproducible builds | Commit `go.work.sum` |
| Circular imports in shared packages | Cannot compile | Use `depgraph` to detect + break cycles |
| Monorepo with incompatible dep versions | Diamond dependency problem | One version per dep via workspace |

### Junior → FAANG: Pattern-Matching Common Failures Before They Hit You

Each row in this table represents a real failure mode that engineers encounter in their first year working on a Go monorepo. The most painful are the ones that are invisible until they cause a production incident or a blocked-mainline CI. The most common first mistake is not implementing affected-change detection: CI "works" because the codebase is small, then 6 months later a 50-service repo has 45-minute CI times and "fixing CI" becomes a multi-week platform project.

Read this table as a checklist before starting a new monorepo project. If you cannot answer how you will address each row, you will encounter it eventually. The `go.work.sum` entry is worth special attention: a missing `go.work.sum` causes non-reproducible builds that fail intermittently in CI and work locally, which is one of the most time-consuming debugging experiences a junior engineer can encounter.

### Senior @ FAANG: Systemic Prevention Over Reactive Fixes

Each mistake in this table can be prevented by a systemic control rather than relying on developer knowledge. Not using `go.work`: enforce this with an onboarding script that checks for its presence. Building all services on every commit: enforce affected detection via a CI requirement, not a convention. No remote cache: block CI pipeline creation without cache configuration in the pipeline template. Circular imports: run the depgraph cycle check as a required PR gate, not an optional developer tool.

The pattern at L6+ is to convert each "common mistake" into a paved road: the default path that engineers take without thinking about it produces the correct outcome. This requires owning the CI pipeline templates, the repository initialization scripts, and the code review checklists that every new service or module inherits. When the paved road is well-maintained, these mistakes stop appearing in post-mortems because they are structurally impossible to make in the normal flow of work.

