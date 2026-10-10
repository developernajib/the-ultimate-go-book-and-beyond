## Help
```makefile
help: ## Display this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
```

### .goreleaser.yml - Release Configuration

GoReleaser automates the entire release pipeline: cross-compilation, archive creation, checksum generation, changelog formatting, Homebrew tap updates, Linux package builds (deb/rpm), and Docker image publishing. The YAML configuration below defines each step declaratively. Running `goreleaser release` produces all artifacts and uploads them to the GitHub release.

```yaml
version: 2

project_name: mycli

before:
 hooks:
 - go mod tidy
 - go generate ./...

builds:
 - id: mycli
 main: .
 binary: mycli
 env:
 - CGO_ENABLED=0
 goos:
 - linux
 - darwin
 - windows
 goarch:
 - amd64
 - arm64
 ignore:
 - goos: windows
 goarch: arm64
 ldflags:
 - -s -w
 - -X github.com/yourorg/mycli/internal/version.Version={{.Version}}
 - -X github.com/yourorg/mycli/internal/version.Commit={{.Commit}}
 - -X github.com/yourorg/mycli/internal/version.BuildTime={{.Date}}

archives:
 - id: default
 name_template: >-
 {{ .ProjectName }}_
 {{- .Version }}_
 {{- .Os }}_
 {{- .Arch }}
 format_overrides:
 - goos: windows
 formats: [zip]

checksum:
 name_template: "checksums.txt"

changelog:
 sort: asc
 filters:
 exclude:
 - "^docs:"
 - "^test:"
 - "^ci:"
 - "^chore:"

brews:
 - repository:
 owner: yourorg
 name: homebrew-tap
 homepage: https://github.com/yourorg/mycli
 description: A professional CLI application
 license: MIT
 install: |
 bin.install "mycli"
 bash_completion.install "completions/mycli.bash" => "mycli"
 zsh_completion.install "completions/mycli.zsh" => "_mycli"

nfpms:
 - id: packages
 package_name: mycli
 vendor: YourOrg
 homepage: https://github.com/yourorg/mycli
 maintainer: Your Name <your@email.com>
 description: A professional CLI application
 license: MIT
 formats:
 - deb
 - rpm
 bindir: /usr/bin

dockers:
 - image_templates:
 - "yourorg/mycli:{{ .Version }}"
 - "yourorg/mycli:latest"
 dockerfile: Dockerfile
 build_flag_templates:
 - "--pull"
 - "--label=org.opencontainers.image.created={{.Date}}"
 - "--label=org.opencontainers.image.revision={{.FullCommit}}"
 - "--label=org.opencontainers.image.version={{.Version}}"
```

### Junior to FAANG: help as discoverability

The `make help` one-liner is clever awk. It parses Makefile comments in the `target: ## description` pattern and renders a colorized list. This is a common Go project convention. Adopt it. New contributors running `make help` immediately see what is buildable, testable, runnable, without reading the Makefile source.

The `.DEFAULT_GOAL := help` means bare `make` prints help. Smart default. Bare `make` otherwise runs the first target, which is often the build, which can be slow and surprising.

For the CLI itself, `--help` is the primary docs surface. Every command's `Short` and `Long` fields must be populated. Every flag's description must explain what it does in one sentence. Users who cannot figure out a command from `--help` will not read the docs site.

### Senior at FAANG: help text as user contract

Staff concerns. Help text is part of the public API. Changes to flag descriptions, command `Long` text, and example sections must be reviewed with the same rigor as code. A lint rule fails PRs that add commands without complete help.

Examples section. Every non-trivial command has an Example block showing realistic invocations. `kubectl` has hundreds. `gh` has dozens. Users copy and paste from Examples more than any other part of docs. Invest here.

Generated documentation parity. `--help` output must match the online docs. Generate both from the same Cobra tree. A CI check diffs generated docs against the repo and fails on drift. Without this check, docs drift, users hit undocumented flags, and trust erodes.

Man page generation. Cobra generates man pages via `doc.GenManTree`. Ship them in OS packages. Man pages render properly in `man`, `tldr` (via a generator), and IDE doc popups. The staff rule. If your tool is used in server contexts, man pages are not optional.

Internationalization of help. Help text catalog lives in `messages.gotext.json`. Extracted via `gotext -lang=en`. Translated files merged. CLI picks locale from `$LC_ALL`. Japanese, Chinese, German, and Spanish are the typical initial target languages for globally distributed tools.

Accessibility of help output. Help text must render legibly on screen readers. Avoid ASCII art. Do not require color to parse structure (use indentation and blank lines). Staff-level review comment. "Your table of flags uses Unicode box-drawing that VoiceOver reads as gibberish. Use plain indentation."

Search. For tools with many commands, `myapp help search keyword` finds commands by keyword. `git help -g` shows topic guides. Consider both for CLI platforms with 50+ commands. Users cannot remember the exact subcommand name, but they remember keywords.

Version information in help. `myapp version` outputs version, commit, build date, Go version, platform. JSON mode (`myapp version --output=json`) enables programmatic checks. CI pipelines read this to decide whether to upgrade. This is a tiny detail with outsized value in enterprise contexts.

Deprecation notices in help. Deprecated flags show a warning in help output. Deprecated commands hide from the top-level list but still respond to `--help` with the deprecation notice and migration path. Users who find deprecated commands in old scripts must be able to learn how to migrate without filing a support ticket.

Discoverability via `--help-verbose` or `--help-all`. Standard `--help` shows core flags. Verbose help shows all flags including advanced and experimental. `kubectl` does this. The staff rule. Hide noise by default, make it discoverable for power users.

---
