## 28.5 Interactive Features

### Colored Output

ANSI escape codes add color and emphasis to terminal output, but they produce garbage when piped to a file or another program. The `NO_COLOR` environment variable (see https://no-color.org) is the community convention for disabling color globally. The helper below checks both `NO_COLOR` and whether stdout is a real terminal, falling back to plain text when either condition is met.

**For anything beyond simple color, use the Charm ecosystem.** `charmbracelet/lipgloss` gives you declarative, CSS-like styling (borders, padding, alignment, truecolor) that handles `NO_COLOR` and terminal capability detection automatically. For multi-screen interactive UIs, progress bars, forms, lists, and dashboards, `charmbracelet/bubbletea` implements The Elm Architecture in Go and is used by `gh`, `glow`, `soft-serve`, and thousands of other tools. Reach for raw ANSI codes only for the simplest one-line output. As soon as you want a styled box, table, or interactive prompt, lipgloss and bubbletea save you from reimplementing basics.

```go
package main

import (
    "fmt"
    "os"

    "golang.org/x/term"
)

const (
    Reset   = "\033[0m"
    Red     = "\033[31m"
    Green   = "\033[32m"
    Yellow  = "\033[33m"
    Blue    = "\033[34m"
    Magenta = "\033[35m"
    Cyan    = "\033[36m"
    White   = "\033[37m"
    Bold    = "\033[1m"
)

func supportsColor() bool {
    if os.Getenv("NO_COLOR") != "" {
        return false
    }
    return term.IsTerminal(int(os.Stdout.Fd()))
}

func colored(text, color string) string {
    if !supportsColor() {
        return text
    }
    return color + text + Reset
}

func main() {
    fmt.Println(colored("Success!", Green))
    fmt.Println(colored("Warning!", Yellow))
    fmt.Println(colored("Error!", Red))
    fmt.Println(colored(Bold+"Important"+Reset, Blue))
}
```

### User Prompts

Interactive prompts collect input that cannot be specified through flags alone, passwords, confirmations, and menu selections. The `term.ReadPassword` function from `golang.org/x/term` disables terminal echo so passwords are not visible on screen. Each prompt helper returns the user's answer in a normalized form (trimmed, lowered) so callers do not need to repeat that logic.

```go
package main

import (
    "bufio"
    "fmt"
    "os"
    "strings"

    "golang.org/x/term"
)

func prompt(question string) string {
    fmt.Print(question + " ")
    reader := bufio.NewReader(os.Stdin)
    answer, _ := reader.ReadString('\n')
    return strings.TrimSpace(answer)
}

func promptYesNo(question string, defaultYes bool) bool {
    var suffix string
    if defaultYes {
        suffix = "[Y/n]"
    } else {
        suffix = "[y/N]"
    }

    answer := prompt(question + " " + suffix)
    answer = strings.ToLower(answer)

    if answer == "" {
        return defaultYes
    }

    return answer == "y" || answer == "yes"
}

func promptSecret(question string) (string, error) {
    fmt.Print(question + " ")
    password, err := term.ReadPassword(int(os.Stdin.Fd()))
    fmt.Println() // New line after hidden input
    return string(password), err
}

func promptSelect(question string, options []string) int {
    fmt.Println(question)
    for i, opt := range options {
        fmt.Printf("  %d) %s\n", i+1, opt)
    }

    for {
        answer := prompt("Select option:")
        var choice int
        if _, err := fmt.Sscanf(answer, "%d", &choice); err == nil {
            if choice >= 1 && choice <= len(options) {
                return choice - 1
            }
        }
        fmt.Println("Invalid selection, try again")
    }
}

func main() {
    name := prompt("What is your name?")
    fmt.Printf("Hello, %s!\n", name)

    if promptYesNo("Continue?", true) {
        fmt.Println("Continuing...")
    }

    password, _ := promptSecret("Enter password:")
    fmt.Printf("Password length: %d\n", len(password))

    options := []string{"Option A", "Option B", "Option C"}
    choice := promptSelect("Choose an option:", options)
    fmt.Printf("You selected: %s\n", options[choice])
}
```

### Terminal Size

Knowing the terminal's width and height lets you center text, truncate long lines, and draw full-width separators. The `term.GetSize` function queries the OS for the current dimensions. When it fails, typically because stdout is not a terminal, falling back to 80x24 is the standard default.

```go
package main

import (
    "fmt"
    "os"
    "strings"

    "golang.org/x/term"
)

func getTerminalSize() (width, height int) {
    width, height, err := term.GetSize(int(os.Stdout.Fd()))
    if err != nil {
        return 80, 24 // Default fallback
    }
    return width, height
}

func centerText(text string) string {
    width, _ := getTerminalSize()
    padding := (width - len(text)) / 2
    if padding < 0 {
        padding = 0
    }
    return strings.Repeat(" ", padding) + text
}

func printFullWidthLine(char rune) {
    width, _ := getTerminalSize()
    fmt.Println(strings.Repeat(string(char), width))
}

func main() {
    width, height := getTerminalSize()
    fmt.Printf("Terminal size: %dx%d\n", width, height)

    printFullWidthLine('=')
    fmt.Println(centerText("Welcome to MyApp"))
    printFullWidthLine('=')
}
```

### Junior to FAANG: interactivity done right

TTY detection is the single most important check in any interactive feature. Every prompt, color, and progress bar must be gated on it. A tool that prompts in CI hangs forever. A tool that emits color into a logfile leaves escape codes that grep cannot filter. The helper you write once at the top of your CLI.

```go
func isInteractive() bool {
    if os.Getenv("CI") != "" { return false }
    if os.Getenv("NO_COLOR") != "" { return false }
    return term.IsTerminal(int(os.Stdin.Fd())) && term.IsTerminal(int(os.Stdout.Fd()))
}
```

Both stdin and stdout must be TTY for truly interactive features. Just stdout TTY is enough for color. Just stdin TTY means you can read input but output is piped.

Worked example. You add a `--confirm` prompt before a destructive action. In CI, this prompt never appears because stdin is not a TTY, and the tool silently proceeds, deleting production data. The fix. When `isInteractive()` is false and a confirmation is needed, require the user to pass `--yes` explicitly, otherwise refuse. This is how `aws s3 rm --recursive` and `gh repo delete` behave. Copy the pattern.

Password handling. `term.ReadPassword` turns off echo. But if the user hits Ctrl+C mid-entry, the terminal is left with echo disabled, which ruins subsequent commands. Always install a signal handler that restores terminal state. `golang.org/x/term.MakeRaw` and `term.Restore` are the primitives. Libraries like `survey` and `huh` handle this for you.

Interview entry point. "A user reports your tool hangs in GitHub Actions." Walk through the diagnosis. First suspect. Interactive prompt with no TTY. Second suspect. Stdin `ReadAll` without checking pipe vs terminal. Third suspect. Spinner rendering causing buffering. The resolution. Detect CI environment and skip interactive fallback. Provide a `--non-interactive` flag that makes every prompt into a hard error.

### Senior at FAANG: TUIs as product surface

Staff concerns for interactive CLIs.

Framework selection. Raw ANSI codes are fine for one-liners. Bubbletea is the choice for anything with multiple screens or dynamic state. The tradeoff. Bubbletea adds 4 MB to binary size and pulls the Charm ecosystem (lipgloss, bubbles, wish). If your tool is a system utility delivered via apt, the extra weight may be unacceptable. `gh` uses bubbletea for its interactive PR creation flow but not for simple commands. Pick per command, not per tool.

Accessibility is non-negotiable. Screen reader compatibility means your TUI must have an accessible mode that emits linear text instead of redrawing a full-screen app. Bubbletea supports this via `tea.WithInput(os.Stdin)` without alt-screen, which falls back to scrolling output. Test with VoiceOver on macOS and NVDA on Windows. The European Accessibility Act 2025 makes this a legal requirement for tools sold to EU customers.

No color must be honored. The no-color.org spec says any `NO_COLOR` environment variable with any non-empty value disables color. Do not treat `NO_COLOR=0` as color enabled, it must still disable. Similarly honor `CLICOLOR=0`, `TERM=dumb`, and detect dumb terminals. lipgloss and bubbletea handle this. If you roll your own, implement it from day one.

TUI lifecycle and cleanup. Any TUI that takes over the screen with alt-screen mode must restore the terminal on every exit path. That includes panics, `SIGTERM`, `SIGHUP`, and normal exit. The staff-level bug that takes down a demo is a panic during rendering that leaves the terminal in raw mode, requiring the user to type `stty sane` blind. Always wrap TUI execution in a recover handler that restores state before rethrowing.

Prompt design governance. Every destructive action has a confirm prompt. Every confirm prompt has a bypass flag (`--yes`, `--force`). The bypass flag has different ergonomics. `--yes` answers yes to prompts but still respects safety checks. `--force` overrides safety checks too. Document the difference. `kubectl delete` uses `--force`. `aws` uses `--yes` in some commands. Inconsistency within a single tool is worse than either convention.

TTY detection edge cases at scale. Docker TTY allocation (`docker run -t`) looks like a TTY but has no real terminal capabilities, so `GetSize` returns garbage. SSH sessions may have stdin TTY but no stdout TTY when redirecting. Cron jobs have no TTY. Kubernetes `exec` with `-t` is TTY-like but limited. The production pattern is a layered detection. Is it a TTY, are dimensions reasonable, is the terminal known (via `TERM` env var), and has the user overridden with `--no-interactive` or `--non-interactive`. Use all signals, never just one.

Input validation in prompts. The `promptSelect` example above loops on invalid input forever. In production, cap retries (3 attempts) then exit with a clear error. Users whose terminals get stuck in a bad state cannot Ctrl+C out of every loop. An infinite loop is an incident waiting to happen.

Staff archetype. The CLI UX owner is a rare but valuable role. This person runs usability studies on your tool, watches users trip over prompts, and drives changes like "the destructive confirm must type the resource name, not just Y/N" (how `kubectl` and `terraform` prevent accidental deletion). At Anthropic, Stripe, and Shopify, internal CLIs have UX owners. Treat it as a real role with a roadmap.

Password and secret handling at scale. Never echo. Never log. Never store in shell history (the tool must not require secrets as CLI args, it must read from stdin or a file). Support credential helpers (`aws configure set` reads from the SDK credential chain, not from args). Support MFA flows that prompt for TOTP codes but not passwords (because passwords should come from a keychain). The rule. CLI args touch shell history and process lists. Any secret there leaks. Design every secret input to flow through stdin, a file, or an OS keychain.

Telemetry of interactivity. Track non-PII signals. Did the user hit the prompt or pass `--yes`. How often does the user retry the selection menu (signal of bad UX). How often does the CLI exit because of non-interactive CI detection (signal of a prompt that should have been a flag). This drives prompt removal over time. Prompts are friction, and the best prompt is one removed because the corresponding flag is now default in the user's config.

Windows terminal reality. Windows Terminal, PowerShell, cmd.exe, and WSL all behave differently. ANSI escape codes work in Windows Terminal and modern cmd but not in cmd.exe on older Windows 10. The library `github.com/mattn/go-colorable` wraps `os.Stdout` to translate ANSI on legacy Windows. lipgloss and bubbletea handle this. If you target Windows, test on plain cmd, PowerShell 5.1, PowerShell 7, and Windows Terminal. They are different targets.

---
