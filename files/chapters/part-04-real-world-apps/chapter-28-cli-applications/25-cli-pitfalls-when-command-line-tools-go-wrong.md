## CLI Pitfalls: When Command-Line Tools Go Wrong

CLI bugs are uniquely painful because they often surface in automated pipelines, deployment scripts, and production runbooks, contexts where a silent failure or unexpected behavior cascades into larger problems. Each pitfall below includes a broken example followed by the corrected version.

### The Destructive Default

**The Problem**: Commands with destructive defaults that cause data loss when users make typos.

```go
// WRONG: Delete without confirmation

var deleteCmd = &cobra.Command{
    Use:   "delete [name]",
    Short: "Delete a resource",
    Run: func(cmd *cobra.Command, args []string) {
        if len(args) == 0 {
            // 🚨 Deletes EVERYTHING when no arg provided
            deleteAll()
            return
        }
        deleteResource(args[0])
    },
}

// User types: mycli delete
// All data gone!
```

```go
// CORRECT: Safe defaults with explicit confirmation

var deleteCmd = &cobra.Command{
    Use:   "delete <name>",
    Short: "Delete a resource",
    Args:  cobra.ExactArgs(1),  // Require argument
    Run: func(cmd *cobra.Command, args []string) {
        name := args[0]

        // Confirm destructive action
        if !force {
            fmt.Printf("Delete %q? This cannot be undone. [y/N]: ", name)
            var response string
            fmt.Scanln(&response)
            if strings.ToLower(response) != "y" {
                fmt.Println("Canceled")
                return
            }
        }

        deleteResource(name)
    },
}

// For batch operations, require explicit flag
var deleteAllCmd = &cobra.Command{
    Use:   "delete-all",
    Short: "Delete all resources",
    Run: func(cmd *cobra.Command, args []string) {
        if !confirm {
            fmt.Println("Add --confirm to delete all resources")
            return
        }
        deleteAll()
    },
}
```

### The Silent Failure

**The Problem**: CLI exits with 0 even when operation failed. Breaks scripts.

```go
// WRONG: Silent failure

func main() {
    err := doOperation()
    if err != nil {
        fmt.Println("Warning:", err)
        // 🚨 Still exits 0! Scripts think it succeeded
    }
}
```

```go
// CORRECT: Proper exit codes

const (
    ExitSuccess        = 0
    ExitGeneralError   = 1
    ExitUsageError     = 2
    ExitNotFound       = 3
    ExitPermission     = 4
    ExitNetwork        = 5
)

func main() {
    if err := run(); err != nil {
        var exitCode int
        switch {
        case errors.Is(err, ErrNotFound):
            exitCode = ExitNotFound
        case errors.Is(err, ErrPermission):
            exitCode = ExitPermission
        case errors.Is(err, ErrNetwork):
            exitCode = ExitNetwork
        default:
            exitCode = ExitGeneralError
        }

        fmt.Fprintln(os.Stderr, "Error:", err)
        os.Exit(exitCode)
    }
}

// Scripts can now: mycli operation || handle_error
```

### The Stdout/Stderr Confusion

**The Problem**: Mixing output streams breaks piping and parsing.

```go
// WRONG: Everything to stdout

func listUsers() {
    fmt.Println("Fetching users...")      // 🚨 Progress message in stdout
    users := getUsers()
    for _, u := range users {
        fmt.Println(u.Name)               // Actual data
    }
    fmt.Println("Done!")                  // 🚨 Status message in stdout
}

// User pipes: mycli list | wc -l
// Gets: 102 (100 users + 2 extra lines)
```

```go
// CORRECT: Separate streams appropriately

func listUsers() {
    // Progress to stderr (not captured by pipe)
    fmt.Fprintln(os.Stderr, "Fetching users...")

    users := getUsers()
    for _, u := range users {
        fmt.Println(u.Name)  // Data to stdout
    }

    fmt.Fprintln(os.Stderr, "Done!")
}

// Better: Detect if stdout is a terminal
func listUsers() {
    isTTY := isatty.IsTerminal(os.Stdout.Fd())

    if isTTY {
        // Interactive: show progress
        spinner.Start("Fetching users...")
    }

    users := getUsers()

    if isTTY {
        spinner.Stop()
    }

    for _, u := range users {
        fmt.Println(u.Name)
    }
}
```

### The Config File Override Confusion

**The Problem**: Unclear precedence between flags, env vars, and config files.

```go
// WRONG: Inconsistent precedence

func loadConfig() {
    // Which one wins? Nobody knows!
    config.Host = viper.GetString("host")  // From config file? Env? Flag?
}

// User sets: HOST=prod in env, --host=dev on command line
// Config file has: host: staging
// Result: ??? (depends on viper setup order)
```

```go
// CORRECT: Clear, documented precedence

// Precedence (highest to lowest):
// 1. Command-line flags
// 2. Environment variables
// 3. Config file
// 4. Defaults

func loadConfig() Config {
    var cfg Config

    // Set defaults first
    cfg.Host = "localhost"
    cfg.Port = 8080

    // Load config file (can be overridden)
    if configFile != "" {
        loadConfigFile(&cfg, configFile)
    }

    // Environment variables override config file
    if host := os.Getenv("MYCLI_HOST"); host != "" {
        cfg.Host = host
    }

    // Flags override everything
    if hostFlag != "" {
        cfg.Host = hostFlag
    }

    return cfg
}

// Document in help:
var rootCmd = &cobra.Command{
    Long: `Configuration precedence (highest to lowest):
1. Command-line flags (--host)
2. Environment variables (MYCLI_HOST)
3. Config file (~/.mycli/config.yaml)
4. Built-in defaults`,
}
```

### The Hanging Process

**The Problem**: CLI hangs forever on network timeout, user can't cancel.

```go
// WRONG: No timeout, ignores Ctrl+C

func fetchData() {
    resp, err := http.Get("http://slow-server/data")  // Hangs forever
    // ...
}
```

```go
// CORRECT: Timeouts and signal handling

func fetchData(ctx context.Context) error {
    // Create cancellable context
    ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
    defer cancel()

    req, _ := http.NewRequestWithContext(ctx, "GET", "http://slow-server/data", nil)

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        if ctx.Err() == context.DeadlineExceeded {
            return fmt.Errorf("request timed out after 30 seconds")
        }
        return err
    }
    defer resp.Body.Close()
    // ...
    return nil
}

func main() {
    // Handle Ctrl+C gracefully
    ctx, cancel := context.WithCancel(context.Background())

    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

    go func() {
        <-sigCh
        fmt.Fprintln(os.Stderr, "\nCancelling...")
        cancel()
    }()

    if err := fetchData(ctx); err != nil {
        if ctx.Err() == context.Canceled {
            fmt.Fprintln(os.Stderr, "Operation canceled")
            os.Exit(130)  // Standard exit code for Ctrl+C
        }
        fmt.Fprintln(os.Stderr, "Error:", err)
        os.Exit(1)
    }
}
```

### Quick Reference: CLI Pitfalls

| Pitfall | Impact | Fix |
|---------|--------|-----|
| Destructive defaults | Data loss | Require confirmation, explicit flags |
| Exit 0 on error | Broken scripts | Proper exit codes |
| Mixed stdout/stderr | Broken piping | Data to stdout, messages to stderr |
| Unclear config precedence | Unexpected behavior | Document: flags > env > file > default |
| No timeout | Hanging CLI | Context with timeout |
| Ignore Ctrl+C | Can't cancel | Signal handling |

### Junior to FAANG: pitfalls in real incidents

Every pitfall above is a post-mortem waiting to happen. Typo-triggered mass deletions and release scripts that exited 0 despite a failed publish have both caused real production incidents, and both trace back to the exact patterns shown above. Learning from these is cheap. Repeating them is career-impacting.

Confirmation prompts have a safer variant. Require the user to type the resource name, not just Y or N. `heroku apps:destroy` makes you type the app name before it proceeds, and GitHub makes you type the full repository name before deleting a repo. Copy this pattern for anything truly destructive.

The stdout stderr separation is not merely hygiene, it is the line between a professional tool and a toy. Run this check on every new command. `mycli somecommand 2>/dev/null | cat`. If you see progress messages, you have the bug. Fix before merging.

Context propagation. Every function that does I/O must accept `ctx context.Context`. No exceptions. A codebase where some functions accept ctx and others do not is a codebase where cancellation works in some places but not others, which is worse than not at all.

### Senior at FAANG: pitfalls as organizational scar tissue

Staff concerns. The pitfalls above are not bugs that slip through. They are patterns that recur every quarter as new teams ship CLIs. Staff engineers prevent them systemically.

Institutional defense against destructive defaults. Mandate that every `delete`, `destroy`, `remove`, `purge`, `rm` subcommand has a required positional argument (refuses to run with none), a confirmation prompt or `--force` flag, audit logging, and an undo or soft-delete where the domain allows. This is codified in the contributing guide. Reviewers enforce.

Exit code observability. Telemetry captures exit code distribution per command per release. A release that increases exit 1 by 10 percent is a regression. Alerting fires. Dashboards let the team spot silent failures introduced by changes. Without telemetry, bad releases ship unnoticed until users complain.

Stdout stderr contracts at the framework layer. The framework's `Formatter` writes data to stdout, the framework's `Logger` writes to stderr, the framework's `Progress` writes to stderr. Commands call these, never `fmt.Println` directly. Enforce with a custom linter. Framework-level defense against an entire class of bugs.

Config precedence as documented spec. Do not leave precedence to viper's defaults. Publish the order explicitly in docs and in `--help`. Provide a debug subcommand that prints the resolved value and its source. `myapp config source endpoint` outputs `endpoint=api.example.com from flag --endpoint`. Users debug config issues in one command instead of filing bugs.

Hanging processes at scale. Any network call without a context timeout is an incident vector. Audit with a custom linter that fails PRs adding `http.Get`, `http.Post`, or any network call without a context. Require `NewRequestWithContext`. Enforce a default client timeout. When the CLI is used in cron jobs that run every minute, a hanging instance slowly exhausts file descriptors and the system degrades without any single obvious cause.

Signal handling at scale. `signal.NotifyContext` has been the idiom since Go 1.16. Wire it once in `Execute`. Every subcommand receives the canceled context. Cancellation cascades through all I/O. A command that does not respect cancellation (ignores ctx in a loop) is a lint-level bug. Catch with a review checklist.

Systematic post-mortem process. When a CLI pitfall causes an incident, write a blameless post-mortem. Identify the root cause (usually one of the six categories above). Write a regression test. Update linter rules to prevent the pattern. Update the contributing guide. Present at a CLI review meeting. Over time, the organization builds immunity to recurring pitfalls.

Kill switches for bad behavior. Publish a version manifest that the CLI checks on startup (with cache and offline fallback). If a released version has a known-destructive bug, the manifest can flag it and the CLI prints a warning urging upgrade. Major CLIs like `gcloud` use the same startup version check to warn users off outdated releases.

Shadow testing for new destructive features. Before a new `delete` command ships, run it in dry-run mode in production with telemetry capturing "would have deleted X, Y, Z." Review the results. If the dry-run telemetry looks reasonable, promote to real delete. This catches scope bugs before users do.

Incident playbook for pitfalls that reach production. Detect via telemetry or user reports. Verify reproducibility. Decide rollback vs hotfix. Communicate via release notes, in-tool warning banner, and developer channels. Ship fix. Post-mortem within 5 business days. Update prevention measures. Rehearse this playbook quarterly. Staff engineers own it.

Maturity model. Level 1. Know the common pitfalls. Level 2. Document them in the contributing guide. Level 3. Enforce via linters and reviews. Level 4. Catch via telemetry post-release. Level 5. Framework-level defenses make most pitfalls impossible by construction.

---
