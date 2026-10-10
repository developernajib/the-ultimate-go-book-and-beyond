## 28.4 Input and Output

### Reading Stdin

A CLI tool should accept input both interactively and through pipes. The standard approach checks `os.Stdin.Stat()`: if the `ModeCharDevice` bit is clear, data is being piped in and the tool should read it without prompting. When stdin is a terminal, the tool can display prompts and read line by line. This dual-mode pattern lets the same binary work in `echo "data" | mycli` pipelines and in interactive sessions.

```go
package main

import (
    "bufio"
    "fmt"
    "io"
    "os"
)

func main() {
    // Check if stdin has data (piped input)
    stat, _ := os.Stdin.Stat()
    if (stat.Mode() & os.ModeCharDevice) == 0 {
        // Data is being piped
        data, err := io.ReadAll(os.Stdin)
        if err != nil {
            fmt.Fprintln(os.Stderr, err)
            os.Exit(1)
        }
        processData(data)
    } else {
        // Interactive mode
        scanner := bufio.NewScanner(os.Stdin)
        fmt.Print("Enter input: ")
        if scanner.Scan() {
            processData([]byte(scanner.Text()))
        }
    }
}

func processData(data []byte) {
    fmt.Printf("Processed: %s\n", data)
}
```

### Formatted Output

Structured output, columnar tables, key-value pairs, JSON, helps users and downstream tools consume command output reliably. The `text/tabwriter` package aligns columns by buffering output and computing widths before flushing.

```go
package main

import (
    "encoding/json"
    "fmt"
    "os"
    "text/tabwriter"
)

type Item struct {
    Name       string `json:"name"`
    Quantity   int    `json:"quantity"`
    PriceCents int64  `json:"price_cents"`
}

func printTable(items []Item) {
    w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
    defer w.Flush()

    fmt.Fprintln(w, "NAME\tQTY\tPRICE")
    fmt.Fprintln(w, "----\t---\t-----")

    for _, item := range items {
        fmt.Fprintf(w, "%s\t%d\t$%d.%02d\n", item.Name, item.Quantity, item.PriceCents/100, item.PriceCents%100)
    }
}

func printJSON(items []Item) {
    enc := json.NewEncoder(os.Stdout)
    enc.SetIndent("", "  ")
    enc.Encode(items)
}

func printYAML(items []Item) {
    for _, item := range items {
        fmt.Printf("- name: %s\n", item.Name)
        fmt.Printf("  quantity: %d\n", item.Quantity)
        fmt.Printf("  price_cents: %d\n", item.PriceCents)
    }
}
```

### Progress Indicators

Progress indicators keep users informed during long-running operations such as file transfers or API polling. A simple spinner or progress bar written to a TTY should be suppressed automatically when stdout is redirected to a pipe or file.

```go
package main

import (
    "fmt"
    "time"
)

func spinner(done chan bool) {
    chars := []rune{'⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'}
    i := 0

    for {
        select {
        case <-done:
            fmt.Print("\r \r") // Clear spinner
            return
        default:
            fmt.Printf("\r%c Processing...", chars[i%len(chars)])
            i++
            time.Sleep(100 * time.Millisecond)
        }
    }
}

func progressBar(current, total int, width int) string {
    percent := float64(current) / float64(total)
    filled := int(percent * float64(width))

    bar := make([]rune, width)
    for i := range bar {
        if i < filled {
            bar[i] = '█'
        } else {
            bar[i] = '░'
        }
    }

    return fmt.Sprintf("[%s] %.1f%%", string(bar), percent*100)
}

func main() {
    // Spinner example
    done := make(chan bool)
    go spinner(done)
    time.Sleep(3 * time.Second)
    done <- true

    // Progress bar example
    total := 100
    for i := 0; i <= total; i++ {
        fmt.Printf("\r%s", progressBar(i, total, 40))
        time.Sleep(50 * time.Millisecond)
    }
    fmt.Println()
}
```

### Junior to FAANG: I/O conventions you must internalize

Three rules from day one. Data goes to stdout. Logs, errors, and progress go to stderr. The human-readable prompt goes to stderr so it does not pollute a piped stdout. If you break these rules, the first user who types `mycli list > file.txt` will file a bug. This is also why the spinner example above has a subtle bug at scale. It prints to stdout without checking TTY. In a pipe, it writes spinner characters into the downstream's input. Fix. Detect TTY with `term.IsTerminal(int(os.Stderr.Fd()))` and only render progress when true. Write progress to stderr, not stdout.

Worked example. You are writing `mycli users list`. The output must be a table when the user runs it in a terminal, JSON when piped, and respect `--output=yaml` if provided. The logic.

```go
func selectFormat(flagOut string) string {
    if flagOut != "" { return flagOut }
    if !term.IsTerminal(int(os.Stdout.Fd())) { return "json" }
    return "table"
}
```

This three-line function is the difference between a tool that feels right and one that feels clunky. Both `gh` and `kubectl` implement variations of this.

Stdin draining pitfall. `io.ReadAll(os.Stdin)` blocks until EOF. If you forget to detect TTY and run the tool with no pipe and no argument, it hangs waiting for input. Users assume it crashed. Always check `stat.Mode() & os.ModeCharDevice` first, or use a `context.Context` with a short timeout if the tool is run non-interactively.

Interview entry point. "Why does `ls` output behave differently when piped to `less`?" Answer. `ls` detects TTY on stdout. When connected to a terminal, it emits columns and color. When piped, it emits one file per line with no color, because that is what downstream tools can parse reliably. Your CLI must do the same.

### Senior at FAANG: output contracts, not formatting

Staff-level insight. Output is an API. Any script anywhere parsing your tool's stdout is a downstream consumer. Changes to output are API changes subject to your deprecation policy.

Structured output versioning. Every JSON output includes a top-level envelope. `{"apiVersion": "mytool.io/v1", "kind": "UserList", "metadata": {...}, "items": [...]}`. This mirrors Kubernetes and is not an accident. The envelope lets you evolve payloads without breaking consumers, because consumers can dispatch on `apiVersion` and `kind`. Store each version's schema as JSON Schema in a `schemas/` directory, validated in CI against fixture outputs. When you need a breaking change, ship `v2` alongside `v1`, let users opt in with `--output-version=v2`, then deprecate `v1` on a timeline.

Human versus machine output is two different APIs. The human output is free to change (column ordering, added fields, reformatting) because no one should be scripting against it. The machine output (`-o json`, `-o yaml`) is versioned and stable. Enforce this contract by treating every change to a `--output=json` emitter as an API change in code review, requiring at least two reviewers and a changelog entry.

Progress UX at scale. A progress bar for a 10-second operation is helpful. A progress bar for a 3-second operation is visual noise. A spinner for an operation whose duration is unknown is correct. A log line per step for an operation with discrete phases is best of all because it survives non-TTY output. The staff rule. Default to log lines. Add progress only when the operation has a known total and typically exceeds 5 seconds. Respect `NO_COLOR`, `TERM=dumb`, and `CI=true` environment variables to disable fancy output. Detect `CLICOLOR=0` and `CLICOLOR_FORCE=1` per the freebsd.org convention.

Pagination. When output might exceed screen height, `kubectl get pods` in a cluster with 5000 pods, the tool should respect the user's `$PAGER` when on a TTY, like `git log` does. The Go pattern is to fork `less` or `more` as a subprocess and pipe output, falling back to direct write when no pager is set or stdout is not a TTY. `github.com/cli/go-gh/v2/pkg/term` has a pager helper.

Binary output handling. Some CLIs emit binary data (image thumbnails, encrypted blobs, tar streams). The staff rule. Never emit binary to a TTY. Detect it and print an error like `docker image save` does. `error: binary output detected, redirect to a file or pipe with -o file`. This prevents users from garbling their terminal and calling support.

Accessibility for output. Color must not be the only way information is conveyed. When you print errors in red, also prefix with `error:`. When you print warnings in yellow, also prefix with `warning:`. Screen readers and color-blind users depend on the prefix. Respect `NO_COLOR=1` per the no-color.org standard. Ship a `--no-color` flag. This is an accessibility requirement, not a preference.

Table rendering at scale. `tabwriter` works for small outputs. For large outputs, stream rows as they become available rather than buffering all rows before computing widths. The pattern is to sample the first N rows to establish column widths, render them, then render subsequent rows with the established widths (with a note if truncation occurred). For true streaming, use fixed-width columns driven by type metadata. This is what `aws s3 ls` does for performance.

Internationalization. If your tool is distributed globally, output must be localizable. Use `golang.org/x/text/message.Printer` for formatted output, with locale detected from `LC_ALL`, `LC_MESSAGES`, and `LANG` in that order. Never concatenate translated strings with a `+`, because word order varies between languages. Extract translatable strings into a `messages.gotext.json` catalog and localize for the languages your user base speaks. This matters earlier than you think for tools adopted by enterprises whose operators do not all read English.

Observability of output paths. Instrument which output format is used. Track `format:json`, `format:yaml`, `format:table`, `format:custom` at the telemetry layer (as a bucket, not with content). Staff-level insight from this data. If 95 percent of invocations use `-o json`, that is the format to invest in, the human output is probably secondary for your user base. This data drives roadmap decisions for which output paths to optimize.

Exit signaling on output errors. When `os.Stdout.Write` returns an error (broken pipe, disk full), the tool must exit with a non-zero code and log to stderr. The default Go behavior is to silently discard the error. Wrap every write in a helper that checks the error. For broken pipe specifically (typical in `mycli list | head -10`), exit code 0 is acceptable because the user explicitly requested only the first N lines. Differentiate EPIPE from other write errors.

---
