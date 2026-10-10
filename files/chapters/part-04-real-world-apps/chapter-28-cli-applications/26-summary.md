## Summary

The full lifecycle of building production CLI applications in Go:

1. **Structure**: Use Cobra for complex CLIs with proper command hierarchies and `RunE` for testable error handling. For simpler tools, the standard `flag` package with `flag.NewFlagSet` per subcommand is sufficient.
2. **Input/Output**: Detect whether stdin and stdout are terminals. Send data to stdout and progress messages to stderr. Support `--output json` for machine consumption alongside human-friendly table output.
3. **Configuration**: Follow XDG Base Directory conventions. Respect precedence: flags override environment variables, which override config files, which override compiled defaults. Viper handles this hierarchy automatically.
4. **Interactive features**: Build prompts, confirmations, and secret input with terminal detection. Respect `NO_COLOR` and suppress rich output when piped.
5. **Shell completions**: Generate Bash, Zsh, Fish, and PowerShell completions from the Cobra command tree. Support dynamic completions via `ValidArgsFunction` for runtime-dependent arguments.
6. **Testing**: Write unit tests against Cobra commands in-process, integration tests against the compiled binary, and golden file tests for output validation.
7. **Distribution**: Use GoReleaser for cross-platform builds, checksums, Homebrew taps, and container images. Provide a curl-pipe-bash install script for quick setup.

### Junior to FAANG: what to retain from this chapter

If you remember five things from this chapter, these are the five. One, separate data (stdout) from diagnostics (stderr). Two, detect TTY and adapt output. Three, use Cobra with constructor functions not init, so tests are hermetic. Four, exit codes are public API, document and stabilize them. Five, ship with GoReleaser so your first release is signed, checksummed, and distributed across channels.

If you internalize these five principles, you are already ahead of most CLIs shipped in the Go ecosystem. The rest is refinement.

First CLI checklist before you call it done. Does `--help` describe every command and flag. Does `-o json` work and respect a versioned schema. Does the tool exit non-zero on every failure. Does it handle Ctrl+C gracefully. Does it work in CI without hanging. Does `--version` print useful info. Does it respect NO_COLOR. Does it run correctly on Windows. If you can answer yes to all, ship it. If any is no, fix before shipping.

### Senior at FAANG: the chapter as platform playbook

Staff concerns distilled.

A CLI is a platform contract. Not a program, not a script. Flags, env vars, config keys, output schemas, exit codes, and error messages are all public API subject to deprecation policy and versioning.

The CLI platform team is a real team, not a side project. It owns the framework, the grammar, the release engineering, the telemetry, the docs pipeline, and the governance. Staffed with 3 to 5 engineers for an org with 20-plus CLIs.

Distribution is a supply chain problem. SLSA level 3 provenance, Sigstore signing, SBOM generation, reproducible builds are 2026 baseline for external tools. For internal tools, pin toolchain, run `govulncheck` in CI, audit dependencies quarterly.

Testing is a release gate. Unit, integration, golden file, contract, fuzz, and compatibility harness. Cross-platform matrix is required. Flaky tests are quarantined within a week.

Observability informs roadmap. Track which commands run, which flags are used, which output formats dominate, which errors hit users most. Data drives which pitfalls to prevent, which features to deprecate, which edges to polish.

Multi-year roadmap. Year one, establish conventions. Year two, migrate teams. Year three, ship v2 with breaking changes behind a migration program. Year four, retire v1 on documented timeline. Year five, plan v3 based on accumulated signal. Staff engineers plan across these horizons.

Archetypes revisited. Standards Keeper owns grammar and style. Platform Builder owns the framework and plugins. Migration Shepherd runs deprecation programs. DX Engineer owns docs and completions. Release Engineer owns supply chain and distribution. An org shipping CLIs at scale needs at least three of these five archetypes on staff.

Final principle. Taste matters more than code. The difference between a good CLI and a great one is a thousand small decisions, not one architectural bet. Every prompt, every error message, every flag name, every default value compounds into user experience. Senior engineers invest in the taste. Junior engineers ship the code. Both matter, but only one of them determines whether your tool becomes `kubectl` or becomes forgotten.

---
