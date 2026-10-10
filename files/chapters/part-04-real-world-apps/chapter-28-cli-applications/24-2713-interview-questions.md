## 28.13 Interview Questions

### Question 1: How would you design a CLI that works well in both interactive and scripted environments?

**Answer:**
A CLI should support both human users and automated scripts:

**1. Output Modes:**
```go
type CLI struct {
    format      string // table, json, yaml, csv
    isTerminal  bool
    noColor     bool
}

func (c *CLI) Print(data any) {
    if c.format == "json" || !c.isTerminal {
        // Machine-readable output
        json.NewEncoder(os.Stdout).Encode(data)
    } else {
        // Human-friendly output
        c.printTable(data)
    }
}
```

**2. Input Detection:**
```go
func (c *CLI) ReadInput() (string, error) {
    stat, _ := os.Stdin.Stat()
    if (stat.Mode() & os.ModeCharDevice) == 0 {
        // Piped input - read all
        data, err := io.ReadAll(os.Stdin)
        return string(data), err
    }
    // Interactive - prompt
    return c.promptUser()
}
```

**3. Exit Codes:**
- `0` for success
- `1` for general errors
- `2` for usage errors
- Specific codes for specific error types

**4. Signal Handling:**
- Handle SIGINT/SIGTERM for cleanup
- Exit with code 130 on interrupt

**What FAANG expects:** Staff-level engineers at Google, Meta, and Amazon expect you to explicitly separate the human-facing "view" from the machine-facing "data", auto-detect `isatty(stdout)` and switch rendering, honor `NO_COLOR`, stream JSON (NDJSON) for large outputs rather than buffering, and guarantee that `--format json` is schema-stable across minor versions (documented in a JSON Schema or OpenAPI spec). Mention that `kubectl` uses `-o json`/`-o yaml`/`-o jsonpath=` as the prior art.

**Follow-ups:**
- How would you version the JSON output contract so scripts don't break when you add fields? (Additive only, dedicated `api_version` field, never rename keys, deprecate before removal.)
- A user pipes `yourcli list | yourcli delete`. How do you handle streaming input and cancellation mid-pipeline? (Line-buffered NDJSON reader, context cancellation on SIGPIPE, fail-fast on partial success with a summary exit code.)

### Question 2: What's the difference between using flags vs environment variables vs config files?

**Answer:**
Each has different use cases in a precedence hierarchy:

| Method | Use Case | Precedence |
|--------|----------|------------|
| Flags | Per-invocation overrides | Highest |
| Environment | Session/deployment settings | High |
| Local config | Project-specific settings | Medium |
| User config | Personal preferences | Low |
| System config | Organization defaults | Lower |
| Defaults | Compiled defaults | Lowest |

```go
// Viper handles this automatically
func initConfig() {
    // Flags (highest priority) - bound via viper.BindPFlag

    // Environment variables
    viper.SetEnvPrefix("MYAPP")
    viper.AutomaticEnv()

    // Config files (in order of precedence)
    viper.AddConfigPath(".")              // Local
    viper.AddConfigPath("$HOME/.config/myapp") // User
    viper.AddConfigPath("/etc/myapp")     // System

    viper.SetDefault("timeout", "30s")    // Defaults
}

// Access values
timeout := viper.GetDuration("timeout")
```

**What FAANG expects:** Senior candidates are expected to know the precedence chain cold (flag > env > config > default), explain why each layer exists (operator override, deployment, project, user, org, compiled), and explain how to keep secrets out of config files (use env vars or OS keychain, never commit). Bonus points for mentioning `koanf` as a lighter Viper alternative with fewer transitive dependencies, for citing the XDG Base Directory Specification, and for pointing out that Viper's key lookup is case-insensitive, which has caused real production incidents.

**Follow-ups:**
- Your CLI reads a secret from a YAML config. How do you stop it from leaking into `ps aux`, core dumps, and error messages? (Never accept secrets as flags, read from env or a secret file with 0600 perms, zero the memory after use with `runtime.KeepAlive`, redact in error strings.)
- How do you implement config hot-reload without restarting long-running commands? (`fsnotify` watcher, atomic swap behind an `atomic.Pointer[Config]`, validate before swap, emit a structured log event.)

### Question 3: How do you implement shell completions for a CLI?

**Answer:**
Shell completions improve UX dramatically. With Cobra:

```go
// Static completions - predefined values
var cmdRun = &cobra.Command{
    Use:       "run [environment]",
    ValidArgs: []string{"dev", "staging", "prod"},
    // ...
}

// Dynamic completions - fetched at runtime
var cmdGet = &cobra.Command{
    Use: "get [resource]",
    ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
        if len(args) != 0 {
            return nil, cobra.ShellCompDirectiveNoFileComp
        }

        // Fetch available resources dynamically
        resources, err := api.ListResources()
        if err != nil {
            return nil, cobra.ShellCompDirectiveError
        }

        return resources, cobra.ShellCompDirectiveNoFileComp
    },
}

// Flag completions
func init() {
    cmdRun.Flags().StringP("format", "f", "table", "output format")
    cmdRun.RegisterFlagCompletionFunc("format", func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
        return []string{"table", "json", "yaml", "csv"}, cobra.ShellCompDirectiveNoFileComp
    })
}
```

**Installation:**
```bash
# Bash
myapp completion bash > /etc/bash_completion.d/myapp

# Zsh
myapp completion zsh > "${fpath[1]}/_myapp"

# Fish
myapp completion fish > ~/.config/fish/completions/myapp.fish
```

**What FAANG expects:** Strong candidates know that Cobra's completion hook is called from a child process spawned by the shell, so it must return in under 100ms or users will perceive tab as broken. That means completions must never do uncached network calls, prefer a local index refreshed by a background command (`yourcli cache refresh`), and must degrade gracefully when the API is down (return `cobra.ShellCompDirectiveError` without a traceback). Also expected: explaining why `kubectl` caches discovery info for this exact reason.

**Follow-ups:**
- How would you complete flag values that depend on another flag's value (e.g. `--namespace` completions depend on `--cluster`)? (Read the already-parsed flag inside `ValidArgsFunction` via `cmd.Flags().GetString`.)
- A user complains that zsh completions double-tab reveal stale data. What's your fix? (Invalidate completion cache on mutation commands, add a `--no-cache` flag, or use `ShellCompDirectiveNoSpace` carefully to control re-completion behavior.)

### Question 4: How do you test CLI applications effectively?

**Answer:**
CLI testing requires multiple levels:

**1. Unit Tests - Test individual commands:**
```go
func TestGetCommand(t *testing.T) {
    cmd := rootCmd
    buf := new(bytes.Buffer)
    cmd.SetOut(buf)
    cmd.SetErr(buf)
    cmd.SetArgs([]string{"get", "mykey"})

    err := cmd.Execute()
    assert.NoError(t, err)
    assert.Contains(t, buf.String(), "expected value")
}
```

**2. Integration Tests - Test the compiled binary:**
```go
func TestCLIIntegration(t *testing.T) {
    // Build binary
    binary := buildTestBinary(t)
    defer os.Remove(binary)

    // Run command
    cmd := exec.Command(binary, "get", "mykey")
    output, err := cmd.CombinedOutput()

    assert.NoError(t, err)
    assert.Contains(t, string(output), "expected value")
}
```

**3. Golden File Tests - Compare against expected output:**
```go
func TestOutputFormat(t *testing.T) {
    output := runCommand(t, "list", "--format", "json")

    golden := filepath.Join("testdata", t.Name()+".golden")
    if *update {
        os.WriteFile(golden, output, 0644)
    }

    expected, _ := os.ReadFile(golden)
    assert.Equal(t, expected, output)
}
```

**What FAANG expects:** At senior level, testing a CLI means testing all three layers: (1) pure functions with table tests and 90%+ coverage, (2) Cobra command wiring with `cmd.SetArgs` and in-memory buffers (no `os.Exit`, always `RunE`), (3) end-to-end against the compiled binary via `exec.Cmd` in a `testscript` harness (`github.com/rogpeppe/go-internal/testscript`). Expect to discuss golden files with an `-update` flag, deterministic output (strip timestamps, sort map keys), and how to test interactive prompts using a pseudo-TTY (creack/pty) or by abstracting `io.Reader`/`io.Writer` behind an interface.

**Follow-ups:**
- Your CLI calls a remote API. How do you test it hermetically without network? (Dependency-inject an `http.Client` with a `RoundTripper` mock, or stand up an `httptest.Server` in a `TestMain`.)
- A flaky test passes locally but fails in CI with different output ordering. What are the top three causes? (Map iteration order, goroutine scheduling, locale/timezone differences, fix with sorted output, synchronization, and `time.UTC`/`LANG=C` in CI.)

### Question 5: What are the best practices for error handling in CLIs?

**Answer:**
CLI error handling should be user-friendly and script-friendly:

```go
// 1. Structured errors with codes
type CLIError struct {
    Message  string
    Code     int
    Cause    error
    Hint     string // Suggestions for fixing
}

func (e *CLIError) Error() string { return e.Message }

// 2. User-friendly error display
func handleError(err error) {
    var cliErr *CLIError
    if errors.As(err, &cliErr) {
        fmt.Fprintf(os.Stderr, "Error: %s\n", cliErr.Message)
        if cliErr.Hint != "" {
            fmt.Fprintf(os.Stderr, "Hint: %s\n", cliErr.Hint)
        }
        os.Exit(cliErr.Code)
    }

    // Unknown error
    fmt.Fprintf(os.Stderr, "Error: %v\n", err)
    os.Exit(1)
}

// 3. Common error patterns
func notFound(resource string) error {
    return &CLIError{
        Message: fmt.Sprintf("%s not found", resource),
        Code:    3,
        Hint:    fmt.Sprintf("Run 'mycli list' to see available %ss", resource),
    }
}

func permissionDenied(action string) error {
    return &CLIError{
        Message: fmt.Sprintf("permission denied: %s", action),
        Code:    4,
        Hint:    "Check your credentials with 'mycli auth status'",
    }
}
```

**What FAANG expects:** Principal-level answers separate three audiences: (1) the human staring at the terminal, who needs a short message, a hint, and optionally a docs link, (2) the script parsing stderr, which needs stable exit codes documented in a man page, (3) the observability pipeline, which needs a structured log event with a correlation ID. Expected patterns: `errors.Is`/`errors.As` for typed errors, never print stack traces to users (log them via `--verbose`/`--debug` or `slog`), always write errors to stderr not stdout so pipes keep working, and truncate multi-line vendor errors with a "run with --verbose for full output" hint. Cite `kubectl`'s error UX as the bar.

**Follow-ups:**
- A user's command fails halfway through a batch operation. What's the ideal UX and exit code? (Continue-on-error by default with a summary table, exit code 1 if any failed, add `--fail-fast` for CI, return per-item JSON on `-o json` so automation can recover.)
- How do you surface upstream API errors (rate limits, 5xx, network) without leaking internal details? (Classify with `errors.As` into retryable vs. terminal, show a friendly message plus a `--debug` flag to reveal the underlying error, auto-retry with backoff for transient, never print the raw response body.)

### Junior to FAANG: interview preparation playbook

These five questions cover 80 percent of what you will be asked for a CLI-building role. Memorizing the structure of the answers is more valuable than memorizing code. Structure per question. Start with the principle (one sentence). Name the primary pattern. Give a concrete example from a real tool (kubectl, gh, terraform). Mention one failure mode you have seen. Conclude with the tradeoff.

Question 1 rehearsed answer template. "Principle. A CLI serves two audiences, humans and scripts. Pattern. TTY detection switches output format, and NO_COLOR env var disables color. Example. kubectl defaults to table for humans and takes -o json for scripts. Failure mode. Stdout pollution with progress messages breaks pipes. Tradeoff. Rich interactive output versus stable scriptable output, so we separate stdout (data) from stderr (progress)."

This structure signals staff-level thinking. A junior gives code. A staff engineer gives principle, pattern, example, failure, tradeoff. Drill this until it is automatic.

Interviewer heuristics. When you mention NO_COLOR, XDG Base Directory, exit code conventions, signal handling, golden file testing, and SLSA provenance in the same screen, you have signaled senior-level exposure. The interviewer will adjust to harder questions. When you mention none of these, they stay at junior level. Knowing what vocabulary to deploy is itself a signal.

Common follow-ups you should prepare for. How do you version your CLI output contract. How do you handle secrets in config files. How do you ship to Windows and macOS. How do you handle signal cleanup in a long-running command. How do you test a CLI without spawning a subprocess. How do you generate shell completions. How do you distribute a Go binary. How do you sign releases. Each of these deserves a prepared 90-second answer.

### Senior at FAANG: interview signal you are the CLI staff engineer

Staff and principal interviews probe for platform thinking. The questions sound similar to junior questions but expect org-level answers.

Variant of Question 1 at staff level. "How would you roll out a standardized CLI framework across 40 teams in our org." Expected answer. Publish an ADR establishing conventions. Build a shared framework module with telemetry, config, output, prompt packages. Migrate 3 pilot teams, measure impact, iterate. Create a CLI platform team with 3 FTEs. Publish a grammar style guide. Enforce via linters and code review. Set up a monthly CLI review where teams demo their new tools to the platform team. Measure binary size, startup time, and help text coverage across all tools. Publish a leaderboard.

Variant of Question 2. "A user's script breaks because we renamed a flag. How do you prevent this." Staff answer. Flags are API. Add a deprecation policy to the contributing guide. Ban flag removal in patch releases. Require deprecation warning in minor releases. Allow removal only in major releases after 2 minor versions of warning. Enforce with a CI check that diffs the Cobra tree against the previous release and fails on removed flags. Publish a deprecation timeline for external users. Run a survey to measure user pain before the removal.

Variant of Question 3. "Our CLI has 200 subcommands and shell completion now takes 2 seconds. How do you fix." Staff answer. Profile the completion path. Likely causes. Cobra's tree traversal is linear (acceptable up to 1000 commands). Heavy imports in PreRunE even during completion. Network calls in dynamic completions. Fixes. Use build tags to exclude heavy imports from completion path. Cache dynamic completion results in XDG_CACHE_HOME with short TTL. Skip PreRunE entirely when in completion mode. Set a 200ms budget and enforce in CI.

Variant of Question 4. "How do you ensure backwards compatibility for a CLI with millions of users." Staff answer. Three layers of testing. Unit tests for logic. Cobra tests for wiring. Compatibility harness that runs old argv invocations, old config files, and validates old JSON outputs against current code. When a PR introduces a breaking change, the harness fails and the author must update the harness in the same PR, making the break visible in review. Semver enforced. Major version bumps require an RFC 4 weeks ahead. Deprecation timeline published.

Variant of Question 5. "Our users complain that error messages are cryptic. How do you fix this at scale." Staff answer. Audit current error corpus. Group by root cause. For each group, define error type, user-friendly message, actionable hint, docs link, and exit code. Codify in an error catalog. Ban ad-hoc `fmt.Errorf` in review. Require errors to wrap one of the catalog types. Telemetry tags errors by catalog ID to measure which errors hit users most. Iterate on UX for top-10 errors quarterly.

Interview signal to distinguish L5 from L6. An L5 can answer each question with good patterns. An L6 answers with platform, governance, and cross-org impact. L7 principal adds multi-year roadmap and trade-offs against other developer productivity investments. When you reach for "here is the ADR I would write" and "here is the telemetry I would add to measure success" as default framing, you are signaling L6 plus. When you reach for "here is how I would partner with the security team and the SRE team to ship this" you are signaling principal.

Additional questions to prepare for at staff level. How would you implement a plugin system for our CLI. How do you handle rollback for a bad release on Homebrew. How do you reduce binary size from 80 MB to 30 MB. How do you add telemetry without violating user privacy. How do you migrate from one CLI parser to another across 20 tools. How do you enforce grammar consistency across teams. How do you handle internationalization of help text. How do you support enterprise users who need policy enforcement.

Archetypes that shine in CLI interviews. The Standards Keeper who has published flag grammar guides. The Platform Builder who has shipped framework modules. The Migration Shepherd who has run multi-quarter deprecation programs. The DX Engineer who has owned completion and docs pipelines. Match your narrative to the archetype that fits your experience. Interviewers map candidates to one of these archetypes implicitly.

What interviewers are really looking for. Taste. Can you articulate why one CLI design is better than another. Judgment. When you face a tradeoff, can you explain the factors. Scope. Can you think beyond one tool to a fleet of tools. Track record. Can you cite specific decisions you made and their outcomes. Preparation for the CLI interview is mostly preparation for articulating these four things, not memorizing code.

---
