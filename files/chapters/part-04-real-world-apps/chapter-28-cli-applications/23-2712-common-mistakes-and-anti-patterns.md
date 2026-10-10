## 28.12 Common Mistakes and Anti-Patterns

### Mistake 1: Not Supporting Piped Input

**Problem:**
```go
// WRONG: Only reads from interactive input
func main() {
    reader := bufio.NewReader(os.Stdin)
    fmt.Print("Enter name: ")
    name, _ := reader.ReadString('\n')
    process(name)
}

// Fails when piped: echo "Alice" | mycli
```

**Solution:**
```go
// CORRECT: Support both interactive and piped input
func main() {
    stat, _ := os.Stdin.Stat()
    isPiped := (stat.Mode() & os.ModeCharDevice) == 0

    var name string
    if isPiped {
        // Read all piped input
        data, _ := io.ReadAll(os.Stdin)
        name = strings.TrimSpace(string(data))
    } else {
        // Interactive prompt
        reader := bufio.NewReader(os.Stdin)
        fmt.Print("Enter name: ")
        name, _ = reader.ReadString('\n')
        name = strings.TrimSpace(name)
    }

    process(name)
}
```

### Mistake 2: Writing Progress/Status to stdout

**Problem:**
```go
// WRONG: Progress output mixed with data
func process() {
    fmt.Println("Processing...") // Goes to stdout
    for i := 0; i < 100; i++ {
        fmt.Printf("Progress: %d%%\n", i)
    }
    fmt.Println(result) // Actual data
}

// Breaks when piped: mycli | jq .
```

**Solution:**
```go
// CORRECT: Progress to stderr, data to stdout
func process() {
    fmt.Fprintln(os.Stderr, "Processing...") // stderr for progress
    for i := 0; i < 100; i++ {
        fmt.Fprintf(os.Stderr, "Progress: %d%%\r", i)
    }
    fmt.Fprintln(os.Stderr) // Clear progress line

    fmt.Println(result) // Only data goes to stdout
}
```

### Mistake 3: Hardcoding Colors Without Terminal Detection

**Problem:**
```go
// WRONG: Always outputs ANSI codes
func printError(msg string) {
    fmt.Printf("\033[31mError: %s\033[0m\n", msg)
}

// Produces garbage when piped or in non-terminal environments
```

**Solution:**
```go
// CORRECT: Check terminal and NO_COLOR environment
var (
    isTerminal = term.IsTerminal(int(os.Stdout.Fd()))
    noColor    = os.Getenv("NO_COLOR") != ""
)

func printError(msg string) {
    if isTerminal && !noColor {
        fmt.Printf("\033[31mError: %s\033[0m\n", msg)
    } else {
        fmt.Printf("Error: %s\n", msg)
    }
}
```

### Mistake 4: Not Handling Ctrl+C Gracefully

**Problem:**
```go
// WRONG: No signal handling
func main() {
    for {
        processItem() // Creates temp files, holds locks
    }
}

// Ctrl+C leaves temp files, doesn't release locks
```

**Solution:**
```go
// CORRECT: Handle signals for cleanup
func main() {
    ctx, cancel := context.WithCancel(context.Background())

    sigCh := make(chan os.Signal, 1)
    signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

    go func() {
        <-sigCh
        fmt.Fprintln(os.Stderr, "\nInterrupted, cleaning up...")
        cancel()
    }()

    for {
        select {
        case <-ctx.Done():
            cleanup()
            os.Exit(130) // 128 + SIGINT
        default:
            if err := processItem(ctx); err != nil {
                if ctx.Err() != nil {
                    break
                }
                fmt.Fprintln(os.Stderr, "Error:", err)
            }
        }
    }
}
```

### Mistake 5: Ignoring Exit Codes

**Problem:**
```go
// WRONG: Always exits 0
func main() {
    if err := run(); err != nil {
        fmt.Println("Error:", err)
        return // Exit code 0
    }
}
```

**Solution:**
```go
// CORRECT: Use meaningful exit codes
const (
    ExitSuccess       = 0
    ExitFailure       = 1
    ExitUsageError    = 2
    ExitNotFound      = 3
    ExitPermission    = 4
    ExitInterrupted   = 130
)

func main() {
    if err := run(); err != nil {
        fmt.Fprintln(os.Stderr, "Error:", err)

        var exitErr *ExitError
        if errors.As(err, &exitErr) {
            os.Exit(exitErr.Code)
        }
        os.Exit(ExitFailure)
    }
}

type ExitError struct {
    Code    int
    Message string
}

func (e *ExitError) Error() string { return e.Message }
```

### Junior to FAANG: mistakes you will make and catch

All five mistakes above are ones you will make in your first three CLIs. That is not a failure, it is a learning curve. The skill is in reviewing your own tool with a critical eye and catching each one before users do.

Pre-release checklist to run mentally. Pipe the tool to `head`. Does it break. Redirect stdout to a file. Does color leak in. Run in a Docker container without TTY. Does it hang. Hit Ctrl+C mid-command. Do temp files remain. Fail intentionally. Is the exit code non-zero. If any answer is wrong, fix before shipping.

Mistake 6 you will also hit. Swallowing errors from deferred writes. `defer w.Flush()` without checking the error. On disk-full, the flush fails and data is lost silently. Staff code review catch. Wrap flush in a helper that records the error into the outer function's return.

Mistake 7. Passing user input directly to `exec.Command`. Shell injection. Always use argument lists, never string concatenation. `exec.Command("git", "log", user_input)` is safe. `exec.Command("sh", "-c", "git log " + user_input)` is not.

Interview entry point. "What are the top 3 mistakes in Go CLIs?" Name piped input, stdout pollution, and missing signal handling. Bonus. Explain how each manifests in production and how to detect.

### Senior at FAANG: anti-patterns as systemic risk

Staff concerns. Each anti-pattern has an organizational vector.

Anti-pattern 1. Copy-paste CLI structure. Every team writes their own boilerplate for TTY detection, color handling, exit codes. Drift ensues. One team handles `NO_COLOR`, another does not. Solution. A shared framework module the platform team owns. Make it the only way to build CLIs in the org.

Anti-pattern 2. Output format bifurcation. Human output and machine output drift until `--output=json` is missing fields that the table has. Solution. Single source of truth for the data model. Both formatters render from the same struct. Contract tests validate every field is reachable in every format.

Anti-pattern 3. Ad-hoc config loading. Each command calls `viper.GetString("foo")` directly. Refactoring the config schema requires touching every command. Solution. One typed config struct loaded once in `PersistentPreRunE`, passed via context or constructor. Commands receive typed fields.

Anti-pattern 4. Silent success. A command that prints nothing on success is ambiguous. Did it work. Did it skip. Did it fail. Solution. Always print something on success (even if brief). Never leave the user guessing. `kubectl apply` prints `resource X configured`. Adopt the pattern.

Anti-pattern 5. Blocking on network in `PreRunE`. A config fetch or auth refresh during startup hangs the CLI when the network is slow. Solution. Time-box network operations with `context.WithTimeout`. Cache credentials. Fall back to cached values on failure with a warning.

Anti-pattern 6. `os.Exit` in library code. Any `os.Exit` outside `main` means the caller cannot override, tests cannot run, and deferred cleanups skip. Solution. Return errors, let `main` exit. Enforce with a custom linter.

Anti-pattern 7. Global state for dependencies. `var client = http.DefaultClient` in a command file. Testing requires monkeypatching globals. Solution. Pass dependencies via constructor. `newCommand(Deps{Client: httpClient})`. Explicit is testable.

Anti-pattern 8. Breaking machine output in a patch release. Removing a field, renaming a field, changing a field type. Solution. Versioned output schemas. Breaking changes require a major bump. CI validates every merge against the schema registry.

Anti-pattern 9. Inconsistent flag naming across commands. `--env`, `--environment`, `--stage`, `--stage-name` all meaning the same thing in different subcommands. Solution. A flag glossary in the contributing guide. Reviewers enforce. New flags are cross-referenced against the glossary.

Anti-pattern 10. Undocumented environment variables. A team member adds `DEBUG=1` behavior for their own use. It ships to prod. Solution. Every env var registered in a central manifest. `mycli help env-vars` lists them all. Undeclared env vars flagged in code review.

Anti-pattern 11. Leaking secrets in error messages. `connection failed: token xxx expired`. Users paste errors into GitHub issues. Secrets leak. Solution. A redaction layer in the error formatter that masks known secret patterns. Test it. Audit it.

Anti-pattern 12. Hostile interactivity in CI. A prompt that appears in CI because TTY detection is flawed. CI hangs. The fix is always the same. Detect `CI=true`, `$BUILDKITE`, `$JENKINS_URL`, `$GITHUB_ACTIONS`. If any is set, default to non-interactive and refuse to prompt.

Anti-pattern 13. Assumptions about process lifetime. A CLI that opens a DB connection in `init()` and leaks it on fast paths. Solution. Lazy initialization. Defer expensive setup until the handler that needs it runs. Close explicitly in `PersistentPostRunE`.

Anti-pattern 14. Missing observability. When the CLI misbehaves in production, you have no telemetry to debug. Solution. Structured logging to `$XDG_STATE_HOME/myapp/logs/` in verbose mode. Optional telemetry (opt-in, anonymized) for exit codes and durations. Aggregate at a central dashboard for macro insights.

Anti-pattern 15. No versioning in output. `mycli list --output=json` emits `[{...}]` with no envelope. Downstream consumers cannot detect schema changes. Solution. Always wrap in `{"apiVersion": "v1", "kind": "UserList", "items": [...]}`. Document the envelope format. Version it.

Maturity model for avoiding anti-patterns. Level 1. Know the common five. Level 2. Automate detection with linters. Level 3. Share framework modules across org. Level 4. Contract testing and schema validation. Level 5. Organizational governance, ADRs, and continuous retrospectives.

---
