## Sanitizers in Production Workflows

Sanitizers are the closest thing C++ has to a safety net. AddressSanitizer catches heap and stack overflow, use-after-free, and memory leaks. ThreadSanitizer catches data races. UndefinedBehaviorSanitizer catches signed overflow, null deref, misaligned access, and invalid shifts. MemorySanitizer catches reads of uninitialized memory. Shipping a production C++ codebase without mandatory sanitizer coverage in CI is negligence.

### Build matrix

Every CI run executes at minimum three sanitized build variants in parallel:

```
# ASan + UBSan
clang++ -O1 -g -fno-omit-frame-pointer \
        -fsanitize=address,undefined \
        -fsanitize-address-use-after-scope \
        -fno-sanitize-recover=all

# TSan
clang++ -O1 -g -fno-omit-frame-pointer -fsanitize=thread \
        -fno-sanitize-recover=all

# MSan (requires instrumented stdlib, usually via libc++ built with MSan)
clang++ -O1 -g -fno-omit-frame-pointer \
        -fsanitize=memory -fsanitize-memory-track-origins=2 \
        -stdlib=libc++ -L/opt/libcxx-msan/lib
```

`-fno-sanitize-recover=all` turns warnings into aborts, which is essential. A sanitizer that logs and continues is silently ignored by developers.

### Why you cannot combine sanitizers

ASan and TSan share shadow memory regions and cannot be linked together. MSan and ASan similarly. Run them as separate jobs. A single TSan job plus a single ASan+UBSan job plus an MSan job is the minimum, and each must run the full test suite.

### Production canary with sanitizers

Sanitizers have 2-10x memory overhead and 10-30 percent CPU overhead. Too expensive for the whole fleet, cheap for a canary. Run one percent of production traffic on an ASan binary with error reporting to a crash bucket. The signal catches real user inputs that synthetic tests miss, and it catches late-stage UAFs that fuzzing misses because the lifecycle requires real-time state.

Configure via environment:

```
ASAN_OPTIONS=abort_on_error=1:detect_leaks=1:strict_string_checks=1:\
check_initialization_order=1:strict_init_order=1:\
detect_stack_use_after_return=1:halt_on_error=1:\
symbolize=1:print_stacktrace=1
UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1:abort_on_error=1
LSAN_OPTIONS=suppressions=/etc/lsan.suppressions
```

`detect_stack_use_after_return` is off by default because it doubles stack memory. Enable it in the canary job, it catches returning pointers to locals that survive to the next call.

### Suppressions: the two categories

Every codebase accumulates suppressions. Two categories, managed separately:

1. **Third-party library noise.** OpenSSL, glibc internals, intentionally-racy published benchmarks. Pin to specific function names and review quarterly.
2. **Known internal issues with tickets.** Each entry carries a bug number and a remove-by date. CI fails if any suppression is older than 90 days past its remove-by.

```
# lsan.suppressions
leak:openssl_bss_*
leak:InternalConfigLoader  # BUG-4217, remove-by=2026-06-01
```

Indefinite suppressions without tickets are how sanitizer coverage degrades into theater.

### Sanitizer-safe allocator interactions

ASan replaces malloc/free and intercepts `operator new`. Custom allocators (jemalloc, tcmalloc, arena allocators) must cooperate. For jemalloc, build with `--disable-initial-exec-tls` and link ASan first. For arena allocators, call `__asan_poison_memory_region` on freed chunks so ASan flags use-after-free even within arenas:

```cpp
#include <sanitizer/asan_interface.h>

void Arena::Free(void* p, size_t n) {
    __asan_poison_memory_region(p, n);
    // chunk returned to freelist, not to malloc
}

void* Arena::Alloc(size_t n) {
    void* p = AllocFromFreelist(n);
    __asan_unpoison_memory_region(p, n);
    return p;
}
```

Without this, ASan thinks the arena memory is always live and misses every arena-based UAF.

### TSan under real-world workloads

TSan's memory overhead is 5-10x and CPU overhead is 5-15x. Run TSan against a deterministic integration test, not against a stress test that demands full production throughput. For workloads that exceed memory budget, use `-fsanitize=thread -mllvm -tsan-compound-read-before-write=true` to reduce shadow memory at the cost of some race detection.

TSan reports races by stacks of the two conflicting accesses. 80 percent of reports are benign (lock-free atomics used correctly that TSan cannot prove), 20 percent are real bugs. Train the team to triage by reading both stacks, not by suppressing the line.

### Hardened mode for release

`-fsanitize=address` is too expensive for release. `-fsanitize=safe-stack` and `-fstack-protector-strong` are cheap. Enable them on every release binary:

```
-fstack-protector-strong
-fstack-clash-protection
-D_FORTIFY_SOURCE=3
-fcf-protection=full         # Intel CET
-mbranch-protection=standard # ARM PAC/BTI
-Wl,-z,relro -Wl,-z,now
-Wl,-z,noexecstack
-pie -fPIE
```

This is not sanitizer-class coverage, it is exploit mitigation that makes the remaining bugs harder to turn into RCE. Layered defense.

### Onboarding new code

A new file enters the codebase only if it compiles cleanly under all three sanitizer builds. CI rejects pull requests that add suppressions without a linked ticket. This is the single most effective policy for keeping a C++ codebase under 10 sanitizer findings per million lines.
