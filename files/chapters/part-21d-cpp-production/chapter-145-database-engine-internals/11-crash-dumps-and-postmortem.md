## Crash Dumps and Postmortem Debugging

When a database process segfaults at 3am, the only artifacts that matter are the stack trace, the core file, and the recent log. If any of those is missing the root cause stays unknown, and the same crash returns in a week.

### Core file configuration

The kernel writes core files based on `/proc/sys/kernel/core_pattern`. Distros ship values like `|/usr/lib/systemd/systemd-coredump %P %u %g %s %t %c %h` which pipe the core into systemd-coredump. Under containers the pattern is inherited from the host namespace, which is frequently wrong, and the core is silently dropped. Verify explicitly:

```bash
cat /proc/sys/kernel/core_pattern
sysctl kernel.core_uses_pid
ulimit -c unlimited  # or RLIMIT_CORE via setrlimit in main()
```

In code, set the rlimit at startup so a crash during init is still captured:

```cpp
#include <sys/resource.h>
void EnableCoreDumps() {
    struct rlimit rl{RLIM_INFINITY, RLIM_INFINITY};
    if (setrlimit(RLIMIT_CORE, &rl) != 0) {
        PLOG(WARNING) << "setrlimit RLIMIT_CORE failed";
    }
    // PR_SET_DUMPABLE is cleared on setuid, re-enable explicitly.
    prctl(PR_SET_DUMPABLE, 1, 0, 0, 0);
}
```

### Split debug info

Shipping a 500MB binary with full DWARF into production is wasteful and leaks internals. Use `-gsplit-dwarf` to emit `.dwo` files, then package them with `dwp` into a single `.dwp` companion. Ship the stripped binary, keep the `.dwp` in a symbol server. On a crash, feed the `.dwp` to gdb via `set debug-file-directory`.

```
clang++ -O2 -g -gsplit-dwarf -Wl,--gdb-index -o engine.bin main.cc
dwp -e engine.bin -o engine.bin.dwp
strip --strip-debug engine.bin
```

`--gdb-index` makes gdb startup on a large binary near-instant, which matters when you are paging through a 50GB core under incident time pressure.

### Breakpad / Crashpad minidumps

Core files are multi-gigabyte on a database process with a hot buffer pool. Minidumps (Breakpad/Crashpad) capture just stacks, thread contexts, and selected memory regions, typically under 5MB, and upload to a symbol server for automated grouping.

```cpp
#include "client/linux/handler/exception_handler.h"
static google_breakpad::ExceptionHandler* g_handler = nullptr;

bool DumpCallback(const google_breakpad::MinidumpDescriptor& desc,
                  void*, bool succeeded) {
    // Async-signal-safe only. No malloc, no locks.
    static const char msg[] = "minidump written\n";
    ::write(STDERR_FILENO, msg, sizeof(msg) - 1);
    return succeeded;
}

void InitCrashHandler(const std::string& dir) {
    google_breakpad::MinidumpDescriptor desc(dir);
    g_handler = new google_breakpad::ExceptionHandler(
        desc, nullptr, DumpCallback, nullptr, true, -1);
}
```

The callback runs in a signal handler. It must be async-signal-safe, which excludes nearly all of the C++ standard library. Buffer log lines into a pre-allocated ring and flush from the callback via `write`.

### Symbolication pipeline

On upload, a symbolicator service looks up the build ID (`readelf -n binary | grep 'Build ID'`) in a symbol store, resolves frames, and produces a human-readable stack. The build ID must be embedded at link time (`-Wl,--build-id=sha1`), and every production binary must upload its debug info to the symbol store before it is deployed. Skipping this step is how "unknown crash in libc" remains unsolved for a year.

### Reading a core with gdb

```
gdb --core=core.engine.12345 --exec=engine.bin
(gdb) set debug-file-directory /symbols/engine.bin.dwp
(gdb) thread apply all bt
(gdb) info registers
(gdb) info shared
(gdb) frame 3
(gdb) p *this
```

For signals with extra context (`SIGBUS`, `SIGSEGV`) inspect `$_siginfo`:

```
(gdb) p $_siginfo._sifields._sigfault.si_addr
```

That address, compared to `info proc mappings`, tells you whether you touched a freed region, a misaligned pointer, or a guard page.

### Deadlock and livelock capture

For hangs, core-dump the live process without killing it:

```
gcore -o live.engine $(pidof engine.bin)
```

`gcore` uses `ptrace`, which pauses the process for the duration of the dump. On a 100GB RSS database that can be seconds of latency, so prefer `GDB` with `set pagination off` and `thread apply all bt` redirected to a file, which is lighter.

### Record-and-replay with rr

For non-deterministic bugs, `rr record` captures every syscall and scheduling decision, and `rr replay` replays the exact execution with reverse debugging (`reverse-continue`, `reverse-next`). Overhead is roughly 2x, acceptable for staging. Production use is rare but invaluable for Heisenbugs that appear only under load.

### Post-mortem checklist

1. Confirm build ID matches deployed version.
2. Pull recent logs from the crashed pid, plus metrics for the 5 minutes prior.
3. Open the core, capture `thread apply all bt`, register state, `info proc mappings`.
4. Identify the signal and `si_addr`, classify as UAF, stack overflow, null deref, or assertion.
5. Cross-reference with sanitizer builds if the crash reproduces in staging.
6. File a ticket with build ID, timestamp, stack, and a reproducer or the input that caused it.
7. Add a regression test that fails without the fix, before shipping the fix.
