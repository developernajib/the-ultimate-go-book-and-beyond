## Crash Handling and Core Dumps

> **Senior @ FAANG**: Every service crashes eventually. The question is whether you have a debuggable artifact and a pipeline that turns it into a fix in minutes, or you have a reboot and a postmortem written from logs. Crash handling is not exotic, it is table stakes.

### 1. The Crash Pipeline

A modern crash pipeline:

```
process abort → SIGSEGV/SIGABRT → in-process handler → minidump or core file →
   uploaded to symbol-server → automated stack-walk → deduplicated bug ticket →
   engineer opens the dump in gdb/lldb with matching symbols.
```

Components every C++ service needs:

1. A signal handler for SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT.
2. Either a core dump path or an in-process minidump generator (Crashpad/Breakpad).
3. A symbol server keyed by build ID.
4. An uploader that fires once per crash, idempotent.

### 2. Core Dump Basics

When a process dies from an unhandled fatal signal **and** core dumps are enabled, the kernel writes a core file. Three knobs control behavior:

```bash
# Per-process: dumpable flag. PR_SET_DUMPABLE=0 prevents core, ptrace, ProcFS read.
prctl(PR_SET_DUMPABLE, 1);

# Resource limit: maximum core size.
ulimit -c unlimited
# or in C++:
struct rlimit r{ RLIM_INFINITY, RLIM_INFINITY };
setrlimit(RLIMIT_CORE, &r);

# System-wide: where the core goes.
echo '/var/cores/core.%e.%p.%t' > /proc/sys/kernel/core_pattern
```

`core_pattern` accepts format specifiers:

| Specifier | Meaning |
|-----------|---------|
| `%p` | pid |
| `%P` | pid in initial pid-namespace |
| `%u`, `%g` | uid, gid |
| `%s` | signal causing dump |
| `%t` | unix timestamp |
| `%e`, `%E` | comm (truncated 16) / executable path |
| `%h` | hostname |
| `%c` | RLIMIT_CORE |
| `%i`, `%I` | tid |

If `core_pattern` starts with `|`, the rest is a program piped the core on stdin. **This is how `systemd-coredump` and Crashpad's helper work.**

### 3. `systemd-coredump`. The Modern Default

On systemd distros:

```
$ cat /proc/sys/kernel/core_pattern
|/usr/lib/systemd/systemd-coredump %P %u %g %s %t %c %h
```

Cores land in `/var/lib/systemd/coredump/`, indexed and rotated. List and inspect:

```bash
coredumpctl list
coredumpctl info <pid>           # show stack
coredumpctl gdb <pid>            # open in gdb with the executable
coredumpctl dump <pid> -o core   # extract raw core
```

Configure retention in `/etc/systemd/coredump.conf`:

```ini
[Coredump]
Storage=external
Compress=yes
ProcessSizeMax=2G
ExternalSizeMax=2G
JournalSizeMax=767M
MaxUse=10%
KeepFree=15%
```

This is sufficient for many production services. For container/distributed environments, add an uploader.

### 4. `coredump_filter`. What Goes In the Core

`/proc/<pid>/coredump_filter` is a bitmask:

| Bit | What |
|-----|------|
| 0 | anonymous private |
| 1 | anonymous shared |
| 2 | file-backed private |
| 3 | file-backed shared |
| 4 | ELF headers |
| 5 | private huge |
| 6 | shared huge |
| 7 | private DAX |
| 8 | shared DAX |

Default is 0x33 (anonymous + ELF headers + huge). Set higher for richer dumps:

```cpp
int fd = open("/proc/self/coredump_filter", O_WRONLY);
write(fd, "0x1ff", 5);
close(fd);
```

Trade-off: a 32 GB hugepage allocation in core makes a 32 GB core. For HFT/databases, write a filter that excludes the buffer pool (`MADV_DONTDUMP`) and includes only the heap and stacks.

### 5. In-Process Crash Handler

The bare-minimum handler that produces a backtrace **before** the kernel writes the core:

```cpp
// crash_handler.cpp
#include <signal.h>
#include <execinfo.h>
#include <unistd.h>
#include <ucontext.h>
#include <cstring>
#include <cstdio>

static thread_local std::byte alt_stack[64 * 1024];

static void write_str(int fd, const char* s) {
    write(fd, s, std::strlen(s));
}

extern "C" void crash_handler(int sig, siginfo_t* si, void* ucontext) {
    // Async-signal-safe ONLY: write(2), backtrace, _exit.
    write_str(2, "*** caught fatal signal: ");
    char buf[16]; int n = std::snprintf(buf, sizeof buf, "%d ", sig);
    write(2, buf, n);
    write_str(2, strsignal(sig));
    write_str(2, " ***\n");

    if (si) {
        n = std::snprintf(buf, sizeof buf, "  si_addr=%p\n", si->si_addr);
        write(2, buf, n);
    }

    // Capture instruction pointer from ucontext for the top frame.
    auto* uc = static_cast<ucontext_t*>(ucontext);
    void* ip = nullptr;
#if defined(__x86_64__)
    ip = (void*)uc->uc_mcontext.gregs[REG_RIP];
#elif defined(__aarch64__)
    ip = (void*)uc->uc_mcontext.pc;
#endif
    n = std::snprintf(buf, sizeof buf, "  ip=%p\n", ip);
    write(2, buf, n);

    // Backtrace, backtrace(3) is async-signal-safe - backtrace_symbols is NOT.
    void* frames[128];
    int nf = backtrace(frames, 128);
    backtrace_symbols_fd(frames, nf, 2);  // _fd variant IS safe

    // Re-raise to default handler so kernel writes the core.
    signal(sig, SIG_DFL);
    raise(sig);
}

void install_crash_handler() {
    stack_t ss { .ss_sp = alt_stack, .ss_flags = 0, .ss_size = sizeof alt_stack };
    sigaltstack(&ss, nullptr);

    struct sigaction sa{};
    sa.sa_flags     = SA_SIGINFO | SA_ONSTACK | SA_RESETHAND;
    sa.sa_sigaction = crash_handler;
    sigfillset(&sa.sa_mask);

    for (int s : {SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT}) {
        sigaction(s, &sa, nullptr);
    }
}
```

Notes:

- Alt stack is mandatory for SIGSEGV-from-stack-overflow.
- `SA_RESETHAND` resets the disposition so a crash inside the handler doesn't loop.
- `backtrace_symbols_fd` writes to fd directly without `malloc`, safe.
- `backtrace_symbols` (no `_fd`) returns malloc'd strings, **not** signal-safe.
- For real symbol resolution beyond `Module+offset`, use **libunwind** + parse DWARF in a forked child process, not the handler itself.

### 6. Breakpad / Crashpad. Production-Grade Minidumps

Google Breakpad and its successor Crashpad are the C++ industry standard:

- Capture a **minidump** (subset of memory: thread contexts, stack ranges, loaded modules, exception record). Typical size: 50 KB-2 MB vs full-core gigabytes.
- Cross-platform (Linux, macOS, Windows).
- Integrate with symbol servers (`dump_syms` extracts a `.sym` per binary keyed by build ID).
- Crashpad spawns a separate **handler process** at startup. Crashes signal the handler via socket, the handler reads `/proc/<pid>/mem` to capture memory **out-of-process**. Avoids the "running C++ code from a corrupted heap" problem entirely.

Integration sketch:

```cpp
#include "client/crashpad_client.h"
#include "client/settings.h"

crashpad::CrashpadClient client;
std::map<std::string, std::string> annotations = {
    {"product", "myservice"},
    {"version", VERSION_STRING},
    {"build_id", BUILD_ID},
};
std::vector<std::string> args;
client.StartHandler(
    /*handler=*/std::filesystem::path("/usr/local/libexec/crashpad_handler"),
    /*database=*/std::filesystem::path("/var/lib/myservice/crashes"),
    /*metrics_dir=*/{},
    /*url=*/"https://crash-server.example.com/upload",
    annotations,
    args,
    /*restartable=*/true,
    /*asynchronous_start=*/false);
```

After this, any crash produces a minidump in the database directory and asynchronously uploads it. Production C++ at FAANG-scale almost universally uses this or an in-house equivalent.

### 7. Build IDs and Symbol Servers

Every linked binary should have a build ID:

```bash
gcc -Wl,--build-id=sha1 ...
# or in CMake:
target_link_options(myservice PRIVATE -Wl,--build-id=sha1)
```

Verify:

```bash
$ readelf -n /usr/bin/myservice | grep 'Build ID'
Build ID: 89abcdef...
```

A symbol server stores stripped `.sym` files keyed by build ID. The crash analyzer reads the build ID from the minidump's `MINIDUMP_MODULE_LIST`, fetches the corresponding `.sym`, walks stacks, and emits a symbolicated trace.

Production layout:

```
symbols/
└── myservice/
    └── 89abcdef.../
        └── myservice.sym
```

`dump_syms ./myservice > myservice.sym` produces the file. Index by the first line of the `.sym` (`MODULE Linux x86_64 89abcdef... myservice`).

For C++, also strip and place the **debuginfo file** alongside (`objcopy --only-keep-debug`), gdb finds it via `.gnu_debuglink` or build-id directory layout (`/usr/lib/debug/.build-id/89/abcdef...debug`).

### 8. Post-Mortem with gdb

```bash
gdb /path/to/binary /path/to/core
(gdb) info threads
(gdb) thread apply all bt full
(gdb) frame 7
(gdb) p some_var
(gdb) info registers
(gdb) x/64xb $rsp                   # examine stack memory
(gdb) info auxv                     # process auxiliary vector
```

Useful gdb features:

- `set substitute-path /build/old /actual/source` when source paths differ.
- `set print frame-arguments all` to see arguments even when optimized.
- `gdb -ex 'thread apply all bt' -batch ...` for scripted analysis.
- `coredumpctl gdb <pid>` automatically loads the matching binary on systemd hosts.

For a stripped binary:

```bash
gdb -se=/usr/lib/debug/.build-id/89/abcdef...debug -e ./myservice ./core
```

Or simply `gdb ./myservice ./core`, debuginfod (Fedora 35+, Debian 12+) auto-fetches symbols from `https://debuginfod.elfutils.org/` keyed by build ID.

### 9. Diagnosing Common Crash Causes

| Signal + cause | What it means | Where to look |
|----------------|---------------|---------------|
| SIGSEGV, `si_code=SEGV_MAPERR`, `si_addr` low | NULL deref or near-NULL | bt, check the offset to identify struct field |
| SIGSEGV, `si_addr` random high | wild pointer / use-after-free | run under ASan or Valgrind |
| SIGSEGV at exact stack guard page | stack overflow | enable `-fstack-protector-strong`, reduce frame sizes |
| SIGBUS | misaligned access (ARM), or `mmap` past file end | check `madvise`, `ftruncate` |
| SIGFPE `FPE_INTDIV` / `FPE_FLTDIV` | integer / float divide by zero | guard divisor |
| SIGILL | bad opcode (corrupted code page, wrong CPU baseline) | check `-march`, ensure linker didn't strip relocations |
| SIGABRT from `assert` | classical | the message + bt nail it |
| SIGABRT from `__stack_chk_fail` | stack canary tripped, buffer overflow | inspect frames, near a writable buffer overrun |
| SIGABRT from `free(): invalid pointer` | heap corruption | enable `MALLOC_CHECK_=3` or run under tcmalloc/jemalloc with fill |

### 10. Continuous-Crash Diagnostics

Enable `gcore` on the fly to capture state without killing:

```bash
gcore -o /tmp/snapshot <pid>
```

Or attach gdb live:

```bash
gdb -p <pid>
(gdb) generate-core-file
```

For a non-crashing hang, `bpftrace` profiles + `cat /proc/<pid>/wchan` per-thread + `gstack` (or `eu-stack -p <pid>`) tells you where threads are blocked.

### 11. Production Checklist

- [ ] `--build-id=sha1` on all binaries, `.sym` published per build.
- [ ] Crashpad handler running as a separate process from startup.
- [ ] Sigaltstack on every thread (or main + Crashpad handler thread minimum).
- [ ] `RLIMIT_CORE=infinity` and `core_pattern` either piped to `systemd-coredump` or to a custom uploader.
- [ ] `MADV_DONTDUMP` on huge buffers that would bloat cores.
- [ ] `prctl(PR_SET_DUMPABLE, 1)` after dropping privileges (setuid binaries lose dumpable, restore intentionally).
- [ ] Crash handler captures `/proc/self/maps` and `/proc/self/status` snapshot at fault time.
- [ ] Symbol server has retention long enough to cover the longest tail of bug reports (months for client software, days for stateless services).
- [ ] `coredumpctl gdb` works end-to-end on a known-failing build at least once per release.

### 12. Junior → FAANG Cheatsheet

| Junior | FAANG-grade |
|--------|-------------|
| `printf` from signal handler | `write(2, ...)` only, or async pipeline. |
| No alt stack | `sigaltstack` per thread. SA_ONSTACK on SIGSEGV. |
| Core dumps disabled "for security" | `PR_SET_DUMPABLE=1` + minidumps + symbol server. |
| Strip binaries, throw away symbols | `--build-id`, separate `.sym`, retain debug info. |
| `signal()` to catch crash | `sigaction` with `SA_SIGINFO` + alt stack + `SA_RESETHAND`. |
| Catch and continue past SEGV | Re-raise after backtrace, you cannot trust process state. |
| Cores in `/tmp` | systemd-coredump or pipe to uploader, `/tmp` fills and crashes loop. |
| Hand-symbolize from offsets | debuginfod or per-build symbol server. |

A C++ service without crash handling is a service whose bugs you discover in production from users, not from telemetry. Bake the pipeline in from day one.
