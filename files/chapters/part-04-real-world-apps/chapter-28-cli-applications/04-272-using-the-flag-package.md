## 28.2 Using the flag Package

### Basic Flags

This example registers three flags, a string name, an integer count, and a boolean loud, using `flag.String`, `flag.Int`, and `flag.Bool`, then calls `flag.Parse()` to populate them from `os.Args`. Each flag function returns a pointer, so values are dereferenced at the use site rather than copied at registration time. The `flag` package writes usage information to stderr automatically when `-help` is passed or an unknown flag is encountered, which is sufficient for simple single-command tools.

```go
package main

import (
    "flag"
    "fmt"
    "strings"
)

func main() {
    // Define flags
    name := flag.String("name", "World", "name to greet")
    count := flag.Int("count", 1, "number of greetings")
    loud := flag.Bool("loud", false, "greet loudly")

    // Parse command line
    flag.Parse()

    // Use flag values
    for i := 0; i < *count; i++ {
        greeting := fmt.Sprintf("Hello, %s!", *name)
        if *loud {
            greeting = strings.ToUpper(greeting)
        }
        fmt.Println(greeting)
    }
}
```

### Custom Flag Types

Implementing the `flag.Value` interface allows any type to be used as a flag, enabling domain-specific parsing logic such as comma-separated lists, IP addresses, or validated enumerations. The interface requires only `String() string` and `Set(string) error`.

```go
package main

import (
    "flag"
    "fmt"
    "strings"
    "time"
)

// Custom flag type for duration list
type durationList []time.Duration

func (d *durationList) String() string {
    return fmt.Sprint(*d)
}

func (d *durationList) Set(value string) error {
    parts := strings.Split(value, ",")
    for _, part := range parts {
        dur, err := time.ParseDuration(strings.TrimSpace(part))
        if err != nil {
            return err
        }
        *d = append(*d, dur)
    }
    return nil
}

// Custom flag type for log level
type LogLevel int

const (
    LogDebug LogLevel = iota
    LogInfo
    LogWarn
    LogError
)

func (l *LogLevel) String() string {
    switch *l {
    case LogDebug:
        return "debug"
    case LogInfo:
        return "info"
    case LogWarn:
        return "warn"
    case LogError:
        return "error"
    }
    return "unknown"
}

func (l *LogLevel) Set(value string) error {
    switch strings.ToLower(value) {
    case "debug":
        *l = LogDebug
    case "info":
        *l = LogInfo
    case "warn":
        *l = LogWarn
    case "error":
        *l = LogError
    default:
        return fmt.Errorf("invalid log level: %s", value)
    }
    return nil
}

func main() {
    var timeouts durationList
    var logLevel LogLevel

    flag.Var(&timeouts, "timeouts", "comma-separated list of timeouts")
    flag.Var(&logLevel, "log-level", "log level (debug, info, warn, error)")

    flag.Parse()

    fmt.Printf("Timeouts: %v\n", timeouts)
    fmt.Printf("Log Level: %s\n", logLevel.String())
}
```

### Subcommand Pattern

Each subcommand gets its own `flag.FlagSet` created with `flag.NewFlagSet`, allowing independent flag namespaces that do not conflict with flags from other subcommands. The top-level switch on `os.Args[1]` dispatches to the correct FlagSet, which then parses `os.Args[2:]`, the arguments that follow the subcommand name. This approach keeps subcommand logic self-contained and is the foundation of the pattern that Cobra builds on at a larger scale.

```go
package main

import (
    "flag"
    "fmt"
    "os"
)

func main() {
    if len(os.Args) < 2 {
        fmt.Println("expected subcommand: get, set, delete")
        os.Exit(1)
    }

    switch os.Args[1] {
    case "get":
        getCmd := flag.NewFlagSet("get", flag.ExitOnError)
        key := getCmd.String("key", "", "key to get")
        getCmd.Parse(os.Args[2:])
        fmt.Printf("Getting key: %s\n", *key)

    case "set":
        setCmd := flag.NewFlagSet("set", flag.ExitOnError)
        key := setCmd.String("key", "", "key to set")
        value := setCmd.String("value", "", "value to set")
        setCmd.Parse(os.Args[2:])
        fmt.Printf("Setting %s = %s\n", *key, *value)

    case "delete":
        deleteCmd := flag.NewFlagSet("delete", flag.ExitOnError)
        key := deleteCmd.String("key", "", "key to delete")
        force := deleteCmd.Bool("force", false, "force delete")
        deleteCmd.Parse(os.Args[2:])
        fmt.Printf("Deleting key: %s (force: %v)\n", *key, *force)

    default:
        fmt.Printf("Unknown subcommand: %s\n", os.Args[1])
        os.Exit(1)
    }
}
```

### Junior to FAANG: what the flag package teaches you

The standard library `flag` package is intentionally minimal. Using it once, with no framework, is the fastest way to understand what Cobra is actually doing. Every Cobra command owns a `pflag.FlagSet` under the hood, and `pflag` is a POSIX-compliant superset of `flag`. If you can build a three-flag tool with `flag`, you can read Cobra's source.

Worked example. Your team lead asks you to write a one-off migration tool. Do not reach for Cobra. Use `flag`. Ship in 50 lines. The tool lives in `scripts/migrate/main.go` and never needs subcommands. Using Cobra here adds a 3 MB dependency, a 20-file `cmd/` structure, and no user-visible benefit. The skill being assessed is knowing when not to use the big hammer.

Custom flag types as validation gates. The `LogLevel` example is a pattern. Your `Set` method is where you validate. Reject bad input early with a clear error message. A common junior mistake is to accept any string at parse time and validate later in the handler. When validation fails at parse time, the user sees `invalid log level: verbose` before any side effects happen. When it fails at handler time, the user may already have triggered half a deployment.

Interview entry point. "How would you accept both `--retries=3` and `--retries 3` syntax?" The `flag` package supports both natively for non-boolean types. Booleans only accept `=` syntax (`--verbose=true`, not `--verbose true`) because otherwise `--verbose filename` is ambiguous. `pflag` changes these rules. Know the difference and you can explain why your tool's flag parsing behaves differently from another Go tool someone brought to the interview.

### Senior at FAANG: flag design as API design

Every flag you add is a public API surface you must maintain. Staff-level principles.

Naming convention. Prefer long forms as primary (`--output`, not `-o`) with short forms as aliases. Short forms are precious namespace. Reserve `-v` for verbose, `-h` for help, `-o` for output, `-f` for file or force (pick one per tool and document it). `kubectl` does not use `-s` because it conflicted with server and silent in early versions. Audit your short flags against `kubectl`, `docker`, `git`, and `aws` for cross-tool consistency.

Flag grammar. Use `kebab-case` for long flags (`--dry-run`, not `--dryRun` or `--dry_run`). Negatable boolean flags follow the pattern `--foo` and `--no-foo` when both states need to be expressed (because env-var-provided values must be override-able back to false). `pflag` does this automatically with `BoolVar` if you register the flag with a `no-` counterpart, while Cobra has middleware for it.

Env var binding convention. `APPNAME_FLAG_NAME` in upper snake case, with dots from nested commands flattened. In a tool named `myapp`, `myapp get --namespace=foo` binds to `MYAPP_NAMESPACE`. Document the full binding table in your man page. Staff-level rule. Env vars are part of the flag API and subject to the same deprecation policy as flags.

Required flags and mutual exclusion. Cobra provides `MarkFlagRequired` and `MarkFlagsMutuallyExclusive`. At staff level, you want a richer spec. Required unless another flag is set (`--file` or `--stdin`, exactly one). Required when a sibling flag has a specific value (`--auth-type=oauth` requires `--client-id`). Build this validation into a `PreRunE` hook, not scattered across `RunE` handlers, so the rule is one place and testable.

Flag deprecation playbook. When you need to rename `--foo` to `--bar`, keep `--foo` registered, mark it with `cmd.Flags().MarkDeprecated("foo", "use --bar instead, will be removed in v3.0 (2027-Q2)")`, log a warning to stderr when it is used, track usage in telemetry, and only remove after two minor versions and one major version. Document the timeline in the release notes every release, not just at removal. `kubectl` has deprecated flags warning for six years and still has users. Your timeline will not be shorter.

Subcommand pattern governance. The raw `flag.NewFlagSet` subcommand approach does not scale beyond three or four commands. The boundary to Cobra is usually five subcommands or two levels of nesting. At staff level, make this a team policy and codify it. "Tools exceeding N subcommands migrate to Cobra. New multi-team CLIs start on Cobra. Single-purpose internal scripts stay on flag." Document the policy, because junior engineers will invariably pick one or the other based on the last tutorial they read.

Typed config structs as the destination. Do not pass individual `*string` flag pointers around your code. Parse all flags into a single `Config` struct with validated typed fields, and pass that struct to your business logic. The migration from `flag` to Cobra, Kong, or urfave/cli becomes a single-file change in `cmd/`, because `internal/` never imported `flag`. This discipline is what lets `kubectl` migrate between internal parser versions without breaking contributors.

Testing flag parsing. Every flag registration deserves a table test. Run the parser against fixture argv arrays and assert the resulting config struct. When a future contributor renames a flag by accident, the test fails. This is the only durable guard against accidental API breakage, and it takes 10 minutes to write per command.

---
