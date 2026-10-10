## Panic and Fatal Errors

Some errors are not recoverable. The invariants you assumed are violated, and continuing would corrupt state, leak secrets, or produce wrong answers. The right move is to crash, fast, with as much forensic data as possible. C++ has several primitives for this and the differences matter.

### The Termination Primitives

| Function | Header | Effect |
|---|---|---|
| `std::abort()` | `<cstdlib>` | Raises `SIGABRT`. No destructors. Default handler dumps core. |
| `std::terminate()` | `<exception>` | Calls the current terminate handler, which by default calls `abort`. |
| `std::quick_exit()` | `<cstdlib>` | Runs `at_quick_exit` handlers, no destructors of statics. |
| `std::exit(n)` | `<cstdlib>` | Runs static destructors, atexit, then `_exit`. Not signal-safe. |
| `_exit(n)` | `<unistd.h>` | Direct syscall. No flush, no destructors, no atexit. Signal-safe. |
| `assert(expr)` | `<cassert>` | If `NDEBUG` undefined, prints and calls `abort`. Else nothing. |
| `LOG(FATAL)` (glog/absl) | library | Logs at FATAL, then aborts. Often runs a crash handler first. |

The tree:

- For a programmer bug detected at runtime: `assert`, `CHECK` (glog/absl), or a hand-rolled `panic` macro that logs and aborts.
- For an unrecoverable runtime condition (exception with no handler, `noexcept` violation, `terminate_handler` invoked by the runtime): `terminate` is called by the language. You override it with `std::set_terminate`.
- For a deliberate fast exit from a signal handler: `_exit`. Anything else is undefined behavior in async-signal contexts.

### `assert` in Debug vs Release

`assert(p != nullptr)` evaluates and aborts if `NDEBUG` is undefined. With `NDEBUG`, the macro expands to `((void)0)` and `p != nullptr` is not evaluated. This is the #1 source of "works in debug, crashes in release" bugs: side effects inside `assert` vanish.

```cpp
assert(connect(sock, ...) == 0);  // bug: in release, connect is never called
```

The fix is `CHECK` or a custom `ENFORCE` macro that always evaluates and always aborts on false:

```cpp
##define ENFORCE(cond) \
    do { if (!(cond)) ::panic(#cond, __FILE__, __LINE__); } while (0)
```

Google's `CHECK_EQ`, `CHECK_NE`, etc. all behave this way. They are cheap (one branch on the hot path) and they carry source location plus the failing expression in the log message.

## `LOG(FATAL)` and `CHECK`

```cpp
CHECK_NE(ptr, nullptr) << "session=" << session_id;
CHECK_GE(buffer.size(), header_size) << "truncated frame";
```

The advantage over plain `assert`:

- Always active, debug or release.
- Streaming context with `<<`.
- Hooks into the logging system. The fatal message is flushed before abort.
- Optional pre-abort callbacks (stack symbolization, sending a crash report).

absl's `LOG(FATAL)` and `CHECK` are the modern replacements for glog. Both will:

1. Format the message and write it to all sinks (file, stderr).
2. Run any registered `LogSink::OnLogEntry` and `absl::InstallFailureSignalHandler` callbacks.
3. Call `abort`.

## Signal-Safe Crash Reporting

A SIGSEGV / SIGBUS handler can do almost nothing. The list of async-signal-safe POSIX functions excludes `malloc`, `printf`, `pthread_mutex_lock`, anything that allocates, and most of the C++ standard library. What you can do safely:

- `write(fd, buf, n)` to a pre-opened fd.
- `_exit(n)`.
- `read`, `_exit`, `kill`, `sigaction`.
- A pre-allocated stack buffer for formatting via `snprintf` (`snprintf` is async-signal-safe in glibc since 2.34, not before, treat it as unsafe and roll your own integer-to-string).

Production crash handlers (Breakpad, Crashpad, Sentry's native SDK) follow this pattern:

1. Install signal handler with a separate signal stack (`sigaltstack`).
2. On signal, write a minidump using only syscalls. The dump is a fixed-format binary blob containing thread stacks, register state, loaded module list.
3. `_exit(128 + signo)`.

Symbolication and pretty-printing happen offline, on a server that has the matching debug info.

Do not call `LOG(FATAL)` from a signal handler. It allocates, takes locks, and will deadlock or crash a second time. Use `absl::FailureSignalHandlerOptions` which does the right thing.

## `terminate_handler` Customization

```cpp
void on_terminate() noexcept {
    // Best effort: try to extract the in-flight exception, log it, then abort.
    if (auto p = std::current_exception()) {
        try { std::rethrow_exception(p); }
        catch (const std::exception& e) {
            std::fprintf(stderr, "terminate: %s\n", e.what());
        }
        catch (...) {
            std::fprintf(stderr, "terminate: unknown exception\n");
        }
    }
    std::abort();
}

int main() {
    std::set_terminate(on_terminate);
    // ...
}
```

This runs when an exception escapes `main`, when an exception escapes a `noexcept` function, when a destructor throws during stack unwinding, and a few other places (see `[except.terminate]`). The default handler calls `abort` with no logging at all, which is why every production binary should install one.

Note: by the time `terminate` is called the search phase already failed, so the throwing frame is still on the stack. A debugger attaching to the resulting core dump can see it.

## Core Dumps

```bash
ulimit -c unlimited                           # allow core
echo "core.%e.%p" | sudo tee /proc/sys/kernel/core_pattern
echo 1 | sudo tee /proc/sys/kernel/core_uses_pid
```

For containerized workloads, `core_pattern` is host-wide. The popular pattern is to pipe to a per-host collector:

```bash
echo "|/usr/local/bin/core-collector %e %p %s" | sudo tee /proc/sys/kernel/core_pattern
```

The collector reads the core from stdin, attaches metadata, ships to object storage. systemd-coredumpd does this on most modern distros.

A core dump from `abort` on Linux x86_64 is typically 100MB to several GB. Strip non-essential mappings with `coredump_filter` (`/proc/<pid>/coredump_filter`) to skip mmap'd shared memory, file-backed pages, and large heaps that you cannot read offline anyway.

## Structured Crash Reports

Google's Crashpad replaced Breakpad for Chrome. It runs an out-of-process handler so a crashed process cannot corrupt the report. The handler uses `ptrace` (or `kqueue`/Mach exceptions on macOS) to walk the dying process's memory and emit a minidump. Crash reports include:

- All thread register states.
- Each thread's stack (typically capped at 32KB per thread).
- Loaded module list with build IDs.
- Annotations the process registered before crashing (active request ID, build version, feature flags).

Crashpad's annotation API is essentially "set this string from inside the running process, and it appears in every crash report from now on, signal-safe". This is what you want for debugging "why did 0.001 percent of users in build 4827 crash".

## The Discipline

| Situation | Mechanism |
|---|---|
| Programmer bug detected at runtime | `CHECK` / `assert`, log, abort |
| Memory corruption suspected | `__builtin_trap` (no cleanup, immediate SIGILL) |
| OOM in `new` | `std::set_new_handler` then `terminate` if no recovery |
| Unhandled exception | Custom `terminate_handler` that logs |
| Async-signal context | Crashpad-style minidump |
| Library invariant violation | Throw `std::logic_error` and let the boundary decide |

The "fail fast" rule: when invariants are violated, do not try to "recover". Crash, dump, restart. Recovery code that tries to clean up after corruption is itself a vector for security bugs (use-after-free during cleanup is the canonical example).

## What Not to Do

- Catch `std::exception` at `main`, log, and `return 0`. You silently turn crashes into clean exits and your alerting pipeline never fires.
- Call `std::exit` from a signal handler. Not signal-safe. Use `_exit`.
- Use `setjmp`/`longjmp` to "recover" from corruption. Not signal-safe past the simplest cases. Skips destructors. Use a process restart.
- Run `abort` without first flushing logs. You lose the last few seconds of evidence.
- Build release binaries with `-DNDEBUG` and rely on `assert` for production checks. Use `CHECK`.

## FAANG Bar

A senior engineer should:

- Distinguish `abort`, `terminate`, `exit`, `_exit`, `quick_exit`.
- Explain why `assert` is not enough for production checks.
- Know what is async-signal-safe and what is not.
- Set up a custom terminate handler and a signal-safe crash dumper.
- Configure core dumps and reason about their cost in a containerized fleet.
- Choose between in-process logging (`LOG(FATAL)`) and out-of-process minidump (Crashpad) based on safety needs.
