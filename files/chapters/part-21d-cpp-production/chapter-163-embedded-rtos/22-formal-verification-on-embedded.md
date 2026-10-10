## Formal Verification on Embedded

Static analysis catches a category of bugs by pattern matching on suspicious constructs. Formal verification is stronger: it proves, for every possible input and every possible execution path, that a program does not have certain classes of defects. The cost is engineer time. The benefit is mathematical certainty for code that flies airplanes, drives cars, or keeps a pacemaker running.

For most application code, formal verification is overkill. For ASIL D firmware, DO-178C Level A avionics, IEC 62304 Class C medical, and IEC 61508 SIL 4 industrial, it is the only way to make the safety case.

### What Formal Verification Proves

The standard targets:

**Absence of runtime errors.** No null pointer dereferences, no division by zero, no out-of-bounds array access, no signed integer overflow, no use-after-free, no uninitialized read.

**Absence of dead code.** Every line is reachable on some legitimate execution path.

**Functional correctness.** The function returns a value satisfying a specified post-condition for every input satisfying the pre-condition.

**Resource bounds.** The function terminates in a bounded number of cycles. The function uses a bounded amount of stack.

**Concurrency properties.** Two threads do not race on a shared variable. A lock is acquired before access and released after. A deadlock cannot occur in the lock graph.

The first three are the most commonly proved in practice.

### Astree

Astrée is a static analyzer from AbsInt that uses abstract interpretation to prove the absence of runtime errors in C and C++ programs. It was famously used to verify the flight control software for the Airbus A380 and now ships in many automotive and aerospace certification packages.

The way Astrée works: it takes a C/C++ program, builds an abstract model of every variable's possible values at every program point, and checks that no operation can produce an undefined result. If Astrée reports zero alarms on a translation unit, you have a proof that the unit has no runtime errors.

The catch is that Astrée's abstraction may be too coarse, producing false positives. The engineer's job is to add code annotations or refactor to give Astrée enough information. A typical workflow:

1. Run Astrée on the codebase.
2. Triage alarms. False positives are due to imprecise abstraction.
3. Add `__ASTREE_assert` directives or refactor the code.
4. Re-run.
5. Repeat until zero alarms.

Astrée is the gold standard but the licenses are expensive (tens of thousands of euros per seat) and the learning curve is steep. Avionics shops budget weeks per developer for the initial training.

### Frama-C and the EVA Plugin

Frama-C is an open-source platform for formal verification of C programs. The EVA plugin (Evolved Value Analysis) is the equivalent of Astrée: it computes value ranges at every program point and reports possible runtime errors.

A small example:

```c
// file: brake.c
/*@ requires \valid(input);
    requires \valid(output);
    requires *input >= 0 && *input <= 100;
    ensures *output >= 0 && *output <= 1000;
*/
void compute_brake_force(int* input, int* output) {
    if (*input > 50) {
        *output = (*input - 50) * 20;
    } else {
        *output = 0;
    }
}
```

The ACSL annotations (formal specification) declare the pre-conditions and post-conditions. EVA proves that for every input satisfying the pre-conditions, the function does not have a runtime error and produces an output satisfying the post-condition.

```
frama-c -eva brake.c
```

If EVA reports "no alarms," the proof is complete. If it reports alarms, either the code is wrong or the specification is too weak.

C++ support in Frama-C is partial. The `Frama-C/Clang` plugin is in active development but not yet at the maturity of the C support. Most C++ formal verification work in 2026 is done by translating critical C++ code to C-equivalent for analysis, or by using the Coq-based proof assistant directly.

### Runtime Assertion Checking

Formal proofs are ideal but not always feasible. The next-best thing is to compile assertions into the runtime so any violation halts the program immediately, near the cause. The `assert` macro from `<cassert>` is the classic, but it has issues in embedded:

- `assert` calls `abort` which calls `__assert_fail` which prints to stderr, all of which are heavyweight on a microcontroller
- In release builds, `assert` is typically removed by `NDEBUG`
- The diagnostic message includes the source file and line, embedded in the binary, which costs flash

The standard embedded replacement:

```cpp
#define EMBED_ASSERT(cond) \
    do { \
        if (!(cond)) { \
            on_assertion_failed(__FILE__, __LINE__); \
        } \
    } while (0)

[[noreturn]] void on_assertion_failed(const char* file, int line) {
    log_critical("ASSERT FAILED %s:%d", file, line);
    if (in_debugger()) asm volatile("bkpt #0");
    save_state_for_post_mortem();
    NVIC_SystemReset();
}
```

In safety-critical code, assertions stay in the release build. Their performance cost is paid against the certainty that any logic error is detected.

The MISRA / AUTOSAR coding standards typically require that every public function check its preconditions with assertions, and that every internal invariant be asserted at the point it should hold. The result is code peppered with assertions, which makes static analysis easier (the analyzer can use the assertion as an assumption) and field debugging trivial (an assertion failure pinpoints the issue).

### Bounded-Stack Analysis

Stack overflow is one of the most pernicious bugs in embedded code. It manifests hours after the actual overflow, often in a completely unrelated module, and the root cause is buried in interrupt latency or recursion that no one anticipated.

Bounded-stack analysis statically computes the maximum stack a function can use, given its call graph. Tools:

- **GCC's `-fstack-usage`**: emits per-function stack size information
- **AbsInt StackAnalyzer**: traces the call graph and reports per-task worst-case stack
- **EmBitz, Eclipse Embedded plugins**: integrate with GCC's output

A typical analysis:

```
$ arm-none-eabi-g++ -fstack-usage -O2 -c app.cpp
$ cat app.su
src/app.cpp:24:6:control_loop      512    static
src/app.cpp:55:6:filter_step       128    static
src/app.cpp:79:6:debug_print     2048   dynamic,bounded
```

The "static" lines are stack frames computed at compile time. The "dynamic, bounded" lines have variable-sized stack (alloca, VLAs) where the bound is documented. "Dynamic" without a bound is a red flag in safety code.

Combined with the call graph, you compute the maximum stack any task can use:

```
control_loop(512)
  -> read_sensors(256)
    -> i2c_transaction(128)
      -> log_sensor_value(384)
  -> compute_pid(192)
  -> apply_actuators(128)
Worst case: 512 + 256 + 128 + 384 = 1280 bytes
```

The task stack is sized at 1280 bytes plus a margin (typically 25 percent), so 1600 bytes. Anything less is a future overflow.

Recursive functions are a problem because the call graph is unbounded. MISRA / AUTOSAR forbid recursion in safety-critical code for exactly this reason (rule A7-5-2, "Functions shall not call themselves directly or indirectly"). The exceptions are tail-call recursion that the compiler converts to a loop, and recursion with an explicit bounded depth.

### WCET (Worst-Case Execution Time) Analysis

WCET analysis answers the question "how long, in the worst case, does this function take to execute?" Required for hard real-time systems where missing a deadline is a system failure.

Two approaches:

**Measurement-based.** Run the function many times with worst-case inputs and measure. Fast but cannot guarantee the worst case was actually exercised.

**Static.** Build a model of the CPU pipeline, the cache, the branch predictor, and the memory system, analyze the function's instruction stream against the model. Slower but provides a provable upper bound.

Tools:

- **AbsInt aiT**: widely adopted WCET analyzer for Cortex-M, Cortex-R, Cortex-A, PowerPC, and Tricore
- **OTAWA**: open-source WCET tool, suitable for less complex CPUs
- **RapiTime**: hybrid measurement and static analysis

A typical aiT report:

```
Function: control_loop
  WCET: 4382 cycles
  Instructions: 612
  Cache misses (worst case): 18
  Pipeline stalls (worst case): 47
  Branch mispredicts: 3
```

At 168 MHz, 4382 cycles is 26 microseconds. The control loop runs every 100 microseconds, so the worst case fits with 74 microseconds of margin. Acceptable.

WCET analysis is sensitive to compiler version, optimization flags, and silicon revision. A safety-critical project pins all of those and re-runs the analysis on every change.

### Practical Adoption

For most embedded C++ work in 2026, the formal verification stack looks like:

- **Always**: GCC `-fstack-usage`, runtime assertions, MISRA static analysis
- **Safety-critical**: add Astrée or Frama-C/EVA, aiT or OTAWA for WCET
- **Highest assurance** (DO-178C Level A, ASIL D): add Coq or Isabelle/HOL proofs of critical algorithms, formal model checking of state machines, and external audit by a certification authority

The cost grows roughly linearly with the assurance level. A company shipping 10 ASIL D ECUs supports an internal verification team of 5-15 engineers, each handling tools like Astrée full time. The output is the safety case binder that an external assessor reviews before the part can ship into a vehicle.

---
