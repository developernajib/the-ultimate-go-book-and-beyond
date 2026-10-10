## Install
```makefile
install: build ## Install to GOBIN
	cp $(BINARY_NAME) $(GOPATH)/bin/

install-completions: build ## Install shell completions
	@mkdir -p ~/.local/share/bash-completion/completions
	./$(BINARY_NAME) completion bash > ~/.local/share/bash-completion/completions/$(BINARY_NAME)
	@echo "Bash completions installed. Restart your shell."
```

### Junior to FAANG: install path realities

`$(GOPATH)/bin` may not be in the user's `PATH`. Print an instruction. `echo "Add $(GOPATH)/bin to PATH"`. Without this, the user runs `make install`, types `mycli`, and gets `command not found`. Confusion for an hour. Small detail, big impact.

`install-completions` only installs bash. A complete install adds zsh, fish, PowerShell. On macOS, zsh is the default shell since Catalina. Skipping it means your tool feels unfinished to Mac users. Always install at least bash, zsh, and fish.

XDG_DATA_HOME compliance. The path `~/.local/share/bash-completion/completions` is correct per spec. Some systems use `/etc/bash_completion.d`, but that requires root. Always prefer user-local install unless you are building a system package.

### Senior at FAANG: install experience as adoption lever

Staff concerns. First-run UX is critical. When the user installs via `make install`, run a `mycli init` subcommand that creates the config directory, installs completions for all shells present (detect with `$SHELL`, check for zsh and fish in `/etc/shells`), and prints a success banner with next steps. This is the difference between a tool that feels like a prototype and one that feels like a product.

Shell detection. `os.Getenv("SHELL")` works on Linux and macOS, returns empty on Windows. On Windows, detect PowerShell versus cmd via parent process inspection (`ps -o args= -p $PPID` on Unix, `gopsutil` on Windows). Install completions only for the detected shell, but also tell the user how to install for other shells.

Per-user vs system install. Personal tools should install to `~/.local/bin` and `~/.local/share`. System tools should install to `/usr/local/bin` and `/etc/bash_completion.d`. Provide two targets. `make install-user` and `make install-system`. Never ship a Makefile that silently uses `sudo`, because that surprises and angers users.

Migration from other tools. If your CLI replaces `my-old-tool`, the installer can detect it and offer to migrate config. `gh` does this for `hub`. `k9s` does not migrate from competing tools but displays a welcome message. The migration path is a senior UX decision, because it determines adoption rate.

Integrity verification. `make install` should verify the binary checksum before copying. If the user compiled from source, the checksum is trivially satisfied. If the user downloaded a binary, verification against a published SHA256 is required. Teach the habit in your Makefile.

Rollback. `make uninstall` must remove everything the installer added. Completion files, config directory (with confirmation), binary. Test this as part of CI, because broken uninstall is a long-term reputation hit.

Package manager integration. The most important install UX is `brew install`, `apt install`, `winget install`. A Makefile target is for contributors, not users. The staff rule. Point users at package managers in docs. Use the Makefile only for from-source builds and development. Release automation handles the rest.

