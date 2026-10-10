## TSan and Data Race Detection

ThreadSanitizer is the most effective tool ever shipped for finding data races in C++. If your code uses threads and you do not run TSan in CI, you have data races you do not know about. This file covers how TSan works, what it can and cannot detect, and how to integrate it into a real workflow.

### The Two Algorithm Families

Data race detectors fall into two families:

**Lockset algorithms** (Eraser, 1997). Track the set of locks held during each access to each shared variable. If two threads access the same variable while holding disjoint lock sets, report a race. Pros: simple, catches violations of locking discipline. Cons: many false positives on lock-free code, on RCU, on read-only initialization.

**Happens-before algorithms** (Lamport vector clocks, 1978). Track the happens-before relation across operations. Two accesses race iff they conflict and neither happens-before the other. Pros: precise, no false positives on properly synchronized code. Cons: needs to track every synchronization op, higher memory cost.

TSan is happens-before based, with optimizations to keep memory cost manageable.

### TSan v2 Algorithm

TSanv2 (Google, 2014, Dmitry Vyukov et al.) uses:

- Per-thread vector clocks compressed to N integers (N = max thread count, typically 256).
- Per-byte shadow memory: 4 shadow words per byte, each holding (thread_id, op_type, vector_clock, scope).
- On each load and store, look up the shadow words. If any concurrent access exists with no happens-before, report a race.

Memory cost: 8x slowdown, 5-10x memory increase. Acceptable in CI, painful in production. Production deployment is rare.

Synchronization tracking:
- `pthread_mutex_lock`/`unlock`: vector clock merge on lock, increment on unlock.
- `pthread_cond_wait`: full barrier.
- `std::atomic` ops: tracked with the right memory order semantics.
- Custom synchronization (busy-wait on volatile, asm barriers): NOT tracked. TSan reports false positives.

TSan integrates with libc, libpthread, glibc primitives, and a wide range of GCC and Clang atomic builtins. Custom synchronization needs annotations.

### Integration

GCC and Clang both support `-fsanitize=thread`. Linking and runtime are similar.

```sh
clang++ -O1 -g -fsanitize=thread mycode.cc -o mycode
./mycode
```

`-O1` is recommended (not -O0, not -O3). At -O0 the slowdown is unbearable. At -O3 some optimizations confuse TSan's stack frame tracking.

In CI, run unit tests under TSan. Fail the build on any race report. This catches new races as they are introduced, rather than at deployment time.

### Annotations

TSan provides annotation macros for custom synchronization that it cannot infer:

```cpp
// Tell TSan that this operation happens-before another
ANNOTATE_HAPPENS_BEFORE(addr);

// In the consuming thread, before reading:
ANNOTATE_HAPPENS_AFTER(addr);

// Mark a benign race that you have audited and know is safe:
ANNOTATE_BENIGN_RACE(&var, "approximate counter");

// Suppress all race reports on this variable:
ANNOTATE_BENIGN_RACE_SIZED(addr, size, "description");
```

The benign race annotations are dangerous. The C++ standard says any race is undefined behavior. Even "benign" races can compile to surprising assembly: torn loads, repeated reads, rematerialized values. Treat the annotation as a last resort and document the audit.

### Suppressions

A `tsan_suppressions.txt` file lists patterns to ignore:

```
race:my_legacy_module::*
race:*malloc*
mutex:GlobalLock
```

Read with `TSAN_OPTIONS=suppressions=tsan_suppressions.txt`. Suppressions are useful for third-party libraries you cannot fix, kernel/userspace boundaries that confuse TSan, and known-safe (with audit) races.

Each suppression should have a comment naming the audit, the issue tracker entry, and the date. "We turned this off and forgot" suppressions accumulate forever.

### Atomic Ops and TSan

TSan understands `std::atomic` semantics. A relaxed atomic store followed by a relaxed atomic load on a different thread does not race (atomic ops are not data races by definition), but TSan also tracks the memory order to validate that the synchronization actually happens.

```cpp
std::atomic<bool> flag{false};
int data = 0;

// T1
data = 42;                                       // non-atomic
flag.store(true, std::memory_order_release);    // release

// T2
while (!flag.load(std::memory_order_acquire)) {} // acquire
int v = data;                                    // non-atomic
```

TSan sees that the release-acquire pair establishes happens-before and accepts the non-atomic accesses to `data`. If you change the memory order to relaxed:

```cpp
flag.store(true, std::memory_order_relaxed);    // BUG
flag.load(std::memory_order_relaxed);           // BUG
```

TSan reports a data race on `data`. Even though the atomic ops are atomic, they do not synchronize, so the non-atomic `data` accesses race.

This is exactly the kind of bug TSan catches that no other tool does. Code review misses it. x86 testing misses it (TSO covers up the bug). TSan finds it.

### What TSan Cannot Detect

- **Deadlocks**: Use `pthread_mutex` deadlock detection or `absl::Mutex` debug mode.
- **Memory order misuse on properly atomic code**: TSan does not validate that you used the right order, only that there is some order. acq_rel where seq_cst is needed (IRIW pattern, discussed in the seq_cst vs acq_rel section) is not caught.
- **ABA problem**: Not a race, a logical error. CAS succeeds when it should fail.
- **Livelock**: Not a race, a progress problem.
- **Memory leaks**: Use ASan or LeakSanitizer.
- **Bugs in TSan's interceptors**: If TSan does not intercept your synchronization primitive, it reports false positives. Older PTHREADs barriers, custom RCU, futex-based locks may not be tracked.

### Benign Race Myth

WG21 papers (P1118 and onward) and the standard itself state: any data race is undefined behavior. There is no "benign race" in the language standard.

In practice some races do not cause observable bugs on most platforms. A statistics counter incremented racily produces approximate counts. The compiler usually does not exploit the UB in catastrophic ways for this pattern.

But "usually" is not "always". Compilers have been known to:

- Compile a non-atomic store as multiple narrower stores.
- Remove a non-atomic load that is "obviously dead" but is actually used by another thread.
- Compile a racy increment to a load-modify-store with multiple writes.
- Optimize a racy boolean read to use the value before the write.

The safe fix: use `std::atomic<int>` with `relaxed` order for any concurrently-accessed counter. The cost on x86 is identical to the non-atomic version. The compiler is now constrained to emit a single load and a single store. The "benign" race becomes a tracked atomic.

WG21's official position: all races are bugs, period. TSan reports them, you fix them.

### ThreadSanitizer in CI for New Code

Recommended workflow:

1. **All new code paths must be TSan-clean**. CI runs the test suite under TSan and fails on any report.
2. **Existing code with known TSan reports**: fix incrementally. Suppress with documented annotations until fixed.
3. **Production canary with TSan-instrumented binary**: rare, but useful for hard-to-reproduce races. Performance hit means low traffic only.
4. **Pair TSan with stress testing**: run unit tests with `--gtest_repeat=1000 --gtest_shuffle` to surface races that depend on schedule.

Time budget: TSan adds ~10x to test runtime. For a CI suite that takes 10 minutes, TSan adds 100 minutes. Run TSan on a separate slow-CI lane that does not block PR merges but does block weekly release tags.

### Other Race Detectors

- **Helgrind** (Valgrind): works without recompilation. Slower than TSan (50-100x). Useful when you cannot rebuild a binary.
- **Intel Inspector**: commercial, integrates with Intel toolchain. Similar coverage to TSan.
- **Coverity**: static, finds some races without execution. Misses many.
- **Java's TSan equivalent**: Java has built-in concurrency debugger via JFR.
- **Go's race detector**: uses TSan internally.
- **Rust**: most data races are caught at compile time. Loom checks the rest.

For C++, TSan is the default choice. Helgrind for binary-only cases.

### Junior at FAANG vs Senior at FAANG

Junior's CI builds and tests the project under -O2, no sanitizers. They ship. Customer reports rare crashes that only happen on Tuesdays after lunch. After a week of debugging, they find a missing `std::memory_order_release`. Senior's CI runs every test under TSan, ASan, UBSan, MSan in parallel lanes. The release was caught in the PR that introduced it.

The senior also writes negative tests: tests that intentionally exercise the race window with `std::this_thread::yield()` and assertions about expected behavior. TSan + the negative test catches both the race and any future regression that reintroduces it.

The cost is real. TSan slows CI by 10x. But shipping a race to production costs more, especially when it manifests as silent corruption rather than a crash. The asymmetry favors TSan.
