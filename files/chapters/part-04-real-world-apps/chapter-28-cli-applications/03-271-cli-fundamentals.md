## 28.1 CLI Fundamentals

### Basic Structure

A CLI application begins with parsing `os.Args` to determine which command the user invoked and what arguments were passed. This minimal structure demonstrates the fundamental dispatch pattern before introducing a framework like Cobra.

**When to reach for a framework:** If your tool has one or two flags and no subcommands, the `flag` package in the standard library is enough, a dependency-free binary is a real advantage. Once you have subcommands, persistent flags, shell completions, or config files, Cobra pays for itself within an afternoon. For small declarative tools that still want subcommands without the Cobra boilerplate, `urfave/cli/v3` is a lighter option widely used in Go 1.27 projects.

```go
package main

import (
    "fmt"
    "os"
)

func main() {
    if len(os.Args) < 2 {
        fmt.Println("Usage: myapp <command>")
        os.Exit(1)
    }

    command := os.Args[1]
    args := os.Args[2:]

    switch command {
    case "hello":
        fmt.Println("Hello, World!")
    case "greet":
        if len(args) > 0 {
            fmt.Printf("Hello, %s!\n", args[0])
        } else {
            fmt.Println("Hello, stranger!")
        }
    default:
        fmt.Printf("Unknown command: %s\n", command)
        os.Exit(1)
    }
}
```

### Exit Codes

Communicating success or failure through exit codes is a Unix convention that allows shell scripts and CI pipelines to react programmatically to a tool's outcome. Go's `os.Exit` accepts an integer status code, and establishing named constants keeps the semantics explicit throughout the codebase.

```go
package main

import (
    "fmt"
    "os"
)

const (
    ExitSuccess       = 0
    ExitError         = 1
    ExitUsageError    = 2
    ExitNotFound      = 3
    ExitPermission    = 4
    ExitInterrupted   = 130 // 128 + SIGINT
)

func main() {
    if err := run(); err != nil {
        fmt.Fprintf(os.Stderr, "Error: %v\n", err)
        os.Exit(ExitError)
    }
}

func run() error {
    // Application logic
    return nil
}
```

### Junior to FAANG: building the mental model

The `switch` on `os.Args[1]` is the skeleton of every CLI ever written, including `git` and `kubectl`. Everything else is layers of convenience on top. Internalizing this helps you debug anything. When a production CLI misbehaves, you can always `fmt.Println(os.Args)` as the first step and see exactly what the shell handed to your process.

Worked example of the `run()` indirection. The pattern where `main` calls `run() error` exists for one reason. `os.Exit` skips all deferred functions. If you open a file with `defer f.Close()` and then call `os.Exit(1)`, the file is never closed on some platforms, and buffered writes are lost on all platforms. Putting all logic in `run()` and letting `main` handle `os.Exit` is the idiom. Write it this way from your first CLI, not your third.

```go
func main() {
    code, err := run(context.Background(), os.Args[1:], os.Stdin, os.Stdout, os.Stderr)
    if err != nil {
        fmt.Fprintln(os.Stderr, "error:", err)
    }
    os.Exit(code)
}

func run(ctx context.Context, args []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
    // testable. every dependency is injected.
    return 0, nil
}
```

This signature is testable with zero hacks. You pass a `bytes.Buffer` for stdout, a custom `args` slice, and assert on the output. This is the pattern used by `kubectl`, `gh`, and `terraform`. Adopt it immediately.

Interview entry point. "What happens when you run `git status`?" The answer they want walks from `execve` through process creation, argv handoff, Go runtime init, `main.main`, argument parsing, subcommand dispatch, business logic, formatted output, exit code, and shell `$?` capture. Being able to narrate this in 90 seconds signals systems literacy.

### Senior at FAANG: fundamentals become policy

The `switch` statement is also a governance artifact. When your org has forty teams contributing subcommands to one CLI, the switch becomes a plugin registry, and the staff-level question is where registrations live. Static registration in `init()` functions produces the fastest startup but forces every subcommand's dependencies into the binary, inflating size. Dynamic registration via a plugin manifest loaded at startup trades milliseconds of startup for modularity. `kubectl` does the latter through its plugin system (`kubectl-foo` on `PATH`). `gcloud` does a hybrid with a core binary and lazy-loaded component bundles downloaded on first use.

Exit code governance. Publish an exit code specification as part of your CLI's public contract. Example from a staff-authored RFC. "Codes 0 through 9 are reserved and stable. Codes 10 through 99 are user errors, subcategorized by the tens digit (10s auth, 20s validation, 30s not found, 40s conflict). Codes 100 through 199 are retriable infrastructure errors. Codes 200 through 249 are unretriable infrastructure errors. Codes 250 through 255 match OS conventions. Adding a new code in the stable ranges requires RFC approval." CI enforces this by static-analyzing `os.Exit` call sites.

Signal handling at staff level. `SIGINT` and `SIGTERM` must trigger graceful shutdown that cancels the root `context.Context`, flushes telemetry buffers, closes open files, and emits a structured log entry. `SIGPIPE` must be handled because any CLI piped to `head` will receive it, and the default Go behavior for an unhandled SIGPIPE on stdout or stderr is to terminate the process, cutting the tool off mid-write. The production pattern is.

```go
ctx, cancel := signal.NotifyContext(context.Background(),
    os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
defer cancel()
// Disarm the default fd 1/2 SIGPIPE exit so writes fail with EPIPE instead.
// signal.Ignore is unreliable for SIGPIPE (golang/go#32386), so Notify a discarded channel.
signal.Notify(make(chan os.Signal, 1), syscall.SIGPIPE)
```

On Windows, `SIGHUP` does not exist, so wrap in a build tag or use `signal.Notify` with only the signals present. The staff-level code review comment you will leave fifty times in your career is "this does not handle SIGPIPE, the CI piped to grep will terminate the tool mid-write."

Binary entry point discipline. `main.go` at the root of the module must be under 30 lines. Everything else lives in `cmd/` and `internal/`. This is not style, it is supply chain. When a security advisory requires patching a dependency, a thin `main.go` is a one-line diff and a reviewable patch. A 500-line `main.go` mixing parsing, logic, and I/O produces multi-day audits.

Reproducibility. Compile with `-trimpath -ldflags="-s -w -X main.version=$(git describe --tags) -X main.commit=$(git rev-parse HEAD) -X main.date=$(date -u +%Y-%m-%dT%H:%M:%SZ -d @${SOURCE_DATE_EPOCH})"`. Use `SOURCE_DATE_EPOCH` from `git log -1 --format=%ct` so the build date is deterministic. Two engineers on different laptops with the same commit produce byte-identical binaries. This is what SLSA level 3 requires and what makes supply-chain verification feasible.

---
