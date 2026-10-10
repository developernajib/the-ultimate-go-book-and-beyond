## 102O.14 Release Engineering and Semantic Versioning

### Conventional Commits Specification

Conventional Commits is a lightweight convention for commit messages that enables automated tooling to determine the next semantic version and generate changelogs.

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Valid types and their semantic version impact:

| Type | Description | SemVer Impact |
|------|-------------|---------------|
| `feat` | New feature | MINOR bump |
| `fix` | Bug fix | PATCH bump |
| `feat!` or `BREAKING CHANGE:` footer | Breaking change | MAJOR bump |
| `chore` | Maintenance | No release |
| `docs` | Documentation | No release |
| `refactor` | Code restructure | No release |
| `perf` | Performance improvement | PATCH bump |
| `test` | Adding tests | No release |

Examples:

```
feat(auth): add OAuth2 PKCE flow

fix(api): return 422 instead of 500 for invalid JSON body

feat!: remove deprecated v1 endpoints

BREAKING CHANGE: /api/v1/* routes are removed. Migrate to /api/v2/*.

chore(deps): bump github.com/gin-gonic/gin from 1.9.0 to 1.9.1
```

### Automated Changelog with git-cliff

`git-cliff` parses conventional commits and generates a structured `CHANGELOG.md`.

```bash
go install github.com/orhun/git-cliff@latest
```

Configuration file:

```toml
# cliff.toml
[changelog]
header = """
# Changelog\n
All notable changes to this project will be documented in this file.\n
"""
body = """
{% if version %}\
## [{{ version | trim_start_matches(pat="v") }}] - {{ timestamp | date(format="%Y-%m-%d") }}
{% else %}\
## [Unreleased]
{% endif %}\
{% for group, commits in commits | group_by(attribute="group") %}
### {{ group | strtitle }}
{% for commit in commits %}
- {% if commit.scope %}**{{ commit.scope }}**: {% endif %}{{ commit.message }} ([`{{ commit.id | truncate(length=7, end="") }}`]({{ commit.id }}))\
{% endfor %}
{% endfor %}\n
"""
trim = true

[git]
conventional_commits = true
filter_unconventional = true
commit_parsers = [
 { message = "^feat", group = "Features" },
 { message = "^fix", group = "Bug Fixes" },
 { message = "^perf", group = "Performance" },
 { message = "^refactor", group = "Refactoring" },
 { message = "^doc", group = "Documentation", skip = true },
 { message = "^chore", group = "Miscellaneous", skip = true },
]
tag_pattern = "v[0-9]*"
```

### Junior → FAANG: Understanding the Changelog Generation Chain

The content in this file (and the continuation in files 17-18) covers the full release engineering pipeline. Before studying the tooling, understand the chain: conventional commit messages drive `git-cliff` parsing, `git-cliff` computes the next semantic version and generates CHANGELOG content, the release bot opens a PR with both, and the merged PR triggers the final GitHub Release creation. Each link in this chain can be automated or manual. Understanding which links you have automated and which require human decision is the key operational design choice.

For interviews: "how do you automate releases in a monorepo with 20 services?" The answer is per-service tags (`service-name/vX.Y.Z`), conventional commits scoped to each service, and a release bot that watches merged commits, filters by service path, and opens release PRs only for services with unreleased changes.

### Senior @ FAANG: Semantic Versioning Contract and API Stability Governance

Semantic versioning is a contract between library producers and consumers. In a monorepo, the contract is enforced within the same repository, which creates an opportunity that polyrepos cannot exploit: automated API compatibility checking on every PR. Tools like `apidiff` (from `golang.org/x/exp/apidiff`) can compare the public API of a package before and after a change and classify the change as backward-compatible, backward-incompatible, or a new addition. Running this check in CI and requiring a major version bump for backward-incompatible changes enforces the semantic versioning contract without relying on code review.

The governance dimension: who decides what constitutes a breaking change? In a large monorepo, the answer must be codified in a policy document and enforced by tooling, not left to individual judgment. Go's definition of backward-compatible is precise: adding exported identifiers is safe, removing or changing signatures of exported identifiers is breaking, changing behavior without changing signatures is a judgment call that belongs in the release notes. Publishing this policy, including the "judgment call" category and how it is handled, prevents repeated disagreements on individual PRs and gives library teams a clear standard to design against.


