## Run
```makefile
run: build ## Run the application
	./$(BINARY_NAME)
```

### Junior to FAANG: running your tool locally

`make run` looks trivial but hides one important habit. It always builds first. If you `go run .` instead, version stamping via LDFLAGS is skipped, so `--version` reports empty. This bites you during demos. Always `make run` in development so the binary matches production behavior. Use `go run .` only for rapid iteration on pure logic.

Env var hygiene. Before you run, set your app's prefix env vars (`MYCLI_VERBOSE=1`, `MYCLI_OUTPUT=json`) to test the config chain. A tool that works with flags but not env vars usually means the env binding wasn't wired through Viper correctly. Catch this in local testing, not in a customer bug report.

### Senior at FAANG: local run as developer experience

Staff concerns. The `make run` target should support a development-mode flag that enables verbose logging, disables telemetry, uses a local config, and points at staging APIs. `make run ARGS="users list"` should pass additional arguments. This is where devex investment pays off, because every new contributor's first experience with the codebase is running it.

Hot reload for TUI development. Tools with rich TUIs benefit from `air` or `reflex` watching `*.go` files and rebuilding on save. Add a `make dev` target that wires this up. Bubble Tea apps especially benefit, because the edit to feedback loop on TUI design is iterative.

Sandboxed run. In dev mode, the tool should not accidentally touch production. The staff pattern. A `DEV=1` env var that routes all API calls to a staging endpoint, all writes to a temp dir, and all telemetry to a local collector. Enforced by default in `make run`. Removes the chance that a junior runs `make run` in the prod context and deletes real data.

Profiling integration. `make run-pprof ARGS="users list"` runs the tool with `runtime/pprof` enabled and writes a CPU profile to `/tmp/cpu.pprof`. Staff engineers use this to diagnose slow commands. Bake it into the Makefile so the next hire does not have to reinvent the recipe.

