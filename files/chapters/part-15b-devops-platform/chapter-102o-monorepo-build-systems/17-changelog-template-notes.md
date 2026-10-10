## 102O.15 Changelog Templates and Configuration

### Junior → FAANG: Template Syntax as Configuration

The Tera template syntax in `cliff.toml` is the intermediate representation between git commit history and human-readable CHANGELOG. You do not need to master template syntax to use `git-cliff` effectively. The practical skill is understanding how to customize the grouping and filtering: `commit_parsers` maps commit types to CHANGELOG sections, and `skip = true` excludes maintenance commits from the output. Modifying these two configuration blocks covers 95% of changelog customization needs.

For interview context: the relevant concept is "automated release notes from structured commit history." Be able to explain why conventional commits are required as a prerequisite: without a consistent format, the tool cannot classify commits into Features/Bug Fixes/Performance sections.

### Senior @ FAANG: Changelog as Product Documentation

At FAANG scale, CHANGELOG content is not just developer housekeeping. It is product documentation for internal API consumers, input to compliance audit trails, and evidence in incident post-mortems ("what changed in the last 30 days that could have caused this regression?"). This means the quality of CHANGELOG entries is a measurable property with real consequences.

The platform discipline: define and enforce CHANGELOG quality standards through the PR review process and linting. A commit message like `fix: bug` produces a useless CHANGELOG entry. A linter that checks conventional commit message quality (minimum description length, required scope for changes to shared packages) prevents low-quality entries from entering the changelog. Some organizations maintain a "release notes review" step in the release pipeline where a human reviews auto-generated changelog entries before the release PR is merged, catching entries that are technically conventional-commit-compliant but semantically useless. This is a lightweight governance step that significantly improves the signal-to-noise ratio of internal changelogs.

