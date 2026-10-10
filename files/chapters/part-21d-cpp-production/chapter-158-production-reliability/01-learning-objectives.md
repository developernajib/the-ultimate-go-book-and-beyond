## Learning Objectives

By the end of this chapter, you will be able to:

### Detection and Forensics

- Configure `core_pattern` and `systemd-coredump` so that a crashing C++ binary in production produces a usable coredump on a remote machine within seconds, not minutes.
- Integrate Crashpad (or Breakpad, for legacy services) into a C++ service to upload minidumps to a crash-reporting backend.
- Set up a symbol server that maps shipped stripped binaries back to their full debug information using `.dwp` (split-DWARF) packages.
- Read an AddressSanitizer, ThreadSanitizer, MemorySanitizer, and UndefinedBehaviorSanitizer report and identify the root-cause line number, allocation site, and free site.
- Decide which sanitizers to run in CI on every pull request, which to run nightly, and which to deploy to a small percentage of production traffic on a SAN-canary.
- Add a libFuzzer or AFL++ fuzz target to a C++ parser, run it as part of CI, manage a regression corpus, and triage crashes with deduplication.

### Prevention

- Set up clang-tidy, clang-static-analyzer, and an open-source Semgrep ruleset on a C++ codebase, with a workflow for false-positive suppression that does not cause alert fatigue.
- Use `DCHECK`, `CHECK`, and the absl logging library correctly: which kind of assertion belongs at which level, and what should ship enabled in optimized builds.
- Configure Google Benchmark or NanoBench in CI with statistical-significance gates, so that a 2% performance regression actually fails the build instead of getting lost in noise.
- Run `git bisect run` against a benchmark to find the exact commit that introduced a regression.
- Design a canary deployment that limits blast radius to under 1% of traffic, with automated rollback when SLI burn-rate alerts fire.
- Build a feature-flag library on top of absl flags and a dynamic configuration source, with atomic updates that require no binary restart.
- Mirror live production traffic to a canary using a request-replay tool, and run a DiffTester that compares responses byte-for-byte (or with a tolerance specification).

### Recovery

- Inject controlled chaos into a C++ service: latency, network drop, kill -9 of dependent processes, with blast-radius bounds.
- Implement a circuit breaker state machine (closed, open, half-open) in modern C++ with `std::atomic` state transitions and exponential backoff.
- Build per-tenant bulkheads using thread pools sized per priority class.
- Design graceful degradation paths: cache-on-error, partial result return, request shedding by SLA priority, brownout under load.
- Write a graceful shutdown handler that responds to `SIGTERM`, drains new connections, completes in-flight work, and arms a watchdog timer to force exit after a deadline. Make it work under Kubernetes `preStop` and systemd `KillMode=mixed`.

### Debugging at Scale

- Detect potential deadlocks at runtime using Abseil's mutex deadlock checker, and design a poor-man's lock-order graph for codebases that do not use absl.
- Sample a production heap with jemalloc or tcmalloc heap profiler, take a diff over time, and identify the leaking call site.
- Apply Dean and Barroso's "Tail at Scale" patterns (hedged requests, tied requests, micro-partitioning) to a fan-out service. Reason about when each pattern is worth its cost.
- Wire up structured logging (absl logging or spdlog), distributed tracing (OpenTelemetry C++ SDK), and metrics (prometheus-cpp), with exemplars that link a slow trace to its corresponding metric.
- Use perf, eBPF/bpftrace, gdb, lldb, strace, ltrace, pstack, addr2line, and c++filt fluently against a running production binary.

### Operations

- Write a blameless postmortem in the Google SRE style: timeline, root cause, contributing factors, immediate fixes, durable fixes, action items.
- Define SLIs, SLOs, and error budgets for a C++ service. Compute multi-window multi-burn-rate alerts.
- Run an incident as IC (incident commander) for a high-severity outage.
- Design alerts that page on symptoms, not causes. Distinguish a good alert from alert fatigue.
- Write runbooks that the on-call engineer at 3 AM can actually follow.

### What You Should Already Know

This chapter assumes:

- Working knowledge of modern C++ (chapters 90 to 130 of this book).
- Familiarity with concurrency (chapters 109 to 115) and performance (part 21c).
- Comfort with Linux systems-level concepts (signals, processes, virtual memory).
- Some exposure to a production environment, even if it was just shipping a service to a small staging cluster.

If you have not held an on-call pager before, the case studies in chapter 24 will teach you what one feels like.

---
