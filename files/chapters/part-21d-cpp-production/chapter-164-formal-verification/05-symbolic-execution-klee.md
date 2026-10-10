## Symbolic Execution and KLEE

Symbolic execution sits between fuzzing and BMC. Instead of running the program on concrete values, you run it on **symbolic** values: each input is a variable in an SMT formula, and at every conditional branch the engine forks the state, accumulating a path condition. When a path terminates (return, assertion, crash), the solver checks whether the path condition is satisfiable, and if so produces a concrete witness.

### KLEE in 60 seconds

KLEE (Cadar, Dunbar, Engler, OSDI 2008) operates on LLVM bitcode. The original paper showed KLEE finding ten years of accumulated bugs in GNU coreutils, including a `paste` bug that crashed on 2-byte inputs.

```c
#include <klee/klee.h>

int main(void) {
    int a, b;
    klee_make_symbolic(&a, sizeof(a), "a");
    klee_make_symbolic(&b, sizeof(b), "b");

    if (a > 0) {
        if (b > 0) {
            if (a + b < a) {           // overflow
                klee_assert(0);
            }
        }
    }
    return 0;
}
```

```sh
clang -emit-llvm -c -g -O0 -Xclang -disable-O0-optnone overflow.c -o overflow.bc
klee --libc=uclibc --posix-runtime overflow.bc
```

KLEE explores three paths and finds the one where `a > 0 && b > 0 && a + b < a` is satisfiable (large `a` plus large `b` overflowing). Output:

```
KLEE: ERROR: ASSERTION FAIL: 0
KLEE: NOTE: now ignoring this error at this location
KLEE: done: total instructions = 142
KLEE: done: completed paths = 4
KLEE: done: generated tests = 4
```

Tests are emitted to `klee-out-N/` as `.ktest` files. Replay with `klee-replay`:

```sh
klee-replay ./overflow_concrete klee-out-0/test000003.ktest
# a=2147483647 b=1
```

### Path explosion

The fundamental cost. Every branch doubles paths. A loop with N iterations and a branch in the body has 2^N paths. KLEE fights this with:

- **Search heuristics**. Random path, coverage-guided, depth-first. None is optimal globally.
- **State merging**. Two states reaching the same program point with different path conditions can merge into one with a disjunctive condition. Saves exploration but creates harder SMT queries.
- **Concolic execution** (concrete + symbolic). Run on a concrete input, log the path, then symbolically analyze only that path. SAGE (Microsoft) pioneered this approach.
- **Lazy initialization** of symbolic memory. Allocate symbolic regions only when accessed.

Realistic budget: KLEE can exhaustively explore programs of a few thousand lines with bounded loops. Beyond that, you set a timeout and accept partial coverage.

### Symbolic memory

The hard part. Pointers can be symbolic, which means a load or store can target a symbolic address, which means the SMT solver must reason about which object it might alias. KLEE handles this with **object-level memory**: each `malloc` creates an object, and pointers carry an object id plus an offset.

```c
char buf[16];
int i;
klee_make_symbolic(&i, sizeof(i), "i");
char c = buf[i];           // symbolic index into a concrete object
```

KLEE forks one state per feasible value of `i` modulo the object's size. With `--max-memory-inst-time` you bound how long it spends per symbolic load.

### Production users

- **SAGE** (Microsoft, internal). Concolic fuzzing on Windows binaries. Found over a third of the security bugs in Windows 7 file format parsers, per Patrice Godefroid's reports.
- **angr** (UC Santa Barbara, Shellphish). Symbolic execution on binaries for reverse engineering, CTF, and CFG recovery. Used in DARPA Cyber Grand Challenge 2016.
- **Mayhem** (ForAllSecure, spun out of CMU). Won DARPA CGC. Now sold commercially as a binary fuzzer plus symbolic engine.
- **manticore** (Trail of Bits). Symbolic execution for EVM smart contracts and x86/ARM binaries.
- **S2E** (EPFL, now archived). Selective symbolic execution on full system images, used in academic work on driver verification.

As of 2026, the actively maintained open-source line is KLEE (still developed at Imperial), angr, and manticore. KLEE 3.1 added LLVM 17 support and improved persistent constraint solver caching.

### What KLEE proves

If KLEE explores all paths within budget without finding a violation, the property holds for all inputs reachable through those paths up to the loop bound. If it does not finish, you have **partial verification**: fuzzing-grade evidence with the bonus of structured path coverage.

The honest claim:

- **Found a bug**: definitive, here is the witness.
- **No bug found within N hours**: the property holds for the explored fragment, no completeness claim.

### Concolic mode and hybrid fuzzing

KLEE-Native and SymCC (Sebastian Poeplau, EuroSec 2020) compile symbolic execution into the binary, achieving 10x to 100x speedup over interpreted KLEE. SymCC integrates with AFL++ as a "hybrid fuzzer": AFL does coverage-guided mutation, SymCC solves complex branch conditions AFL cannot crack (magic numbers, checksums).

```sh
afl-fuzz -i corpus -o out -M main -- ./target @@
# in parallel:
afl-fuzz -i corpus -o out -S symcc -c ./target_symcc -- ./target @@
```

This is the modern benchmark for finding bugs in 2026: AFL++ for breadth, SymCC or KLEE for the branches AFL gets stuck on.

### Limitations specific to C++

- **Exceptions**. KLEE handles them via the LLVM Itanium ABI, but exception-heavy code generates exponential extra paths.
- **Virtual dispatch**. Each indirect call forks on every possible target. With templates instantiated, this is tractable. With heavy polymorphism, it explodes.
- **STL allocators**. Symbolic allocation through `std::allocator` works but is slow. Most C++ KLEE work replaces the allocator with a fixed-size arena for verification.
- **Templates**. KLEE sees post-instantiation IR, so templates work but coverage is per-instantiation.

### Practical workflow

1. Write a small `main` that calls one function with `klee_make_symbolic` inputs.
2. Bound input sizes (`klee_assume(n < 16)`).
3. Add `klee_assert` for properties.
4. Build with `clang -emit-llvm -O0 -g`.
5. Run with `klee --libc=uclibc --max-time=600 --max-memory=4000`.
6. Inspect `klee-out-*/info`, `messages.txt`, and any `.err` files.
7. Replay failing tests, fix the code, re-run.

### Decision criterion

Reach for symbolic execution when:

- You want **inputs** that exercise a path, not just a yes/no answer.
- The function has tricky data-dependent control flow that fuzzing struggles to crack.
- You can bound input sizes meaningfully.

Avoid it when:

- The state space is genuinely exponential and even bounded coverage will miss real bugs.
- The codebase is heavily polymorphic C++ with no clean entry point.
- Random fuzzing is already finding bugs faster.

> **Senior at FAANG.** The right way to deploy KLEE today is as a hybrid partner to AFL++, not a replacement. Run AFL++ continuously on your parsers and codecs, and reach for SymCC or KLEE when AFL stalls on a coverage plateau. Symbolic execution as a standalone strategy was a 2008 paper. Hybrid fuzzing is the 2026 deployment.
