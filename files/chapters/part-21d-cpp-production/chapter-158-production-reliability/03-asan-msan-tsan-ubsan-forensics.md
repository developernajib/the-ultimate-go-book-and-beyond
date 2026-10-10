## Sanitizer Forensics: ASan, MSan, TSan, UBSan

The four LLVM sanitizers are the most powerful production-correctness tools ever built for C++. A senior engineer reads sanitizer reports the way a junior reads compiler errors: at a glance, with no friction, knowing exactly which line to look at first.

### What Each Sanitizer Catches

**AddressSanitizer (ASan)**: heap-buffer-overflow, stack-buffer-overflow, use-after-free, use-after-return, use-after-scope, double-free, invalid-free, memory leaks (with `LSan`). Roughly 2x slowdown, 3x memory overhead. Standard build flag: `-fsanitize=address -fno-omit-frame-pointer -O1`.

**MemorySanitizer (MSan)**: reads of uninitialized memory. About 3x slowdown, 2x memory. Requires that **all** dependencies (including libc++) be MSan-instrumented. This is the killer constraint, so MSan is rarely run in production environments and usually lives in a hermetic CI build.

**ThreadSanitizer (TSan)**: data races. About 5 to 15x slowdown, 5 to 10x memory. The slowdown is non-uniform (heavily-locked code is much slower). TSan only finds races that actually execute, so coverage in CI is critical.

**UndefinedBehaviorSanitizer (UBSan)**: signed integer overflow, alignment errors, nullptr dereference, invalid enum values, divide by zero, shift by large or negative values, vptr corruption. Near-zero slowdown. There is no excuse not to ship `-fsanitize=undefined` in CI on every build.

ASan and MSan are mutually exclusive (both reserve the shadow memory map). TSan is mutually exclusive with both. UBSan composes with all of them.

### Decoding an ASan Report

```
==18293==ERROR: AddressSanitizer: heap-use-after-free on address 0x602000000050
READ of size 8 at 0x602000000050 thread T3
    #0 0x4a3b91 in Cache::Get(int) cache.cc:42:16
    #1 0x4a51c2 in Server::HandleRequest(Request*) server.cc:178:12
    ...
0x602000000050 is located 0 bytes inside of 16-byte region [0x602000000050,0x602000000060)
freed by thread T1 here:
    #0 0x4a8000 in operator delete(void*) sanitizer
    #1 0x4a2110 in Cache::Evict() cache.cc:88:9
previously allocated by thread T1 here:
    #0 0x4a7000 in operator new(unsigned long) sanitizer
    #1 0x4a1f33 in Cache::Insert(int, std::string) cache.cc:23:14
```

Three pointers into your code. Read them in this order:

1. **The crash site** (top of the report): `cache.cc:42` is reading freed memory.
2. **The free site**: `cache.cc:88` freed it. This is `Cache::Evict()`.
3. **The allocation site**: `cache.cc:23` allocated it. This is `Cache::Insert()`.

Now you have the lifetime: allocated by `Insert`, freed by `Evict`, dereferenced by `Get`. The bug is that `Get` is racing `Evict` without synchronization, or `Get` is holding a raw pointer past the lifetime guarantee. The fix is `std::shared_ptr` with atomic load, or a refcount, or a hazard pointer, depending on the latency budget.

### Common Patterns

**heap-buffer-overflow**: classic off-by-one. Look for `<=` where `<` was meant, or a `memcpy` whose source size differs from the destination capacity. ASan tells you the exact byte offset (3 bytes past the end). Fix the loop condition.

**stack-use-after-return**: returning a pointer to a local. The function returned, the stack frame was reused, and a later read sees garbage. ASan needs `ASAN_OPTIONS=detect_stack_use_after_return=1` to catch this, it is off by default. Fix: return by value (copy/move elision), or allocate on the heap.

**stack-use-after-scope**: a pointer outlives its block. Common with C++17 structured bindings or lambda captures of references. Fix: capture by value, or extend the lifetime.

**use-after-free** (UAF): the most dangerous bug class. Often caused by raw pointer caches that miss a deletion notification, or by lambdas that capture `this` and outlive the object. Fix: shared ownership, weak pointers, or a deferred-deletion scheme like RCU.

**double-free**: usually a missing rule-of-five. A class allocates in its constructor, destroys in its destructor, but the implicit copy constructor copies the pointer instead of the resource. Two destructors run on the same pointer. Fix: rule of five, or `=delete` the copy constructor.

### Suppressions

Sometimes you cannot fix the source: a third-party library has a known UAF in a code path you do not exercise, or a TSan race is in a benchmark library that you do not control. Suppression files let you silence specific reports without disabling the sanitizer.

`asan_suppressions.txt`:

```
# Known leak in third_party/crufty_lib, see issue #4711
leak:CruftyLib::InitOnce
# Off-by-one in vendored heap, fix landing in vendor v3.2
race:VendorAllocator::Free
```

```bash
$ ASAN_OPTIONS=suppressions=asan_suppressions.txt:detect_leaks=1 ./mybin
```

The discipline: every suppression has an issue number. Suppressions are reviewed monthly. A suppression without an owner is a bug waiting to bite.

### SAN Builds in CI vs Production Sampling

Two patterns:

**SAN_BUILDS in CI**: every pull request runs the test suite under ASan and UBSan. Nightly runs add MSan and TSan. The slowdown is acceptable because CI is asynchronous. This is the table-stakes baseline. If your team is not doing this, you have a single weekend's work that will pay back for years.

**Production SAN canary**: 0.1% to 1% of production traffic is routed to instances built with ASan. The 2x slowdown is absorbed by the canary's small share of capacity. The benefit is catching bugs that only manifest on real traffic patterns, with real cardinality, real adversarial inputs, and real concurrency. Google runs this for many services. It catches an order of magnitude more UAF bugs than CI does.

The sampling math: if your bug fires once per million queries and you sample 1% of traffic, you catch the bug after roughly 100 million queries to the canary. At 10K QPS to the canary, that is roughly 3 hours of SAN-canary uptime per detection event. Worth it.

### Performance Overhead Numbers (typical)

These are rough numbers from running the four sanitizers across real C++ services. Your mileage will vary.

```
Sanitizer    CPU slowdown   Memory overhead   Compatible with
---------    ------------   ---------------   ----------------
ASan         1.5x to 3x     2x to 4x          UBSan
MSan         3x             1.5x to 2x        UBSan, but all deps must be MSan-built
TSan         5x to 15x      5x to 10x         UBSan
UBSan        ~1.05x         negligible        any
LSan         negligible     negligible        ASan (built in) or standalone
```

UBSan is free. There is no excuse not to ship UBSan in your default optimized build, with the trap-on-error variant for production (`-fsanitize-trap=undefined`) which makes UB crash deterministically with a `SIGILL` instead of printing and continuing.

### Real Bugs the Sanitizers Found

ASan found a UAF in Chrome's V8 garbage collector that escaped review for two years.

TSan found a data race in MySQL's group commit logic that manifested as silent data corruption under specific replication topologies.

MSan found that OpenSSL was reading uninitialized memory as part of its random pool seed, which is a security bug, not just a correctness one.

UBSan found a signed integer overflow in zlib that became a CVE.

In every case, the bug had survived years of human code review and was caught by a tool that runs in seconds.

### Senior at FAANG: The Mental Move

The senior move is not "I know how to read a sanitizer report." It is: "I instrumented the SAN canary, set up the sampling rate, configured the suppression workflow, automated the issue-creation when a new stack-hash appears, and integrated the report into our weekly reliability review." Sanitizers are not a debugging tool. They are a production capability.

---
