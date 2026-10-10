## Production Debugging Tools

A C++ binary in production has hung. A user is on the phone. The dashboard does not say why. You SSH into the machine. What do you do?

This chapter is the toolkit. It is the reference card for the on-call engineer at 3 AM, and the reference list for the staff engineer who is making sure their team has all of these tools available and knows how to use them.

### perf

The first tool to reach for when CPU is high or latency is up.

Sample running threads:

```bash
$ sudo perf record -F 99 -p $(pidof mybin) -g -- sleep 30
$ sudo perf report
```

`-F 99` samples at 99 Hz (avoiding lockstep with 100 Hz timer interrupts). `-g` captures stack traces. `sleep 30` controls the duration.

Produce a flame graph:

```bash
$ sudo perf script | stackcollapse-perf.pl | flamegraph.pl > flame.svg
```

The flame graph shows where the binary's CPU time is going. A wide bar at the top of the graph is the function that is hot. Wide bars near the root are usually frameworks or wait points.

Hardware counters:

```bash
$ sudo perf stat -e cycles,instructions,cache-misses,branch-misses ./mybin
```

A high cache-miss rate (more than 5% of instructions) tells you memory subsystem is the bottleneck. A high branch-miss rate tells you the branch predictor is confused.

### ftrace and trace-cmd

Kernel-level tracing. Useful when the bottleneck is in syscalls or kernel scheduling.

```bash
$ sudo trace-cmd record -p function_graph -P $(pidof mybin)
$ sudo trace-cmd report
```

ftrace can answer "is my thread getting scheduled?" (look for `sched_switch`) and "how long is it in the kernel?" (function-graph traces show kernel function call/return).

### eBPF and bpftrace

eBPF is the modern replacement for ftrace. It runs sandboxed programs inside the kernel that produce structured output. bpftrace is the high-level scripting language.

A few one-liners:

```bash
# Count syscalls per second
$ sudo bpftrace -e 'tracepoint:raw_syscalls:sys_enter { @[comm] = count(); }'

# Latency histogram of read() syscall
$ sudo bpftrace -e 'tracepoint:syscalls:sys_enter_read { @start[tid] = nsecs; }
  tracepoint:syscalls:sys_exit_read /@start[tid]/
    { @us = hist((nsecs - @start[tid])/1000); delete(@start[tid]); }'

# Off-CPU sampling: where is the process blocked?
$ sudo bpftrace -e 'kprobe:finish_task_switch { @[kstack] = count(); }'
```

The `bcc` toolkit (`/usr/share/bcc/tools` on most distributions) has hundreds of canned tools: `tcptop`, `tcpconnect`, `runqlat`, `biolatency`, `oomkill`, `slabratetop`. Spend an hour learning them, the payback is enormous.

### gdb attach

For arbitrary inspection of a running process:

```bash
$ sudo gdb -p $(pidof mybin)
(gdb) thread apply all bt   # backtrace every thread
(gdb) info threads
(gdb) thread 7
(gdb) bt full
(gdb) p some_global_var
(gdb) detach
(gdb) quit
```

Attaching pauses the process until you `detach`. For a service handling traffic, that means a brief outage. Use sparingly. An attach-and-detach is fine, an interactive session of minutes is not.

For a service that is hung, attach is essentially free, because the process is not making progress anyway.

### gdb remote

For debugging across machines (the binary on a server, gdb on a developer laptop):

On the server:

```bash
$ gdbserver :1234 --attach $(pidof mybin)
```

On the laptop:

```bash
$ gdb /local/path/to/mybin
(gdb) target remote server:1234
```

Useful when the production environment lacks the development tools or symbol files, or when the developer wants to use a richer debugger UI.

### lldb

The LLVM debugger. Same capabilities as gdb, different command syntax. Defaults on macOS. Some C++ developers prefer it, both work.

```bash
$ lldb -p $(pidof mybin)
(lldb) thread list
(lldb) bt all
```

### strace

Trace syscalls.

```bash
$ sudo strace -p $(pidof mybin) -f -e trace=network -tt -T
```

`-f` follows children. `-tt` adds timestamps. `-T` shows time spent per syscall. `-e trace=network` filters to network syscalls.

A common diagnostic: "is my process making any progress?" If `strace` shows nothing happening, the process is stuck (likely on a `futex` wait, visible with `-e trace=futex`).

A common gotcha: strace slows the process by 5-10x. Do not strace a healthy production binary.

### ltrace

Like strace, but for library calls instead of syscalls. Useful for understanding what shared-library boundary the binary is crossing.

```bash
$ ltrace -p $(pidof mybin) -f
```

Less commonly used than strace because most interesting library calls eventually become syscalls.

### pstack and eu-stack

Print thread stacks without an interactive debugger.

```bash
$ sudo eu-stack -p $(pidof mybin)
```

`eu-stack` (from `elfutils`) is more reliable than the older `pstack`. It works on stripped binaries with debug info available via debuginfod. The output is a single dump of every thread's stack, fast.

Useful when you want a quick look without committing to a gdb session.

### /proc/PID/stack

Kernel stack of a thread:

```bash
$ sudo cat /proc/$(pidof mybin)/stack
```

Tells you what kernel function the thread is currently in. Useful for "is the thread in `epoll_wait`, or in a kernel mutex?"

For per-thread:

```bash
$ for tid in $(ls /proc/$(pidof mybin)/task/); do
    echo "Thread $tid:"
    cat /proc/$(pidof mybin)/task/$tid/stack
  done
```

### addr2line and c++filt

A coredump or stack dump prints raw addresses. Convert them to source lines:

```bash
$ addr2line -e /path/to/mybin 0x4a3b91
src/server.cc:178
```

If the symbol name is mangled:

```bash
$ echo '_ZN6Server13HandleRequestEPv' | c++filt
Server::HandleRequest(void*)
```

Both tools are old, ubiquitous, and reliable.

### /proc/PID/maps and /proc/PID/smaps

Memory layout:

```bash
$ sudo cat /proc/$(pidof mybin)/maps
$ sudo cat /proc/$(pidof mybin)/smaps   # detailed per-mapping stats
```

Useful for understanding memory consumption, mmap'd files, anonymous regions, and shared libraries loaded.

Total RSS:

```bash
$ ps -o rss= -p $(pidof mybin)
```

### tcpdump

Network captures:

```bash
$ sudo tcpdump -i any -w capture.pcap host db.internal and port 5432
```

Read in Wireshark for a graphical view, or with `tcpdump -r capture.pcap` for command-line.

Useful for debugging "the database says we are not sending requests, but we say we are." Capture, look at the wire, see who is right.

### ss and netstat

Socket state:

```bash
$ ss -tnp     # TCP, numeric, with process info
$ ss -s       # summary
```

Counts of connections in each state (`ESTABLISHED`, `TIME_WAIT`, `CLOSE_WAIT`). A high `CLOSE_WAIT` count usually means the server is not closing sockets that the client closed, indicating a bug.

### A 3 AM Workflow

The on-call engineer's first 5 minutes:

1. `top` or `htop`. CPU? Memory? Which thread?
2. `ps -o rss= -p $(pidof mybin)` and compare to baseline. Memory growth?
3. `ss -s`. Connection counts plausible?
4. `eu-stack -p $(pidof mybin)`. What are the threads doing?
5. `perf top -p $(pidof mybin)`. Hot functions?
6. Tail the structured log filtered to `level=error` and `level=warn`.
7. The metrics dashboard. Latency? Error rate? Queue depth?

Five minutes in, you usually know the rough nature of the problem. The next 25 minutes are diagnosis, the next 30 are mitigation. By the one-hour mark, you have either rolled back, flipped a kill switch, or escalated.

### Tooling Hygiene

A senior engineer ensures these tools are available on production hosts:

- `gdb`, `eu-stack`, `addr2line` from the build.
- `perf`, `bpftrace`, `tcpdump`, `strace` from the OS package.
- The binary built with frame pointers and split-DWARF.
- The symbol server reachable from the host.
- The on-call's laptop has the matching toolchain.

A production host without these tools is a production host where every incident is harder. Fix it before the next on-call shift.

### Senior at FAANG: The Toolkit Discipline

The senior contribution is treating the debugging toolkit as a product. There is a runbook page that lists the tools, the commands, the example outputs. The team uses the same tools in the same way. The on-call workflow is rehearsed during onboarding. New team members do not learn to debug by reading source, they learn by walking through real coredumps with a senior.

---
