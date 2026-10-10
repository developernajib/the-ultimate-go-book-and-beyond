## Exercises

Six lab exercises, increasing in difficulty. Each is sized for one to three engineer-days of focused work. Do them in order, each builds vocabulary and intuition for the next.

---

### Lab 1: Property-based testing with RapidCheck

**Goal.** Build fluency with property-based testing on a small data structure.

**Setup.**

1. Install RapidCheck (`vcpkg install rapidcheck` or fetch from GitHub).
2. Implement a `RingBuffer<T>` with `push`, `pop`, `size`, `capacity`, and `is_full`/`is_empty` methods. Fixed capacity, no allocation after construction.

**Tasks.**

1. Write at least five properties:
 - After `push` followed by `pop`, the original value is recovered.
 - `size <= capacity` always.
 - `is_empty()` iff `size == 0`.
 - `is_full()` iff `size == capacity`.
 - Round-trip: push N values, pop N values, the order is preserved.
2. Write a stateful test using `rc::state` that runs random sequences of `push`, `pop`, and queries against a `std::queue<T>` model.
3. Introduce a deliberate bug (e.g., off-by-one in the wrap-around). Watch RapidCheck shrink to a minimal counterexample.
4. Document your generators. Where did you constrain inputs, and why?

**Deliverable.** Source code, a short document describing each property, and a screenshot or log of the shrunk failure.

---

### Lab 2: Frama-C/WP on a numeric utility

**Goal.** Write ACSL annotations and discharge them with Frama-C WP.

**Setup.** Install Frama-C 28+ and the Alt-Ergo, Z3, and CVC5 SMT solvers. Frama-C is easiest to install via opam (`opam install frama-c alt-ergo`).

**Code.**

```c
#include <stddef.h>
#include <limits.h>

int saturating_sum(const int *a, size_t n);
```

The function returns the sum of the array, saturating at `INT_MAX` or `INT_MIN` rather than overflowing.

**Tasks.**

1. Write the ACSL contract: `requires`, `ensures`, `assigns`. The post-condition should describe both the saturation behavior and the non-saturation case.
2. Implement `saturating_sum` correctly.
3. Write the loop invariant and loop variant.
4. Run `frama-c -wp -wp-rte saturating.c` until all goals discharge.
5. Deliberately introduce a bug (e.g., off-by-one in loop bound or wrong saturation direction) and confirm the proof fails. Inspect the failed obligation.

**Deliverable.** Source code with annotations, a shell transcript of the WP run, and a one-paragraph reflection on what was hard.

---

### Lab 3: CBMC harness for a small parser

**Goal.** Build a CBMC proof of memory safety for a length-prefixed parser.

**Setup.** Install CBMC 5.x (`apt install cbmc` on Debian/Ubuntu, or build from source).

**Code.**

```c
#include <stdint.h>
#include <stddef.h>

// Reads a length-prefixed byte string from `input` of total size `n`.
// On success: returns 0, *out_len contains the length, *out_data points
// into input. On error: returns -1.
int parse_lpstring(const uint8_t *input, size_t n,
                   const uint8_t **out_data, size_t *out_len);
```

The format: 4-byte big-endian length prefix, followed by that many bytes of data.

**Tasks.**

1. Implement `parse_lpstring`. Make at least one bug deliberate (e.g., not checking that `length + 4 <= n`).
2. Write a CBMC harness with `__CPROVER_assume(n <= 64)`.
3. Add assertions: on success, `out_len <= n - 4`, the returned `out_data` points within `input`.
4. Run CBMC with `--memory-leak-check --bounds-check --pointer-check --signed-overflow-check --unsigned-overflow-check --unwind 65 --unwinding-assertions`.
5. Inspect the counterexample. Fix the bug. Re-verify.
6. Increase the bound from 64 to 256. Note the wall-clock impact.

**Deliverable.** Source, harness, the failing CBMC trace, the fix, and the passing run.

---

### Lab 4: TLA+ specification of two-phase commit

**Goal.** Write and model-check a TLA+ specification of a small distributed protocol.

**Setup.** Install the TLA+ Toolbox or the VS Code TLA+ extension. Install Apalache for the bonus part.

**Tasks.**

1. Write a PlusCal spec of two-phase commit with one transaction manager (TM) and three resource managers (RMs). Cover prepare, commit, and abort messages.
2. Specify the safety invariant: no two RMs reach contradictory committed/aborted states.
3. Run TLC with three RMs and verify the invariant holds.
4. Add a failure mode: a RM may crash after sending "prepared" but before receiving the commit decision. Observe what the safety invariant requires (recovery via persisted decision log).
5. Write a liveness property: every transaction eventually reaches a decided state under appropriate fairness assumptions.
6. Bonus: re-check with Apalache (`apalache-mc check`). Compare run times to TLC.

**Deliverable.** TLA+ spec, model configuration, TLC log, and a short write-up of any design issues TLC surfaced.

---

### Lab 5: libFuzzer + ASan on a real parser

**Goal.** Practice integrating fuzzing and a sanitiser stack on production-shaped code.

**Setup.** Take an open-source C++ parser. Suggested choices: a JSON parser like RapidJSON or simdjson, a config parser, or a small CSV library. Confirm the project does not already have OSS-Fuzz integration, if it does, pick a different target or write a new harness.

**Tasks.**

1. Write a libFuzzer harness:
   ```cpp
   extern "C" int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
       MyParser p;
       p.parse(std::string_view(reinterpret_cast<const char*>(data), size));
       return 0;
   }
   ```
2. Build with `clang++ -fsanitize=fuzzer,address,undefined -O1 -g`.
3. Seed with a small valid corpus.
4. Fuzz for at least 4 hours. Triage any crashes.
5. Generate a coverage report (`-fprofile-instr-generate -fcoverage-mapping`). Identify under-exercised code paths.
6. Add a structure-aware mutator if the input is structured (e.g., libprotobuf-mutator for protobuf, or custom mutator for the format).
7. Compare bug discovery rate before and after structure-aware mutation.

**Deliverable.** Harness, coverage report, list of bugs found (or "no bugs found, here is the coverage and corpus growth curve"), and a one-page reflection.

---

### Lab 6: Lean 4 with FFI to C++

**Goal.** Get hands-on with Lean 4 and the C/C++ FFI.

**Setup.** Install Lean 4 via `elan`. Install Lake. Install a C++17-capable compiler.

**Tasks.**

1. Write a Lean 4 module that defines and proves a small theorem. Suggested: prove `add_comm` or a property of a custom inductive type.
2. Define an `extern` function declaration in Lean 4 and provide the C implementation.
3. Build a Lake project that compiles both the Lean code and the C stub into a single executable.
4. Write a C++ program that calls into the Lean-compiled library. Use `extern "C"` declarations and link to the Lean runtime.
5. Bonus: write a small algorithm in Lean 4, prove it correct, extract or compile, call it from C++. Suggested: a verified `min` over a list, or a verified GCD.

**Deliverable.** Lean source, C stub, C++ wrapper, Lake configuration, and a passing build that demonstrates round-trip from C++ to Lean and back.

---

### Submission and review

For each lab:

1. Commit the artifacts to a fresh branch.
2. Write a one-paragraph "what I learned" note.
3. Have a peer review, ideally one with formal-methods exposure.
4. Note where each technique would or would not apply in your current production codebase.

By the end of the six labs you should have working familiarity with: property-based testing, deductive verification with Frama-C/WP, bounded model checking with CBMC, design-time specification with TLA+, coverage-guided fuzzing, and Lean 4 with FFI. That is a substantial slice of the verification toolbox, sufficient to make informed engineering decisions about which technique to deploy on a real project.
