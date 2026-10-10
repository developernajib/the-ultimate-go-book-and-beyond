## Crash Dumps and Symbolication

A C++ binary that crashes in production tells you nothing useful unless you have already done the work, before the crash, to capture and symbolicate the dump. This chapter is the playbook for that work.

### Coredumps the Kernel Way

The Linux kernel writes a coredump when a process receives a fatal signal (`SIGSEGV`, `SIGABRT`, `SIGBUS`, `SIGFPE`, `SIGILL`) and `RLIMIT_CORE` is non-zero. The destination is governed by `/proc/sys/kernel/core_pattern`.

```bash
# Send all coredumps to systemd-coredump
$ cat /proc/sys/kernel/core_pattern
|/usr/lib/systemd/systemd-coredump %P %u %g %s %t %c %h
```

The pipe form (`|`) is the only sane choice for production. Writing files to `core.%p` in the binary's working directory was fine in 1995. Today, that directory might be a read-only container layer, the disk might be full, or the binary might be running as a UID that has no write permissions. systemd-coredump captures the dump into `/var/lib/systemd/coredump/`, compresses it, and rotates old entries.

Retrieving a dump with `coredumpctl`:

```bash
$ coredumpctl list
TIME                            PID  UID  GID SIG     COREFILE EXE
Mon 2026-04-22 03:12:17 UTC  18293 1000 1000 SIGSEGV present  /opt/myservice/bin/myd
$ coredumpctl info 18293
$ coredumpctl debug 18293   # opens gdb on the dump
```

For containerized environments, the coredump pattern is read from the **host kernel**, not the container. If your service runs in Kubernetes, you must configure `core_pattern` on every node, and the pod must have `securityContext.allowPrivilegeEscalation: false` compatible settings. A common fix is to run a DaemonSet that sets the pattern at node-boot time and mounts `/var/lib/systemd/coredump` into the pod.

### RLIMIT_CORE in C++

If your service forks subprocesses, set the core limit explicitly, because containers often inherit a zero limit:

```cpp
#include <sys/resource.h>

void EnableCoredumps() {
    struct rlimit r{};
    r.rlim_cur = RLIM_INFINITY;
    r.rlim_max = RLIM_INFINITY;
    if (setrlimit(RLIMIT_CORE, &r) != 0) {
        PLOG(ERROR) << "Failed to set RLIMIT_CORE";
    }
}
```

Call this at startup. Do not assume the container runtime did it for you.

### Why Coredumps Alone Are Not Enough

Coredumps have three production problems:

1. **Size**. A C++ service with a 4 GB heap produces a 4 GB dump. Multiply by the crash rate, and you have a storage problem.
2. **Privacy**. The dump contains every byte of memory, including user data, secrets, encryption keys, and session tokens. You cannot ship raw dumps to a third-party crash-reporting service.
3. **Symbol information**. Stripped production binaries have no symbols. Without symbols, the dump is just hex addresses.

The industry solution is a **minidump**: a smaller, structured snapshot of the registers, the stack, and a configurable set of memory regions, with an option to skip the heap entirely.

### Crashpad and Breakpad

Google produces two libraries for C++ minidump generation: Breakpad (older, in maintenance) and Crashpad (newer, recommended for new code). Crashpad runs an out-of-process handler that survives the parent's crash and writes the minidump even when the parent's address space is corrupt.

Integration sketch (Crashpad, Linux):

```cpp
#include "client/crashpad_client.h"
#include "client/crash_report_database.h"
#include "client/settings.h"

void InitCrashpad() {
    using namespace crashpad;
    base::FilePath handler("/opt/myservice/bin/crashpad_handler");
    base::FilePath db("/var/lib/myservice/crashes");
    std::string url("https://crashes.internal.example.com/upload");

    std::map<std::string, std::string> annotations = {
        {"service", "myd"},
        {"version", BUILD_VERSION},
        {"region", std::getenv("REGION") ?: "unknown"},
    };
    std::vector<std::string> arguments = {"--no-rate-limit"};

    auto database = CrashReportDatabase::Initialize(db);
    database->GetSettings()->SetUploadsEnabled(true);

    static CrashpadClient client;
    client.StartHandler(handler, db, db, url, annotations, arguments,
                        /*restartable=*/true, /*asynchronous_start=*/false);
}
```

Call `InitCrashpad()` as the first thing in `main`, before any threads are spawned. The out-of-process handler attaches via `ptrace` and inherits enough state to write a usable minidump even after a stack overflow that would defeat an in-process handler.

For services that cannot use an external binary (statically-linked appliances, sandboxed environments), Breakpad's in-process handler is the fallback. It is less reliable. A heap corruption that confuses the allocator may also confuse the in-process handler, leaving you with no dump.

### Symbol Servers

A stripped production binary maps an address `0x4a3b91` to nothing. To turn that into `MyClass::Process(Request const&) at request.cc:142`, you need the un-stripped binary or its separate debug-info file.

The standard practice:

1. Build the binary with full debug info.
2. Run `objcopy --only-keep-debug myd myd.debug`.
3. Run `strip --strip-debug myd`.
4. Run `objcopy --add-gnu-debuglink=myd.debug myd`.
5. Ship `myd`. Upload `myd.debug` to a symbol server, indexed by build-id.

The build-id is a hash embedded in the binary's `.note.gnu.build-id` section. `gdb` and `addr2line` will look up the matching debug file by build-id automatically when you set `debuginfod-find` or the `DEBUGINFOD_URLS` environment variable.

```bash
$ export DEBUGINFOD_URLS=https://symbols.internal.example.com
$ gdb /opt/myservice/bin/myd /tmp/core.18293
# gdb fetches debug info on demand
```

Microsoft's SymStore uses a different layout (PDB files indexed by GUID). Google's internal symbol server uses build-id. The Mozilla and Chrome symbol servers use a hybrid scheme. The exact protocol matters less than the principle: **the symbol must be retrievable by the binary's intrinsic identity, not by filename or path**, because two builds with the same filename will collide.

### Split DWARF

A C++ binary with full debug info can be 10x larger than the stripped version. Linking the debug info also dominates link time. Split DWARF (`-gsplit-dwarf`) writes debug info to side files (`.dwo`), and `dwp` packages them into a single `.dwp` file at the end of the build.

```bash
$ clang++ -O2 -g -gsplit-dwarf -c request.cc -o request.o
# produces request.o (small) and request.dwo (debug info)
$ clang++ -gsplit-dwarf -fuse-ld=lld -o myd *.o
$ dwp -e myd -o myd.dwp
```

Ship `myd` (small). Archive `myd.dwp` in the symbol server. gdb and lldb both understand `.dwp`. Build times drop by 30 to 60 percent on large C++ codebases. This is standard practice at Google and at every C++ shop running clang at scale.

### Post-Mortem gdb Workflow

You have a coredump. You have the matching debug binary. The workflow:

```bash
$ gdb /opt/myservice/bin/myd /var/lib/systemd/coredump/core.myd.18293.gz
(gdb) thread apply all bt full   # backtrace every thread
(gdb) info threads
(gdb) thread 7
(gdb) frame 4
(gdb) p some_local_variable
(gdb) p *this
(gdb) info registers
(gdb) x/16gx $rsp                # examine the stack
(gdb) disassemble                # see the instruction that crashed
```

The first command (`thread apply all bt full`) is the single most useful command in post-mortem debugging. It produces a complete picture of every thread's call stack, which is what you need to identify lock contention, deadlock, or the unlucky thread that caught the signal.

For automated triage (you have ten thousand crashes, you want to know how many distinct stacks they represent), feed `bt` output through a stack-hash function. The standard approach is to take the top N frames (skipping inlined functions and signal handlers), normalize addresses to function names, and SHA-1 the result. This is how ClusterFuzz and the Chrome crash dashboard deduplicate.

### What Goes Wrong

- **Build-id mismatch**. The symbol server has the debug info for build 12345, but production is running 12346. Solution: build pipelines must upload `.dwp` to the symbol server **before** the binary is allowed to leave the build queue.
- **Truncated dumps**. The kernel hit `RLIMIT_CORE` mid-write. Solution: set the limit to `RLIM_INFINITY` and use systemd-coredump's compression, which streams.
- **Coredumps in containers vanish**. The host's coredump path is not visible to the pod, or the pod is killed before the kernel finishes writing. Solution: a node-level DaemonSet that catches dumps, plus Crashpad as a defense in depth.
- **Stripped frames in `bt`**. You forgot `-fno-omit-frame-pointer`, or the function was inlined into a hot loop. Solution: build with frame pointers in production. The 1% perf cost is worth the debuggability. Google made this trade-off explicit and now defaults to frame pointers across the fleet.

### Senior at FAANG: What Distinguishes a Staff Answer

A senior engineer at FAANG does not just know how to read a coredump. They have set up the symbol-server pipeline, written the DaemonSet that captures dumps from every node, configured Crashpad with the right annotations to make crashes searchable by region and version, and built the dashboard that shows crash rate by stack-hash over time. The interview question "what happens when your service crashes in production?" has a forty-minute answer at this level, and it is the answer this chapter is preparing you to give.

---
