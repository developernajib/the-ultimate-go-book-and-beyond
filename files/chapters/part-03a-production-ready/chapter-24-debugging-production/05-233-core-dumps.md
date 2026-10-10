## 24.3 Core Dumps

### Enabling Core Dumps

Core dumps capture the full memory image of a process at the moment it crashes, preserving goroutine stacks, heap contents, and register state for post-mortem analysis. Getting one out of a Go program takes two separate switches, and missing either produces no file at all.

The first is the kernel's. `ulimit -c unlimited` removes the default restriction on dump file size, which on most distributions is 0, and `core_pattern` sets the naming convention so dumps from different processes do not overwrite each other.

```bash
# Check current limit (0 on most systems, meaning no core will ever be written)
ulimit -c

# Enable unlimited core dumps
ulimit -c unlimited

# Set core dump pattern
echo '/tmp/core.%e.%p' | sudo tee /proc/sys/kernel/core_pattern
```

The second switch is Go's, and it is the one people miss. The Go runtime installs its own handlers for the fatal signals, and by default a panic or a runtime throw prints a traceback and calls `exit(2)`. `exit` does not produce a core. You must set `GOTRACEBACK=crash` in the environment, or call `debug.SetTraceback("crash")` early in `main`, which tells the runtime to print the traceback and then re-raise the signal with the default disposition so the kernel writes the dump.

```bash
# Without this, a crashing Go program leaves you nothing but stderr
GOTRACEBACK=crash ./myapp
```

Note that `SetTraceback` can only raise the detail level, never lower it: if the environment already says `crash`, a call to `debug.SetTraceback("single")` is ignored. Note too that in a container the `core_pattern` comes from the host kernel, not the image, and the path it names is resolved in the host's mount namespace. Setting `ulimit -c` inside a container while the host pipes cores to a handler that discards them is the most common reason a correctly configured service still produces no dumps.

### Requesting a Core Dump on Demand

A common piece of folklore says you can register a `SIGABRT` handler that panics, and the panic will leave a core behind. It will not, and it is worth understanding exactly why, because the code looks entirely reasonable:

```go
// BROKEN: this produces a traceback on stderr and no core file at all.
func setupCoreDump() {
    sigChan := make(chan os.Signal, 1)
    signal.Notify(sigChan, syscall.SIGABRT)

    go func() {
        <-sigChan
        panic("received SIGABRT, generating core dump")
    }()
}
```

Two independent things go wrong here. `signal.Notify` tells the runtime to deliver `SIGABRT` to your channel rather than let it take its default action, so the signal that would have dumped core is swallowed. And the `panic` that replaces it unwinds, prints, and calls `exit(2)`, which is a normal process exit as far as the kernel is concerned. Normal exits do not dump core. Run this under `ulimit -c unlimited` and `kill -ABRT` it, and you get a stack trace on stderr and an empty directory.

What actually works is to leave the signals alone and let the runtime crash properly. With `GOTRACEBACK=crash` set, `SIGQUIT` prints every goroutine's stack and then re-raises the signal with the default disposition, so the kernel writes the dump. Nothing needs to be registered in your code.

```bash
# Operator asks a running service for stacks plus a core, no code required
kill -QUIT <pid>
```

If you want a program to be able to abort itself this way, set the traceback level and then let the runtime do the work. Do not intercept the signal:

```go
package main

import "runtime/debug"

func init() {
    // Equivalent to GOTRACEBACK=crash, for builds where you cannot control the env.
    // Only ever raises the level: if the env already says "crash", this is a no-op.
    debug.SetTraceback("crash")
}
```

A deliberate self-abort from inside the program is then just a fatal path, and the cleanest one is a nil-free explicit crash:

```go
// Crashes the process with a traceback and, under GOTRACEBACK=crash, a core file.
func dumpCoreAndDie(reason string) {
    panic("operator-requested core dump: " + reason)
}
```

Note the trade: this kills the process. There is no supported way to make a healthy Go process fork off a core of itself from within. If you need a snapshot of a service that must keep running, use `gcore` from outside, as shown below.

### Analyzing Core Dumps

Delve's `core` subcommand loads a core dump alongside the original binary, giving you the same REPL interface as `dlv attach` but operating on frozen memory rather than a live process. From there you can inspect every goroutine's stack, examine local variables, and identify which goroutine was running at the time of the crash.

```bash
# Debug core dump with Delve
dlv core ./myapp core.myapp.12345

# Examine state
(dlv) goroutines
(dlv) goroutine 1
(dlv) stack
(dlv) locals
```

For a live process that is not crashing, `gcore <pid>` (from `gdb`) snapshots the address space without killing it, then `dlv core` analyzes the snapshot offline. This is the preferred post-mortem path in locked-down prod environments where `dlv attach` is forbidden.

```bash
# Snapshot a live process (requires ptrace capability)
gcore -o /tmp/core 12345

# Analyze offline on a debug host
dlv core ./myapp /tmp/core.12345
```

> **Senior track**: Two gotchas that bite every on-call the first time:
>
> 1. The binary must match the core exactly (same build ID). Ship unstripped binaries to a separate symbol server and build with `-gcflags="all=-N -l"` for debug builds, or use `-trimpath` plus DWARF extracted via `objcopy` for prod builds. A `build_id` mismatch makes Delve refuse to load the core.
> 2. Core dumps contain secrets (env vars, auth tokens, in-flight request bodies, encryption keys in memory). Treat them as sensitive PII. Route them to an encrypted bucket with strict IAM, never to shared logging storage. Rotate credentials after any core is taken from a production replica.

### VS Code Core Dump Debugging

As of 2026, VS Code's Go extension supports `"mode": "core"` via Delve DAP, so you can open a core file in the IDE and use normal breakpoint/inspect UI instead of the REPL. Useful for engineers who are not fluent with `dlv` commands during an incident.

### Staff Lens: Core Dump Pipeline

Every production service should have: core dump configuration, symbol server to match binaries, encrypted storage for the cores, access controls limiting who can read them. Without this, cores cannot be analyzed effectively. Build the pipeline before the first OOM kill.

---
