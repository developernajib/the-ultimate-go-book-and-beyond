## CLI Application Architecture

The architecture diagram below illustrates how user input flows through argument parsing, command routing, configuration resolution, and ultimately into the business logic layer. Understanding this layered model helps identify where to add cross-cutting concerns such as logging, telemetry, and error handling.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        CLI APPLICATION ARCHITECTURE                             │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  User Input                                                                     │
│       │                                                                         │
│       ▼                                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         Shell Layer                                     │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │    │
│  │  │     Bash        │  │      Zsh        │  │   PowerShell    │          │    │
│  │  │  Completions    │  │  Completions    │  │  Completions    │          │    │
│  │  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘          │    │
│  │           └────────────────────┼────────────────────┘                   │    │
│  │                                │                                        │    │
│  │                                ▼                                        │    │
│  │                    ┌───────────────────────┐                            │    │
│  │                    │   Argument Parsing    │                            │    │
│  │                    │  (os.Args, flags)     │                            │    │
│  │                    └───────────┬───────────┘                            │    │
│  └────────────────────────────────┼────────────────────────────────────────┘    │
│                                   │                                             │
│                                   ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                      Command Router (Cobra/Kong)                        │    │
│  │                                                                         │    │
│  │   myapp                                                                 │    │
│  │     ├── config                                                          │    │
│  │     │     ├── get                                                       │    │
│  │     │     ├── set                                                       │    │
│  │     │     └── list                                                      │    │
│  │     ├── run                                                             │    │
│  │     │     └── [flags: --env, --verbose, --dry-run]                      │    │
│  │     ├── deploy                                                          │    │
│  │     │     └── [args: environment] [flags: --force, --version]           │    │
│  │     └── version                                                         │    │
│  │                                                                         │    │
│  └────────────────────────────────┬────────────────────────────────────────┘    │
│                                   │                                             │
│                                   ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                        Configuration Layer                              │    │
│  │                                                                         │    │
│  │  Priority (highest to lowest):                                          │    │
│  │  ┌──────────────────────────────────────────────────────────────────┐   │    │
│  │  │ 1. Command-line flags    (--server=api.example.com)              │   │    │
│  │  ├──────────────────────────────────────────────────────────────────┤   │    │
│  │  │ 2. Environment variables (MYAPP_SERVER=api.example.com)          │   │    │
│  │  ├──────────────────────────────────────────────────────────────────┤   │    │
│  │  │ 3. Config file (local)   (./myapp.yaml)                          │   │    │
│  │  ├──────────────────────────────────────────────────────────────────┤   │    │
│  │  │ 4. Config file (user)    (~/.config/myapp/config.yaml)           │   │    │
│  │  ├──────────────────────────────────────────────────────────────────┤   │    │
│  │  │ 5. Config file (system)  (/etc/myapp/config.yaml)                │   │    │
│  │  ├──────────────────────────────────────────────────────────────────┤   │    │
│  │  │ 6. Default values        (compiled into binary)                  │   │    │
│  │  └──────────────────────────────────────────────────────────────────┘   │    │
│  │                                                                         │    │
│  └────────────────────────────────┬────────────────────────────────────────┘    │
│                                   │                                             │
│                                   ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                         Business Logic                                  │    │
│  │                                                                         │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐          │    │
│  │  │    Services     │  │   Validators    │  │   Transformers  │          │    │
│  │  │                 │  │                 │  │                 │          │    │
│  │  │ - API Client    │  │ - Input Check   │  │ - Format Output │          │    │
│  │  │ - File Manager  │  │ - Schema Valid  │  │ - Parse Input   │          │    │
│  │  │ - DB Client     │  │ - Auth Check    │  │ - Encode/Decode │          │    │
│  │  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘          │    │
│  │           └────────────────────┼────────────────────┘                   │    │
│  │                                │                                        │    │
│  └────────────────────────────────┼────────────────────────────────────────┘    │
│                                   │                                             │
│                                   ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                          Output Layer                                   │    │
│  │                                                                         │    │
│  │  ┌───────────────────────────────────────────────────────────────────┐  │    │
│  │  │                     Output Formatter                              │  │    │
│  │  │                                                                   │  │    │
│  │  │  Terminal?  ──Yes──► ┌────────────────────────────────────────┐   │  │    │
│  │  │      │               │ Rich Output                            │   │  │    │
│  │  │      │               │ - Colors (ANSI)                        │   │  │    │
│  │  │      │               │ - Tables (aligned)                     │   │  │    │
│  │  │      │               │ - Progress bars                        │   │  │    │
│  │  │      │               │ - Spinners                             │   │  │    │
│  │  │      │               └────────────────────────────────────────┘   │  │    │
│  │  │      │                                                            │  │    │
│  │  │     No───────────► ┌────────────────────────────────────────┐     │  │    │
│  │  │                    │ Machine Output                         │     │  │    │
│  │  │                    │ - JSON (--output json)                 │     │  │    │
│  │  │                    │ - YAML (--output yaml)                 │     │  │    │
│  │  │                    │ - CSV  (--output csv)                  │     │  │    │
│  │  │                    │ - Plain text (pipe-friendly)           │     │  │    │
│  │  │                    └────────────────────────────────────────┘     │  │    │
│  │  └───────────────────────────────────────────────────────────────────┘  │    │
│  │                                                                         │    │
│  │  stdout ◄──── Success output, data, results                             │    │
│  │  stderr ◄──── Errors, warnings, debug info                              │    │
│  │                                                                         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                 │
├─────────────────────────────────────────────────────────────────────────────────┤
│                           EXIT CODES                                            │
│                                                                                 │
│   0   Success                  127  Command not found                           │
│   1   General error            128  Invalid exit argument                       │
│   2   Misuse of command        130  Script terminated by Ctrl+C (128+SIGINT)    │
│   126 Permission problem       137  Process killed (128+SIGKILL)                │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘

                        INTERACTIVE MODE FLOW

┌─────────────────────────────────────────────────────────────────────────────────┐
│                                                                                 │
│   ┌─────────────────────────────────────────────────────────────────────────┐   │
│   │                          REPL Loop                                      │   │
│   │                                                                         │   │
│   │    ┌──────┐     ┌────────┐     ┌─────────┐     ┌──────────┐             │   │
│   │    │Prompt│────►│  Read  │────►│  Parse  │────►│ Execute  │             │   │
│   │    │  >   │     │ Input  │     │ Command │     │ Command  │             │   │
│   │    └──────┘     └────────┘     └─────────┘     └────┬─────┘             │   │
│   │        ▲                                            │                   │   │
│   │        │                                            ▼                   │   │
│   │        │        ┌────────────────────────────────────────┐              │   │
│   │        │        │            Print Output                │              │   │
│   │        └────────│   (or error, then continue loop)       │              │   │
│   │                 └────────────────────────────────────────┘              │   │
│   │                                                                         │   │
│   │   Special commands: help, exit, quit, history, clear                    │   │
│   │                                                                         │   │
│   └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### Junior to FAANG: reading the architecture layers

The diagram is not abstract. Each box maps to a Go package you will create on day one of a real tool. Shell layer. A `completions` subcommand that emits static scripts. Argument parsing. The `cmd/` directory with one file per top-level command. Command router. The `root.go` file constructing a `*cobra.Command` tree. Configuration layer. An `internal/config` package returning a typed struct. Business logic. `internal/service`, `internal/client`, `internal/repo`. Output layer. `internal/output` with a `Formatter` interface.

Worked example tracing a single invocation. A user types `myapp deploy staging --force`. The shell expands nothing (no globs). Go runtime populates `os.Args`. Cobra walks the command tree, finds `deploy`, binds `staging` as a positional, and sets `--force` on the flag set. The `PreRunE` hook loads config, applying precedence (flag over env over file over default). The `RunE` hook calls `service.Deploy(ctx, service.DeployRequest{Env: "staging", Force: true})`. The returned result is passed to `output.Formatter.Write(os.Stdout, result)`, which chooses table or JSON based on `--output`. Any error is wrapped with context and returned. `main` converts the error to an exit code and writes to `os.Stderr`.

First-job reality check. Most junior engineers skip the configuration precedence and hardcode a YAML path. This breaks the first time someone runs the tool in Docker (no home directory), in CI (no TTY), or as root (different home). The fix is to use `os.UserConfigDir()` and let the precedence chain degrade gracefully.

Exit code cheat sheet for interviews. 0 success. 1 generic failure. 2 usage error (bad flags). 64 to 78 `sysexits.h` codes if you want BSD-style granularity. 126 found but not executable. 127 not found. 128 plus signal number for signal termination. Reserve 3 to 63 for your application's domain errors and document them in `--help`.

### Senior at FAANG: architecture as contract

The diagram hides the hard parts. At staff level, the architecture document you write includes a **flag ownership matrix** (which team owns which flag, what the deprecation window is, what breaks if the flag disappears), an **output schema registry** (every `-o json` response has a versioned schema stored in a schema repo, validated in CI), a **config precedence ADR** (why flag beats env beats file, with examples of user confusion that led to the ordering), and a **plugin boundary spec** (what syscalls plugins can make, how they are discovered, how signatures are verified).

Configuration layer at scale is not six sources, it is ten. Add remote config fetched from a central service (used by `gcloud` for project defaults), organizational policy config pushed by MDM (used by corporate-managed `aws` installs), feature flags that toggle command availability (some `kubectl` behaviors are gated behind `KUBECTL_`-prefixed environment variables), and credential resolution chains (AWS SDK v2 has eight, each documented). Document precedence in an ADR. Publish a `myapp config debug` subcommand that prints the resolved value and which source it came from, because users will file bugs about "why is my value not taking effect" and you want to answer in one command.

Business logic layer must be framework-free. The rule staff engineers enforce in code review. No `cobra.Command` import outside `cmd/`. No `os.Args`, `os.Getenv`, `os.Stdout` inside `internal/service`. The logic package must be reusable from an HTTP server, a Lambda, a gRPC handler, and a test. This is the single most common violation in junior PRs and the single biggest predictor of whether a CLI can be safely evolved.

Output layer versioning. `kubectl -o json` output format has been stable since 2016 and is a published API subject to Kubernetes deprecation policy. Your tool's JSON output is an API too. Version it. `{"apiVersion": "mytool.io/v1", "kind": "DeployResult", "data": {...}}`. Write a compatibility test suite that decodes old outputs with the new code. When you need a breaking change, introduce `v2` alongside `v1`, let users opt in with `--output-version=v2`, then deprecate `v1` on a published timeline.

Exit code strategy. Reserve ranges and document them. At Google, internal tools follow a convention where 0 is success, 1 is user error, 2 is retriable infrastructure error (CI knows to retry), and 3 is unretriable infrastructure error. At Stripe, CLI exit codes map to alert severities in their observability system. Establish this convention once for your org and audit it in CI with a static check that `os.Exit` is only called from `main` with documented constants.

Interactive mode and accessibility. REPL flows and TUIs must support non-interactive fallback (detect TTY, degrade to one-shot mode when piped), screen reader output (Bubble Tea has `WithAltScreen` disabled mode for this), high-contrast palettes (respect `NO_COLOR` env var per the no-color.org spec), and internationalization of prompts (use `golang.org/x/text/message`). Accessibility is not a nice-to-have at FAANG scale, it is a compliance requirement driven by Section 508 and European Accessibility Act 2025.

ADR template for CLI architecture decisions. Context. Decision. Consequences. Alternatives considered. Rollback plan. Example. "ADR-014: Adopt Cobra over urfave/cli v3. Context: we need nested subcommands, persistent flags, and shell completion generation. Decision: Cobra. Consequences: 3 MB binary increase, tight coupling to spf13 ecosystem. Alternatives: urfave/cli v3 (lighter but weaker completions), Kong (reflection-heavy, slower startup), hand-rolled (rejected, not worth the maintenance). Rollback plan: command definitions are isolated in `cmd/`, a migration to a new parser would rewrite this directory but leave `internal/` untouched." Archive every CLI ADR in the repo so the next staff engineer can reconstruct reasoning.

---
