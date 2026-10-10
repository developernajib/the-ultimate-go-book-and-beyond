## Summary

Production reliability for a C++ service is not a topic. It is a discipline that runs across detection, prevention, recovery, debugging, and operations. A staff engineer at a FAANG-tier company is expected to be fluent in all five.

### Reliability Engineering Takeaways

**Detection**: The chapter started with how a C++ binary tells you when it has failed. Coredumps with `core_pattern` and systemd-coredump. Crashpad for in-process minidumps. Symbol servers indexed by build-id. Split-DWARF for slim binaries that retain debuggability. The four LLVM sanitizers (ASan, MSan, TSan, UBSan), what each catches, when each is worth its overhead, and the SAN-canary pattern that runs sanitized builds against a slice of production traffic. Fuzzing with libFuzzer, AFL++, and honggfuzz, plus the corpus management discipline that makes fuzzing a continuous practice.

**Prevention**: Static analysis with clang-tidy, clang-static-analyzer, Coverity, and Semgrep. Custom AST matchers for project-specific rules. The `CHECK` vs `DCHECK` decision rule. Performance regression detection with Google Benchmark, Mann-Whitney U for statistical significance, `git bisect run` for finding the offending commit, and continuous profiling for the regressions that benchmarks miss. Canary deployments with blast-radius math, automated rollback signals, and bake times. Feature flags and kill switches for instant runtime control. Shadow traffic and DiffTester for pre-deploy verification.

**Recovery**: Chaos engineering with bounded blast radius. Circuit breakers with thread-safe state machines. Bulkheads for per-tenant resource isolation. Graceful degradation through cached fallbacks, partial results, and priority-based load shedding. Graceful shutdown with proper SIGTERM handling, drain, watchdog, Kubernetes preStop hooks, and systemd configuration.

**Debugging at Scale**: Lock-order graphs for deadlock detection. Heap profiling with jemalloc and tcmalloc for production-grade leak detection. The full Tail-at-Scale playbook: hedged requests, tied requests, micro-partitioning, cancellation, replica sizing. The observability stack: structured logging with absl/glog/spdlog, metrics with prometheus-cpp, distributed tracing with the OpenTelemetry C++ SDK, and exemplars that link metrics back to specific traces. The full debugging toolkit: perf, ftrace, bpftrace, gdb, lldb, strace, ltrace, eu-stack, addr2line, c++filt.

**Operations**: The blameless postmortem as a learning artifact, with a concrete template and a discipline of action-item follow-through. SLOs, error budgets, and multi-window multi-burn-rate alerts. Incident management with explicit roles, communication discipline, and the rule of mitigation before root cause. On-call rotation design with sustainable cadences, alert hygiene, runbooks, and onboarding patterns.

**Three Real Postmortems**: A slow-burn memory leak that took 11 days to surface. A contention regression that escaped CI because synthetic load did not match production read:write ratios. A TSan race that lived in production for four months because TSan was nightly, not per-PR.

### The Underlying Theme

Reliability is not the absence of failure. Reliability is the discipline of bounding failure: detecting fast, blast-radius-limiting, recovering fast, and learning from every event. Every section of this chapter is one piece of that discipline.

The senior engineer's job is not "prevent all failures." It is "build the systems and culture so that when failures happen, the impact is small and the learning is large."

### What to Do Next

If you are preparing for a senior interview at a FAANG-tier company, work through Section 26's interview questions until you can answer each at the depth indicated, and complete the hands-on labs in Section 25. Read the Google SRE book and the Google SRE workbook. Read Dean and Barroso's Tail at Scale.

If you are on-call right now, bookmark Section 19 (debugging tools) and Section 22 (incident management). Print them if your team prefers paper. Have them at hand for the next page.

If you are about to ship a new C++ service, work backward from this chapter and ensure your service has: structured logging, metrics, tracing, sanitizer builds, fuzz targets, canary deployment, feature flags, circuit breakers, graceful shutdown, an SLO, alerting on burn rate, runbooks, and a postmortem template. Build the reliability infrastructure first, the features second. The service that ships with these in place will be operationally cheaper than the service that bolts them on later.

If you are an SRE on a C++ team, this is your reference. The patterns transfer, the C++-specific details are the parts your previous Go or Java experience did not cover.

### A Closing Frame

The C++ services that run quietly across thousands of machines for years at a time, that survive traffic spikes and partial network failures and deploys gone wrong, are not the ones written by the most brilliant developers. They are the ones supported by the most disciplined reliability practice. The brilliance is in the practice.

A senior engineer's contribution is the practice.

---

| [◀ Chapter 157: Search and Ranking Systems in C++](../chapter-157-search-ranking-systems/00-introduction.md) | [Chapter 158: Production Reliability for C++ Services](00-introduction.md) | [Chapter 159: Browser Internals in C++](../chapter-159-browser-internals/00-introduction.md) ▶ |
