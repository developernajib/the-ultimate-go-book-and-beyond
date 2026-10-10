## 28.8 Testing CLI Applications

### Testing Commands

Cobra commands can be tested in-process by calling `rootCmd.SetArgs()` with the desired arguments and capturing output through `rootCmd.SetOut()`. This avoids compiling a binary for every test run and gives direct access to the command's return value. Table-driven tests work well here because each case differs only in the argument list and expected outcome.

```go
package cmd

import (
    "bytes"
    "strings"
    "testing"
)

func TestGetCommand(t *testing.T) {
    // Capture output
    buf := new(bytes.Buffer)
    rootCmd.SetOut(buf)
    rootCmd.SetErr(buf)

    // Execute command
    rootCmd.SetArgs([]string{"get", "mykey"})
    err := rootCmd.Execute()

    if err != nil {
        t.Fatalf("Unexpected error: %v", err)
    }

    output := buf.String()
    if !strings.Contains(output, "expected value") {
        t.Errorf("Unexpected output: %s", output)
    }
}

func TestSetCommand(t *testing.T) {
    tests := []struct {
        name    string
        args    []string
        wantErr bool
    }{
        {
            name: "valid set",
            args: []string{"set", "key1", "value1"},
        },
        {
            name:    "missing value",
            args:    []string{"set", "key1"},
            wantErr: true,
        },
        {
            name:    "missing key",
            args:    []string{"set"},
            wantErr: true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            rootCmd.SetArgs(tt.args)
            err := rootCmd.Execute()

            if (err != nil) != tt.wantErr {
                t.Errorf("Execute() error = %v, wantErr %v", err, tt.wantErr)
            }
        })
    }
}
```

### Integration Testing

Integration tests compile the actual binary with `go build` and run it as a subprocess using `os/exec`. This exercises the full startup path, flag parsing, config loading, signal handling, exactly as a user would experience it. The `TestMain` function builds the binary once into a temporary directory, and individual tests invoke it with different arguments.

```go
package main_test

import (
    "os"
    "os/exec"
    "path/filepath"
    "strings"
    "testing"
)

var binary string

func TestMain(m *testing.M) {
    // Build binary
    dir, _ := os.MkdirTemp("", "cli-test")
    binary = filepath.Join(dir, "myapp")

    cmd := exec.Command("go", "build", "-o", binary)
    if err := cmd.Run(); err != nil {
        os.Exit(1)
    }

    code := m.Run()

    os.RemoveAll(dir)
    os.Exit(code)
}

func runCLI(args ...string) (string, error) {
    cmd := exec.Command(binary, args...)
    output, err := cmd.CombinedOutput()
    return string(output), err
}

func TestCLIGet(t *testing.T) {
    // First set a value
    _, err := runCLI("set", "testkey", "testvalue")
    if err != nil {
        t.Fatalf("Failed to set: %v", err)
    }

    // Then get it
    output, err := runCLI("get", "testkey")
    if err != nil {
        t.Fatalf("Failed to get: %v", err)
    }

    if !strings.Contains(output, "testvalue") {
        t.Errorf("Expected testvalue in output, got: %s", output)
    }
}

func TestCLIVersion(t *testing.T) {
    output, err := runCLI("--version")
    if err != nil {
        t.Fatalf("Failed to run --version: %v", err)
    }

    if !strings.Contains(output, "v") {
        t.Errorf("Expected version in output, got: %s", output)
    }
}
```

### Junior to FAANG: testing strategy for CLIs

Three layers, not one. Unit tests for business logic in `internal/`, no CLI framework involved. Command-level tests for argv parsing and routing, using `rootCmd.SetArgs()` as shown. Integration tests for the compiled binary, invoking via `os/exec`. Each layer catches different bugs. Unit tests catch logic errors. Command tests catch flag wiring mistakes. Integration tests catch build problems, init-time failures, and signal handling.

The example above has a bug that bites in real projects. `rootCmd` is a global variable. Across tests in the same package, state leaks. A flag set in one test persists into the next. The staff pattern, which you should adopt from day one, is.

```go
func newRootCmdForTest(t *testing.T) *cobra.Command {
    t.Helper()
    return NewRootCommand(Deps{Store: newFakeStore()})
}
```

Every test constructs a fresh tree. No globals. No leakage. No flaky tests. This takes 30 minutes to refactor on a young project and weeks to refactor on an old one.

Golden file tests. For commands that produce complex output (tables, YAML, JSON), comparing strings with `strings.Contains` misses regressions. The golden file pattern captures expected output in `testdata/get_happy.golden.txt`, runs the command, compares byte-for-byte, and offers a `-update` flag to regenerate. Go standard library idiom.

```go
var update = flag.Bool("update", false, "update golden files")

func TestOutput(t *testing.T) {
    got := runCommand(...)
    goldenPath := filepath.Join("testdata", t.Name()+".golden")
    if *update {
        os.WriteFile(goldenPath, got, 0644)
    }
    want, _ := os.ReadFile(goldenPath)
    if !bytes.Equal(got, want) {
        t.Errorf("output mismatch:\n%s", cmp.Diff(string(want), string(got)))
    }
}
```

This is how `kubectl`, `gh`, and `hugo` test their output. Run `go test -update` after intentional changes, commit the goldens alongside code.

Interview entry point. "How would you test a CLI that makes HTTP calls?" Answer in three layers. Unit test the HTTP client against `httptest.Server`. Command test with an injected client. Integration test against a recorded cassette (`go-vcr`) or a local mock server. The layered approach lets each test fail fast and isolate the real bug.

### Senior at FAANG: test strategy as release gate

Testing at scale is a platform, not a collection of test files. Staff concerns.

Cross-platform test matrix. Every CLI must test on Linux amd64, Linux arm64, macOS amd64, macOS arm64, Windows amd64, and Windows arm64. GitHub Actions supports all six. File path handling, line endings, signal handling, and TTY behavior differ on every OS. A tool that only tests on Linux will ship Windows bugs. The staff rule. The release pipeline blocks if any OS in the matrix fails. If you cannot run Windows tests, you should not ship a Windows binary.

Golden files with OS-aware diffs. Line endings differ (`\n` vs `\r\n`), path separators differ (`/` vs `\`), color codes differ when TERM differs. Golden tests must normalize. Either disable color and force `TERM=dumb`, or have per-OS golden files. The latter is maintenance overhead, the former is the default choice.

Contract testing for machine output. Every `--output=json` emitter must be validated against its schema in every test run. A JSON Schema validator runs over golden files. When the schema changes, you know every affected test. When a test produces output not matching the schema, CI fails.

Fault injection testing. The CLI must behave well when the network is slow, when the disk is full, when the config file is malformed, when the terminal is resized mid-command. Test these explicitly. Use `go.uber.org/mock` (the maintained successor to the archived `github.com/golang/mock`) or hand-rolled fakes to inject failures. Missing fault injection tests are why `kubectl apply` had a long tail of bugs in slow-network conditions.

Race detector in CI. Always run `go test -race ./...`. CLIs that spawn goroutines for progress bars, concurrent API calls, or file processing have races that only surface under load. The race detector catches them in 5 percent of runs. Without it, the bug ships and the user files it.

Fuzz testing of flag parsers and config parsers. Go 1.18 plus has built-in fuzzing. Target your flag parser and config loader with fuzz tests. Corpus from real-world config files and malformed inputs. This catches panics on malformed input, a class of bugs that can crash or hang your tool if a malicious config is fed to it.

Snapshot testing for help text. `myapp --help`, `myapp foo --help`, and every subcommand's help text are API surfaces. Snapshot them in goldens. When a contributor adds a flag, the test fails, the golden is regenerated, and the change is visible in the PR diff. This is the best defense against accidental help-text regressions.

Integration tests against real services. For tools that talk to cloud APIs, maintain a staging environment and run integration tests nightly against it. The `gh` CLI has a test org and runs nightlies that create and delete test repos. Track flakiness and alert on degradation. A flaky integration test is a sign of either a bug in your tool or a drift in the API you depend on.

Performance testing and budgets. Every command has a cold-start budget. 100 milliseconds for simple commands, 500 milliseconds for complex. Enforce with a benchmark in CI that fails if regressed. `kubectl` has a startup time budget enforced in CI after a 2022 incident where a dependency upgrade added 400ms to every invocation.

Backwards compatibility test harness. Keep a directory of old config files, old input formats, old argv invocations that must still work. Every release runs them. When you intentionally break compatibility, you update the harness in the same PR, making the break visible. This is what keeps deprecation timelines honest.

Flake triage. Every flaky test is a process debt. The rule. Three flakes in a week, the test is quarantined and the owner is paged to fix or delete. No exceptions. Flaky tests erode trust in the test suite until engineers stop caring about red builds. At Google, the flake rate is a measured metric. Make it one at your org.

Release candidate soak testing. Before a release is promoted from RC to stable, it runs for 48 hours in a shadow mode against real internal usage. Observability dashboards compare RC error rates and latency to the current stable. Promotion is gated on green metrics. This catches issues that no automated test can, because they depend on production traffic patterns.

Security tests. Test for path traversal in file args (`myapp read ../../etc/passwd`). Test for command injection in exec calls. Test for secrets in error messages (must be redacted). These should be part of the standard test suite, not a separate security audit.

---
