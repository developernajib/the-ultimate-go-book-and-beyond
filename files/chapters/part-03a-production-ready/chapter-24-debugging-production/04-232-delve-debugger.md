## 24.2 Delve Debugger

### Basic Delve Usage

Delve is Go's purpose-built debugger, replacing `gdb` for Go programs. Install it with `go install` and invoke `dlv debug` for source-level debugging, `dlv attach` to connect to an already-running process, or `dlv test` to debug a specific test function, each mode handles the binary compilation and symbol loading automatically.

One property matters more than any other before you point Delve at production: `dlv attach` stops the process. Delve uses `ptrace` to seize the target, and every goroutine is frozen from the moment you attach until you detach. There is no read-only attach mode. A service handling live traffic will stall for the entire session, health checks will fail, and an orchestrator may well kill the pod out from under you.

```bash
# Install
go install github.com/go-delve/delve/cmd/dlv@latest

# Debug a program
dlv debug main.go

# Attach to running process
dlv attach <pid>

# Debug the tests of one package (dlv test takes a single package, not a ... pattern)
dlv test ./pkg/cache
```

### Common Commands

Delve's interactive REPL exposes Go-aware commands that understand goroutines, interfaces, and the Go scheduler, capabilities that `gdb` lacks without custom scripts. Conditional breakpoints (`condition 1 id == 123`) are especially valuable in production-like environments where a bug reproduces only for a specific request ID, allowing you to skip thousands of irrelevant iterations. The `goroutines` and `goroutine N` commands let you switch execution context between concurrent goroutines, which is the primary technique for diagnosing deadlocks and race conditions that only manifest under concurrent load.

```
(dlv) break main.processRequest    # Set breakpoint
(dlv) break main.go:42             # Break at line
(dlv) condition 1 id == 123        # Conditional breakpoint
(dlv) continue                     # Run until breakpoint
(dlv) next                         # Step over
(dlv) step                         # Step into
(dlv) stepout                      # Step out of function
(dlv) print variable               # Print variable
(dlv) locals                       # Show local variables
(dlv) args                         # Show function arguments
(dlv) goroutines                   # List goroutines
(dlv) goroutine 5                  # Switch to goroutine 5
(dlv) stack                        # Show stack trace
```

### Remote Debugging

Attaching a local Delve client to a remote process requires running Delve in headless mode on the server and connecting from the developer's machine. The `--headless` flag drops the interactive terminal and serves Delve's JSON-RPC API over the listen address instead, which is what `dlv connect` speaks. That is a different protocol from DAP: if you want a Debug Adapter Protocol server for an editor, run `dlv dap --listen=:2345`, which has been part of the main `dlv` binary for years.

```bash
# On server: JSON-RPC API server for the dlv CLI client
dlv attach <pid> --headless --listen=:2345 --api-version=2

# From local machine
dlv connect server:2345
```

The listen address carries no authentication and no encryption, and anyone who reaches it gets arbitrary code execution as the target process. Bind it to `127.0.0.1` and reach it over an SSH tunnel. Never expose it on a routable interface.

### VS Code Launch Configuration (DAP Mode)

As of 2026, Delve ships a native Debug Adapter Protocol (DAP) implementation in `github.com/go-delve/delve/service/dap`, so the VS Code Go extension invokes `dlv` directly (the separate `dlv-dap` binary was retired). Use `"mode": "remote"` plus `"debugAdapter": "dlv-dap"` for remote sessions, `"mode": "core"` to examine a core file, and `"substitutePath"` (the modern replacement for `remotePath`) to map container build paths to local workspace paths.

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Remote Debug (DAP)",
            "type": "go",
            "request": "attach",
            "mode": "remote",
            "debugAdapter": "dlv-dap",
            "port": 2345,
            "host": "server.example.com",
            "substitutePath": [
                { "from": "${workspaceFolder}", "to": "/app" }
            ]
        },
        {
            "name": "Core Dump Post-Mortem",
            "type": "go",
            "request": "launch",
            "mode": "core",
            "program": "${workspaceFolder}/bin/myapp",
            "coreFilePath": "/tmp/core.myapp.12345"
        }
    ]
}
```

> **Senior track**: At FAANG scale you rarely attach Delve to a live prod replica. The usual workflow is (1) drain traffic from one pod via the service mesh, (2) capture a core with `gcore <pid>` or let the crash handler emit one, (3) copy the binary + core to a debug jumpbox, and (4) run `dlv core` there. This avoids the scheduler-freeze risk of `dlv attach` on a live process and keeps the blast radius to one replica.

### Legacy Launch Configuration

You will still find this shape in old wikis and old `launch.json` files. The pre-DAP adapter it targets was removed from the VS Code Go extension, and `remotePath` went with it. It is shown here only so you recognise it as dead configuration and know to port it to `substitutePath` above:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Remote Debug",
            "type": "go",
            "request": "attach",
            "mode": "remote",
            "remotePath": "/app",
            "port": 2345,
            "host": "server.example.com"
        }
    ]
}
```

### Staff Lens: Delve in Production Is High-Risk

Attaching Delve to a production process pauses the process while debugging. Do not do this on a service under load. Use Delve on core dumps (post-mortem) or on canary instances that can tolerate pauses. For live production diagnosis, prefer pprof and goroutine dumps, which do not pause the process.

---
