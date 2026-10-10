## 28.7 Shell Completions

### Cobra Completions

Cobra can generate shell completion scripts for Bash, Zsh, Fish, and PowerShell by walking its command tree at runtime. The standard approach is to add a `completion` subcommand that writes the generated script to stdout. Users then source the output in their shell profile, `source <(myapp completion bash)`, to activate tab-completion for all commands and flags.

```go
// cmd/completion.go
package cmd

import (
    "os"

    "github.com/spf13/cobra"
)

var completionCmd = &cobra.Command{
    Use:   "completion [bash|zsh|fish|powershell]",
    Short: "Generate shell completion scripts",
    Long: `To load completions:

Bash:
  $ source <(myapp completion bash)
  # Add to ~/.bashrc for persistent completions

Zsh:
  $ source <(myapp completion zsh)
  # Add to ~/.zshrc for persistent completions

Fish:
  $ myapp completion fish | source
  # Add to ~/.config/fish/config.fish

PowerShell:
  PS> myapp completion powershell | Out-String | Invoke-Expression
`,
    DisableFlagsInUseLine: true,
    ValidArgs:             []string{"bash", "zsh", "fish", "powershell"},
    Args:                  cobra.MatchAll(cobra.ExactArgs(1), cobra.OnlyValidArgs),
    RunE: func(cmd *cobra.Command, args []string) error {
        switch args[0] {
        case "bash":
            return cmd.Root().GenBashCompletion(os.Stdout)
        case "zsh":
            return cmd.Root().GenZshCompletion(os.Stdout)
        case "fish":
            return cmd.Root().GenFishCompletion(os.Stdout, true)
        case "powershell":
            return cmd.Root().GenPowerShellCompletionWithDesc(os.Stdout)
        }
        return nil
    },
}

func init() {
    rootCmd.AddCommand(completionCmd)
}
```

### Custom Completions

Shell completion scripts are generated at runtime by walking the Cobra command tree and emitting the shell-specific completion function for each command and flag. Cobra generates completion scripts for bash, zsh, fish, and PowerShell. The user sources the output into their shell profile to activate tab-completion for the binary. Custom completion functions registered with `RegisterFlagCompletionFunc` allow dynamic completions, such as listing available environments from an API, rather than static string lists.

```go
var getCmd = &cobra.Command{
    Use:   "get [key]",
    Short: "Get a value",
    ValidArgsFunction: func(cmd *cobra.Command, args []string, toComplete string) ([]string, cobra.ShellCompDirective) {
        if len(args) != 0 {
            return nil, cobra.ShellCompDirectiveNoFileComp
        }

        // Return available keys for completion
        keys, err := store.ListKeys()
        if err != nil {
            return nil, cobra.ShellCompDirectiveError
        }

        return keys, cobra.ShellCompDirectiveNoFileComp
    },
    RunE: func(cmd *cobra.Command, args []string) error {
        // Implementation
        return nil
    },
}
```

### Junior to FAANG: completions in practice

Shell completions are the single biggest UX improvement you can add to a CLI. Tab-completing subcommands and flags makes a tool feel native. Cobra gives you this for free. Wire up the `completion` subcommand, document the install steps, and you immediately feel one tier more polished than tools that lack it.

Worked example of the install flow. User runs `myapp completion bash > /etc/bash_completion.d/myapp` on Linux, restarts the shell, and now `myapp <tab>` works. On macOS with Homebrew, the `brew install myapp` formula should install completion files into `$(brew --prefix)/etc/bash_completion.d`. GoReleaser generates these automatically from your binary at release time.

Dynamic completions are where the real polish lives. Static completion of subcommand names is easy. Dynamic completion of values from an API (list of clusters, list of repos, list of pods) requires that the tool be fast on cold start. If `myapp get <tab>` takes three seconds to list keys, users turn off completions. Budget. 200 milliseconds from invocation to completion list output. Cache aggressively. If listing pods requires a network call, cache results in `$XDG_CACHE_HOME/myapp/completions/` with a short TTL.

Interview entry point. "How do you complete filenames but only `.yaml`?" Answer. Return `cobra.ShellCompDirectiveFilterFileExt` with the list of extensions. Cobra emits the right shell-specific completion for each of the four shells. This directive system is the powerful part of Cobra completions, know what directives exist. NoFileComp, FilterFileExt, FilterDirs, NoSpace, Error, Keep, Default.

### Senior at FAANG: completions as generated artifacts

Staff concerns for completion at scale.

Generation pipeline. Do not rely on users to run `myapp completion bash > file`. Generate completion scripts at release time and ship them in the package. The pattern. CI runs `myapp completion bash > completions/myapp.bash`, `zsh`, `fish`, `powershell`. GoReleaser's `nfpms` and `homebrew_casks` blocks auto-install these into the correct OS-specific paths. Homebrew formula installs to `share/zsh/site-functions`, apt installs to `/usr/share/bash-completion/completions`, rpm to the same. Users never run the completion generator themselves.

Four shells is the minimum. Bash, Zsh, Fish, PowerShell. Nushell is emerging, Cobra does not support it natively yet, but maintain a watch because nushell adoption is growing in 2026. Some tools also ship Elvish completions. Decide which shells you commit to, document the matrix, and test each on each major OS.

Completion performance budget. Cobra's completion mechanism works by invoking your binary in a special mode with `__complete` as a hidden subcommand. Every tab press invokes your binary. Cold start matters. If your tool imports kubernetes/client-go and takes 300ms to start, every tab press pauses 300ms. Mitigations. Keep completion paths minimal (don't load config if not needed for this completion), use build tags to exclude heavy deps from completion paths, or generate static completion files that don't re-invoke the binary for common cases.

Dynamic completion from remote APIs. Cache with a short TTL. Invalidate on write commands (`myapp cluster create new` should invalidate the cluster list cache). Respect offline mode. Never block completion on a network call without a timeout (200ms is the hard ceiling). The UX principle. A slow completion is worse than no completion.

Man page pipeline. Cobra generates man pages via `doc.GenManTree`. Ship them in packages (`/usr/share/man/man1/myapp.1.gz`). Homebrew formula installs them automatically. Users can then `man myapp` which matters for system administrators used to Unix conventions. Wire this into the release pipeline the same way as completions, generated from the command tree, never hand-written.

Documentation as another target. The command tree is the source of truth. Generate completions, man pages, Markdown docs for your documentation site, and a machine-readable JSON description of the command tree (used by tools like `fig.io` for terminal autocomplete GUI). All four targets from one CI job. Drift between any two is a P2 bug.

Flag completion for sensitive values. Do not complete secrets. If a flag expects an API key, the completion function must return empty, not a list of keys from a keychain. Leaking key names via completion is a subtle but real risk. Staff-level code review catch. "This completion lists API keys from the keychain, which shows them in bash history via `set -o vi` search. Return NoFileComp and an empty list for secrets."

Versioning of completions. Completion scripts are part of your public API. A breaking change to completion output breaks user workflows. When Cobra upgrades from v1 to v2 and the completion script format changes, users who sourced the old script have stale behavior. Document that completion scripts must be regenerated on upgrade. In Homebrew, this happens automatically because the formula re-installs.

Accessibility and internationalization. Completion descriptions in non-English locales. Cobra's `ShellCompDirectiveDefault` with descriptions can localize via the same message catalog as your help text. Most tools skip this, but for globally distributed CLIs it is a differentiator.

Staff archetype. The developer experience engineer owning the completion and docs pipeline. They run the release automation, monitor bug reports about completion failures on specific shell versions, and maintain the test matrix. In larger CLI platforms like `aws-cli`, this is a full-time role. Recognize it as one.

Testing completions. Cobra's own test suite exercises completion logic by invoking the hidden `__complete` subcommand directly. Add table tests. "Given args X, tab should return Y." This catches regressions when completion functions break silently, which they will, because no contributor ever tests completion locally unless CI forces them to.

---
