## Learning Objectives

By the end of this chapter, you will be able to:

1. **Design professional CLI architectures** - Structure command-line applications with proper command hierarchies, flag handling, and error management
2. **Implement advanced flag parsing** - Build custom flag types, handle subcommands, and create flexible argument validation
3. **Create interactive terminal UIs** - Build spinners, progress bars, tables, colored output, and user prompts with proper terminal detection
4. **Manage configuration properly** - Implement XDG Base Directory compliance, support multiple config formats, and handle environment variable precedence
5. **Build shell completions** - Generate Bash, Zsh, Fish, and PowerShell completions with dynamic argument suggestions
6. **Test CLI applications thoroughly** - Write unit tests for commands, integration tests for the full binary, and golden file tests
7. **Distribute across platforms** - Create cross-platform builds, release automation, and installation scripts

### Junior to FAANG: how to read these objectives

Treat the seven objectives as a ladder, not a checklist. Objective 1 (architecture) is the foundation. If you skip it and jump to objective 5 (shell completions), you will rewrite everything. Work in this order on your first CLI. First, build a single command with `flag` and a hand-written `main`. Second, add one subcommand using Cobra. Third, extract business logic into an internal package. Fourth, add a JSON output mode. Fifth, write table tests against the internal package. Only then should you touch config files, completions, or distribution. This sequencing mirrors how a staff engineer would review your pull requests on an internal tool, blocking merges until the layering is right.

Interview framing. When asked "walk me through how you would design a CLI" at an L3 or L4 screen, the structure to deliver is. "I separate parsing, routing, logic, and presentation. Parsing is Cobra or flag. Routing is the subcommand tree. Logic is an internal package with no I/O dependencies. Presentation is a formatter interface with implementations for table, JSON, and YAML." That single paragraph, delivered confidently, is the difference between "meets bar" and "does not meet bar" for tool-building roles.

### Senior at FAANG: objectives reinterpreted at staff level

Each objective looks different through a staff lens. Design becomes command grammar governance across an org where fifteen teams ship CLIs under one umbrella binary. Flag parsing becomes a typed-config platform with env-var precedence documented in an RFC. Interactive UIs become an accessibility-compliant TUI toolkit with color-blind-safe palettes and screen-reader output modes. Configuration becomes a hierarchy resolver that merges flags, env, user config, system config, remote config, and organizational defaults with a documented precedence order and audit log. Completions become a generated artifact pipeline feeding four shells plus IDE integrations. Testing becomes a golden-file contract harness gated on every PR with cross-platform runners. Distribution becomes a supply chain program with SLSA level 3 provenance, Sigstore signing, SBOM generation, and a documented rollback runbook.

A staff engineer reading these seven objectives also reads seven implicit objectives. Deprecation policy, versioning strategy, telemetry privacy model, binary size budget, plugin or extension model, internationalization strategy, and accessibility posture. None of those seven appear in a junior curriculum, and all seven show up in the post-launch retro when something goes wrong.

---
