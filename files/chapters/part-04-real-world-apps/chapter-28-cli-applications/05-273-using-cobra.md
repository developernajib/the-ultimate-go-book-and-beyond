## 28.3 Using Cobra

### Project Setup

Cobra (still on its stable v1 line, v1.9+ as of 2026) is the most widely used CLI framework in Go, powering `kubectl`, `gh`, `hugo`, and hundreds of other tools. A typical Cobra project starts with a root command that defines the application name, description, and global flags, then attaches subcommands in `init()` functions. The root command's `PersistentPreRunE` hook runs before every subcommand, making it the right place to load configuration.

**Viper vs. koanf:** Cobra pairs naturally with Viper (v1.19+), which is what the example below uses. An increasingly popular alternative in 2026 is `knadh/koanf` (v2+), a lighter library with far fewer transitive dependencies and cleaner abstractions. Teams shipping CLIs to end users often prefer koanf because it avoids pulling in `fsnotify`, `hcl`, and other dependencies that Viper loads by default. The Cobra integration pattern is identical, swap `viper.BindPFlag` for `koanf.Load(posflag.Provider(...))`.

```go
// cmd/root.go
package cmd

import (
    "fmt"
    "os"

    "github.com/spf13/cobra"
    "github.com/spf13/viper"
)

var (
    cfgFile string
    verbose bool
)

var rootCmd = &cobra.Command{
    Use:   "myapp",
    Short: "A brief description of your application",
    Long: `A longer description that spans multiple lines and likely contains
examples and usage of using your application.`,
    PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
        return initConfig()
    },
}

func Execute() {
    if err := rootCmd.Execute(); err != nil {
        fmt.Fprintln(os.Stderr, err)
        os.Exit(1)
    }
}

func init() {
    rootCmd.PersistentFlags().StringVar(&cfgFile, "config", "", "config file (default $HOME/.myapp.yaml)")
    rootCmd.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "verbose output")

    viper.BindPFlag("verbose", rootCmd.PersistentFlags().Lookup("verbose"))
}

func initConfig() error {
    if cfgFile != "" {
        viper.SetConfigFile(cfgFile)
    } else {
        home, err := os.UserHomeDir()
        if err != nil {
            return err
        }

        viper.AddConfigPath(home)
        viper.SetConfigType("yaml")
        viper.SetConfigName(".myapp")
    }

    viper.AutomaticEnv()

    if err := viper.ReadInConfig(); err == nil {
        if verbose {
            fmt.Fprintln(os.Stderr, "Using config file:", viper.ConfigFileUsed())
        }
    }

    return nil
}
```

### Subcommands

Each Cobra subcommand is a separate `*cobra.Command` struct with its own `Use`, `Args`, and `RunE` fields. Returning an error from `RunE` instead of calling `os.Exit` keeps commands testable, the caller decides whether to print the error or exit. Local flags registered with `Flags()` apply only to that command, while persistent flags propagate to all descendants.

```go
// cmd/get.go
package cmd

import (
    "fmt"

    "github.com/spf13/cobra"
)

var getCmd = &cobra.Command{
    Use:   "get [key]",
    Short: "Get a value by key",
    Long:  `Retrieve a value from the store by its key.`,
    Args:  cobra.ExactArgs(1),
    RunE: func(cmd *cobra.Command, args []string) error {
        key := args[0]
        format, _ := cmd.Flags().GetString("format")

        value, err := store.Get(key)
        if err != nil {
            return err
        }

        switch format {
        case "json":
            return outputJSON(value)
        default:
            fmt.Println(value)
        }

        return nil
    },
}

func init() {
    rootCmd.AddCommand(getCmd)
    getCmd.Flags().StringP("format", "f", "text", "output format (text, json)")
}
```

The `set` command follows the same structure. Notice that `cobra.ExactArgs(2)` validates the argument count before `RunE` is called, so the handler does not need its own length check. The `--ttl` flag uses Go's `time.Duration` type, which Cobra parses natively from strings like `1h` or `30m`.

```go
// cmd/set.go
package cmd

import (
    "github.com/spf13/cobra"
)

var setCmd = &cobra.Command{
    Use:   "set [key] [value]",
    Short: "Set a key-value pair",
    Long:  `Store a value with the given key.`,
    Args:  cobra.ExactArgs(2),
    RunE: func(cmd *cobra.Command, args []string) error {
        key := args[0]
        value := args[1]
        ttl, _ := cmd.Flags().GetDuration("ttl")

        return store.Set(key, value, ttl)
    },
}

func init() {
    rootCmd.AddCommand(setCmd)
    setCmd.Flags().DurationP("ttl", "t", 0, "time to live (e.g., 1h, 30m)")
}
```

### Command Groups

When a subcommand has no `RunE` of its own, it acts as a group, a namespace that only holds child commands. Invoking `myapp config` without a child prints help automatically. This pattern organizes related operations under a shared prefix, keeping the top-level command list manageable as the tool grows.

```go
// cmd/config.go
package cmd

import "github.com/spf13/cobra"

var configCmd = &cobra.Command{
    Use:   "config",
    Short: "Manage configuration",
}

var configGetCmd = &cobra.Command{
    Use:   "get [key]",
    Short: "Get a configuration value",
    Args:  cobra.ExactArgs(1),
    RunE: func(cmd *cobra.Command, args []string) error {
        // Implementation
        return nil
    },
}

var configSetCmd = &cobra.Command{
    Use:   "set [key] [value]",
    Short: "Set a configuration value",
    Args:  cobra.ExactArgs(2),
    RunE: func(cmd *cobra.Command, args []string) error {
        // Implementation
        return nil
    },
}

var configListCmd = &cobra.Command{
    Use:   "list",
    Short: "List all configuration values",
    RunE: func(cmd *cobra.Command, args []string) error {
        // Implementation
        return nil
    },
}

func init() {
    rootCmd.AddCommand(configCmd)
    configCmd.AddCommand(configGetCmd)
    configCmd.AddCommand(configSetCmd)
    configCmd.AddCommand(configListCmd)
}
```

### Junior to FAANG: the Cobra mental model

Cobra is a tree of commands where each node is a `*cobra.Command` with a handler, a set of flags, and child commands. Parsing walks the argv left to right, descending the tree and collecting flags at each level. Understanding this walk is the key to debugging.

When `myapp config set foo bar --ttl=1h` runs, Cobra descends `root` then `config` then `set`, merging persistent flags from each level, then handing `["foo", "bar"]` as positional args and `ttl=1h` as a local flag to `set.RunE`. Any flag can be defined at any level. Persistent flags at `root` are available to every subcommand. Local flags are only available at their own level. This is the single most common confusion for new Cobra users. If `--verbose` must work for every subcommand, it goes on `rootCmd.PersistentFlags()`. If it is only meaningful for one subcommand, it goes on that command's `Flags()`.

Worked example. First week on the job, you are asked to add a `--namespace` flag that affects every command. Junior instinct. Add it to every command's `Flags()`. Correct answer. Add it to `rootCmd.PersistentFlags()`. Review pass or fail on this single detail.

`init()` versus explicit wiring. The examples use `init()` functions for subcommand registration. This works but has two hidden costs. Import order determines registration order (fragile when commands reference each other), and global state in `rootCmd` makes testing harder. The staff-preferred pattern is a `NewRootCommand()` constructor that builds the tree explicitly.

```go
func NewRootCommand(deps Deps) *cobra.Command {
    root := &cobra.Command{Use: "myapp"}
    root.AddCommand(newGetCommand(deps))
    root.AddCommand(newSetCommand(deps))
    root.AddCommand(newConfigCommand(deps))
    return root
}
```

Every test can construct a fresh tree with fake dependencies. No globals. This is how `gh` and modern Kubernetes tools are structured. Start here on new projects.

Interview entry point. "How does Cobra find which command to run?" Walk through the tree traversal, persistent vs local flag merging, `Args` validation, and the `PreRun` to `Run` to `PostRun` hook chain. Bonus points for knowing `PersistentPreRunE` runs on every descendant unless a descendant defines its own.

### Senior at FAANG: Cobra as a platform foundation

At scale, you do not ship a Cobra CLI, you ship a Cobra platform. Staff concerns.

Command registry as a pluggable interface. Define an internal interface `CommandProvider interface { Commands() []*cobra.Command }` and load providers from a registry. Teams contribute a provider that exposes their subcommands, and the core binary composes them. This is the same composability idea that lets a CLI like `gcloud` carry hundreds of subcommands owned by different teams. The alternative, one giant `cmd/` directory with files from every team, causes merge conflicts on every PR and forces every team to depend on every other team's code.

Plugin model for external extensibility. `kubectl` plugins work by searching `PATH` for executables named `kubectl-*` and invoking them with the remaining args. Cobra does not support this out of the box, but the pattern is 50 lines of code in a custom `cobra.Command.FParseErrWhitelist` handler. The design decision is whether plugins are in-process (Go plugins, fraught, avoid on macOS and Windows) or out-of-process (spawn a child binary, slower but portable and safe). Every FAANG-scale CLI chose out-of-process. Learn from their scar tissue.

PersistentPreRunE is precious. Order of operations at scale. Load config, resolve credentials, establish telemetry context, verify version compatibility with remote APIs, check for updates (non-blocking), initialize the logger, start a trace span. Each of these has failure modes. A misconfigured telemetry endpoint must not prevent the CLI from working offline. A failed update check must not block execution. Wrap each in a timeout and degrade gracefully. Staff-level review comment. "Your PreRunE calls the update server synchronously without a timeout, offline users will see the tool hang for 30 seconds. Make it async and fire-and-forget with a 500ms budget."

Cobra versioning strategy. Any future Cobra major release would break the command struct, and even minor releases have changed behavior around flag parsing. If your CLI has a plugin ABI expressed in terms of `*cobra.Command`, upgrading Cobra is a plugin-breaking change. Decouple by exposing your own `Command` interface that happens to be backed by Cobra internally. The ADR you write is "we wrap Cobra rather than exposing it, so that future parser migrations do not break contributing teams."

Help text governance. `--help` is your user-facing documentation. Staff-level standards. Every command has a non-empty `Long` with an example section. Every flag has a description that starts with a verb. Every subcommand group has a `Long` explaining when to use which child. Add a linter in CI that fails PRs adding commands without these fields. `gh` has this linter, `kubectl` has this linter, your tool should have this linter.

Generated documentation pipeline. Cobra can emit Markdown (`cobra/doc.GenMarkdownTree`), man pages (`cobra/doc.GenManTree`), reStructuredText, and YAML descriptions of the command tree. Wire this into CI so that docs regenerate on every merge. The staff pattern is a `make docs` target that regenerates everything into `docs/cli/` and a CI check that fails if `docs/cli/` is stale. Drift between `--help` and your website is a P2 bug that erodes user trust over time.

Backwards compat shims. When you move `myapp foo bar` to `myapp foo-group bar`, keep the old path working with a deprecation warning. Cobra supports `Aliases: []string{"foo bar"}` at the command level for simple cases, and you can add hidden commands that redirect to the new path for complex ones. Publish a `myapp deprecations` subcommand that lists every deprecated name and its timeline, sourced from a machine-readable manifest in your repo.

Telemetry hook placement. If you collect usage telemetry, the Cobra hook is `PersistentPostRunE`. Record the command path (`myapp.config.set`), the exit code (success or failure category, not specific error), the duration bucket, and the flag set used (names only, never values). Never capture positional args. Respect `DO_NOT_TRACK=1` env var per the consoledonottrack.com standard. Publish the exact telemetry schema in your docs. This is both a privacy requirement and a trust signal that matters when external users adopt your tool.

Testing Cobra commands. The staff pattern. Construct a fresh command tree per test, set `cmd.SetOut(&buf)` and `cmd.SetErr(&buf)`, call `cmd.SetArgs([]string{"config", "set", "foo", "bar"})`, then `cmd.Execute()`. Assert on the buffer contents and returned error. Do not invoke `main`. Do not rely on process-level state. Every command file has a matching `_test.go` with a table of argv fixtures. This is what makes a Cobra CLI safely refactorable across years and contributors.

---
