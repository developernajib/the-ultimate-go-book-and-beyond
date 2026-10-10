## Stack Traces and Symbolication

A stack trace is one of the most valuable forensic artifacts you can capture. C++23 finally added `<stacktrace>` to the standard. Production binaries have used libbacktrace, libunwind, Google's symbolizer, and platform-specific tools for years. Symbolication (turning addresses into function names plus file/line) is a separate problem, and getting it right requires understanding how debug info works.

### `<stacktrace>` (C++23)

```cpp
#include <stacktrace>
#include <iostream>

void DumpHere() {
    auto trace = std::stacktrace::current();
    std::cout << trace << "\n";
}
```

Output looks like:

```
   0# DumpHere() at /home/me/proj/foo.cc:5
   1# main at /home/me/proj/main.cc:12
   2# __libc_start_main at /lib/x86_64-linux-gnu/libc.so.6
   3# _start
```

The `std::stacktrace_entry` value gives you `description()`, `source_file()`, `source_line()`. Implementations are required to populate these "if available", which means you need debug info on the binary.

Capturing a trace is not free: 1 to 100 microseconds depending on depth and whether symbol resolution is in-band. The C++ implementations on libstdc++ and libc++ use libbacktrace under the hood. For a hot path, capture the raw addresses synchronously and resolve later:

```cpp
struct CapturedTrace {
    std::array<void*, 32> frames;
    std::size_t count;
};

CapturedTrace CaptureFast() noexcept {
    CapturedTrace t;
    t.count = absl::GetStackTrace(t.frames.data(), t.frames.size(), /*skip*/ 1);
    return t;
}

std::string Symbolize(const CapturedTrace& t) {
    std::string out;
    for (std::size_t i = 0; i < t.count; ++i) {
        char sym[256];
        if (absl::Symbolize(t.frames[i], sym, sizeof(sym))) {
            absl::StrAppendFormat(&out, "%2zu# %s\n", i, sym);
        } else {
            absl::StrAppendFormat(&out, "%2zu# %p\n", i, t.frames[i]);
        }
    }
    return out;
}
```

`absl::GetStackTrace` is a few hundred nanoseconds. `absl::Symbolize` is microseconds, dominated by reading debug info.

## How Unwinding Works

To produce a backtrace, the unwinder walks frames upward from the current PC. There are three viable strategies:

1. **Frame pointer chain.** Follow `RBP -> saved RBP -> ...`. Fast (a few cycles per frame) but requires `-fno-omit-frame-pointer`. Default in many distros, omitted by `-O2` historically.
2. **DWARF unwinding.** Read `.eh_frame` (or `.debug_frame`) to virtually execute the unwind state machine and recover registers. Works on optimized code without frame pointers. 100x slower than frame pointer chasing but works on stripped-of-frame-pointer release binaries.
3. **Heuristic.** Scan stack memory for plausible return addresses. Used as a last resort. Unreliable.

libunwind (the original Hewlett-Packard / nongnu version, plus the LLVM port) implements all three. Modern Linux distros build with frame pointers off, so DWARF unwinding is the default. The `.eh_frame` section must be present (it usually is, even in stripped binaries, because exceptions need it).

Build flags that affect this:

- `-fno-omit-frame-pointer`: keeps frame pointers. Costs one register and a few instructions per call. Worth it on x86_64 for unwinding speed and `perf` accuracy.
- `-fasynchronous-unwind-tables`: keeps `.eh_frame` even if exceptions are disabled. On by default for code that uses exceptions, relevant for `-fno-exceptions` builds that still want backtraces.
- `-fno-asynchronous-unwind-tables`: removes them. Saves binary size, breaks unwinding. Do not use on a production binary.

## Symbolication

An address is a number. A useful trace says "in `Service::HandleRequest` at request.cc:142". Turning the number into the name requires:

1. The runtime symbol table (`.dynsym`, `.symtab`). Names of exported functions. Stripped from production binaries by `strip`.
2. The DWARF debug info (`.debug_info`, `.debug_line`, `.debug_abbrev`, etc.). File names, line numbers, inlined function info, types. Removed by `strip --strip-debug`.
3. The build ID (a hash in `.note.gnu.build-id`). Identifies the exact binary so you can find matching debug info elsewhere.

In production, you typically:

- Strip debug info from the deployed binary.
- Keep `.symtab` for top-level symbols (use `--strip-unneeded`, not `--strip-all`).
- Keep `.eh_frame` (needed for exceptions).
- Keep build ID.
- Store the unstripped binary (or a separate `.dwp` / `.debug` file) on a symbol server keyed by build ID.

`objcopy --only-keep-debug binary binary.debug` extracts debug info into a sidecar file. `objcopy --add-gnu-debuglink=binary.debug binary` annotates the stripped binary so debuggers find it. This is the standard split.

### Split DWARF

For large binaries, `.debug_info` can be hundreds of MB. Linking it all into one binary slows builds. Split DWARF (`-gsplit-dwarf`) emits per-object `.dwo` files that the linker leaves out of the final binary, `.debug_info.dwo` references them. A `dwp` tool packages them into a `.dwp` file for distribution.

For Google-scale builds where the unstripped binary would be 5 GB, split DWARF is mandatory. Linker time drops from minutes to seconds.

### libbacktrace and libunwind

libbacktrace (Ian Lance Taylor, in GCC) reads DWARF directly and produces symbolicated traces in-process. Used by libstdc++'s `std::stacktrace` and many third-party loggers. No external symbolizer needed.

libunwind (LLVM and the original) is lower-level: walks frames, returns PC addresses. Symbolication is a separate step (often via `dladdr`, `dwarf_find_function_sym`, or shelling out to `addr2line`).

The choice in production:

- In-process symbolication: libbacktrace, absl::Symbolize. Convenient. Costs binary size (debug info present at runtime) and microseconds per frame.
- Out-of-process: capture raw addresses plus build ID. Symbolicate offline using `addr2line`, `llvm-symbolizer`, or a dedicated service. Cheap at runtime, requires symbol-server infrastructure.

Google uses in-process symbolization for production logs (the binaries are large but the latency is ok) and out-of-process for crash dumps.

### Breakpad and Crashpad

Google's out-of-process crash handler. Captures minidumps (a Microsoft format, also used by Windows). The minidump is a binary blob with thread states, register snapshots, loaded module list, and stack memory.

Breakpad is the older library. Crashpad is the rewrite (Chrome 2015+). Crashpad runs the handler in a separate process, which can dump the dying process via `ptrace` (Linux), Mach exceptions (macOS), or SetUnhandledExceptionFilter (Windows). The crashed process never executes any C++ runtime in the handler, which avoids the "crash inside the crash handler" problem.

Symbolication of minidumps is offline. You upload `.sym` files (Breakpad's format, similar to `.pdb`) to a symbol server. The minidump processor (`minidump_stackwalk`) merges trace plus symbols.

### Sentry Native

Sentry's native SDK wraps Crashpad (or Breakpad) plus their own ingestion. You initialize:

```cpp
sentry_options_t* opts = sentry_options_new();
sentry_options_set_dsn(opts, "https://...");
sentry_options_set_release(opts, "service@1.4.27");
sentry_options_set_handler_path(opts, "/usr/local/bin/crashpad_handler");
sentry_options_set_database_path(opts, "/var/lib/svc/sentry");
sentry_init(opts);
```

The handler runs out of process. On crash, the minidump is written, then uploaded next time the service starts (or by a sidecar). Sentry symbolicates server-side using uploaded `.sym` or `.dSYM` bundles, attaches breadcrumbs (events you logged before the crash), and groups by stack signature.

### Asynchronous-Safe Stack Capture

In a signal handler, the only safe stack capture is to walk frame pointers (or read pre-captured DWARF tables) without allocation. `absl::GetStackTrace` is async-signal-safe. `std::stacktrace::current()` is not always (the implementation may allocate). Crashpad's handler uses its own minimal walker.

For a custom handler:

```cpp
void on_sigsegv(int, siginfo_t* si, void* uc) noexcept {
    void* frames[64];
    int n = absl::GetStackTrace(frames, 64, /*skip*/ 0);
    // write raw addresses + build ID to a fixed file via write()
    // never call malloc, printf, log
    char buf[2048];
    int len = format_addresses(buf, sizeof(buf), frames, n);
    write(crash_log_fd, buf, len);
    _exit(128 + SIGSEGV);
}
```

Symbolication happens on a different machine, after the fact, given the build ID and the raw addresses.

### Inlined Frames

`-O2` aggressively inlines. `addr2line` with `-i` (or `llvm-symbolizer` by default) produces multiple lines per address, walking up the inlined call chain:

```
inlined_helper()
  at /src/util.cc:8
parent_function()
  at /src/svc.cc:42
```

DWARF emits this via `DW_TAG_inlined_subroutine`. Trace pretty-printers must handle multi-line entries per address, otherwise they hide half the actual call chain.

## FAANG Bar

A senior engineer should:

- Capture stack traces with `std::stacktrace`, `absl::GetStackTrace`, or libbacktrace.
- Distinguish frame pointer unwinding from DWARF unwinding and pick build flags accordingly.
- Strip release binaries with `--only-keep-debug` plus debuglink, not `--strip-all`.
- Run a symbol server keyed by build ID for offline symbolication.
- Use Crashpad or Breakpad for out-of-process crash capture.
- Walk inlined frames in trace output.
- Capture stacks safely in signal handlers (frame pointer or pre-built DWARF, never `malloc`).
