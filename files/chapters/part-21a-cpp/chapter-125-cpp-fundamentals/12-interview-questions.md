## Interview Questions

### Conceptual Questions

**Q1: What is the difference between `const` and `constexpr` in C++?**

`const` means the variable's value cannot change after initialization, but the initial value can be computed at runtime. `constexpr` means the value must be computable at compile time. A `constexpr` variable is also implicitly `const`, but a `const` variable is not necessarily `constexpr`.

```cpp
const int a = getValueFromUser();  // OK: runtime constant
constexpr int b = getValueFromUser();  // ERROR: not compile-time
constexpr int c = 42;  // OK: known at compile time
```

**Q2: Why does C++ have both references and pointers?**

References provide a safer aliasing mechanism: they cannot be null, cannot be reseated, and do not require explicit dereferencing. Pointers are needed when you need nullable values, reseatability, pointer arithmetic, or dynamic memory management. References are syntactic sugar over pointers at the machine level, but they encode stronger invariants in the type system.

**Q3: Name five categories of undefined behavior and explain how Go prevents each.**

1. Signed integer overflow: Go wraps (defined behavior)
2. Null pointer dereference: Go panics with a clear error
3. Out-of-bounds access: Go panics with bounds information
4. Use after free: Go's garbage collector prevents this
5. Uninitialized variables: Go zero-initializes all variables

**Q4: Explain the C++ compilation pipeline. Why does C++ need header files but Go does not?**

C++ compiles each source file independently (translation unit). The compiler needs to know function signatures to generate correct call instructions, but it does not see other `.cpp` files. Header files provide these declarations. The linker then connects the compiled object files. Go's compiler reads compiled package metadata directly, so it can see exported symbols from other packages without textual inclusion.

**Q5: When would you use each of the four C++ cast operators?**

- `static_cast`: numeric conversions, known-safe upcasts, enum-to-int. The default choice.
- `dynamic_cast`: downcasting in class hierarchies when you need a runtime safety check.
- `reinterpret_cast`: bit-level reinterpretation (serialization, hardware interfaces). Extremely rare.
- `const_cast`: interfacing with legacy APIs that lack const-correctness. Should be avoided in new code.

### Coding Questions

**Q6: What does this code print? Explain your reasoning.**

```cpp
#include <iostream>

void foo(int x)    { std::cout << "int: "    << x << "\n"; }
void foo(double x) { std::cout << "double: " << x << "\n"; }
void foo(int x, int y = 10) { std::cout << "two: " << x << " " << y << "\n"; }

int main() {
    foo(5);       // line 1
    foo(3.14);    // line 2
    foo(5, 20);   // line 3
    return 0;
}
```

**Answer:** This code does not compile. Line 1 is ambiguous: `foo(5)` could match `foo(int)` or `foo(int, int)` with the default argument. This is a common interview trap about the interaction between overloading and default arguments.

**Q7: Is this code valid? If not, why?**

```cpp
int& getRef() {
    int x = 42;
    return x;  // returning reference to local variable
}
```

**Answer:** This compiles (possibly with a warning) but invokes undefined behavior. The local variable `x` is destroyed when the function returns, leaving the returned reference dangling. Any use of the returned reference is UB. The Go equivalent would be returning `&x` from a function, which is safe in Go because the compiler moves `x` to the heap (escape analysis).

**Q8: Fix this code to eliminate all undefined behavior:**

```cpp
int main() {
    unsigned int a = 0;
    a--;  // Is this UB?

    int b = -1;
    unsigned int c = b;  // Is this UB?

    int arr[3] = {1, 2, 3};
    for (int i = 3; i >= 0; i--) {
        std::cout << arr[i] << "\n";
    }
    return 0;
}
```

**Answer:**
- `a--`: NOT UB. Unsigned underflow is well-defined (wraps to `UINT_MAX`).
- `unsigned int c = b`: NOT UB. Converting a negative value to unsigned is implementation-defined in C, but well-defined in C++ (modular arithmetic).
- The loop: UB! When `i == 3`, `arr[3]` is out of bounds. Fix: start at `i = 2`.

```cpp
for (int i = 2; i >= 0; i--) {
    std::cout << arr[i] << "\n";
}
```

**Q9 (FAANG-level): Explain why this optimization is valid and what it implies about writing C++:**

```cpp
bool isPositive(int x) {
    return x > 0;
}

bool check(int x) {
    if (isPositive(x + 1))
        return true;
    return isPositive(x);  // Can the compiler eliminate this?
}
```

**Answer:** Yes, the compiler can optimize `check` to always return `true`. Since signed overflow is UB, the compiler assumes `x + 1` does not overflow. If `x + 1` does not overflow, then either `x + 1 > 0` (first branch returns true) or `x + 1 <= 0`, meaning `x <= -1`, but wait: if `x + 1` is valid and `x + 1 <= 0`, then `x <= -1`. However, the second call `isPositive(x)` would need `x > 0`, which contradicts `x <= -1`. But the edge case is when `x == INT_MAX`: `x + 1` overflows, which is UB, so the compiler can assume it never happens. With that assumption, if `x + 1 > 0` is false, then `x < 0`, so `isPositive(x)` is false, and the function returns false. Actually the compiler cannot always return true here. The real subtlety is that optimizers analyze reachable paths under the assumption that UB paths are unreachable, which can lead to surprising eliminations of safety checks. This is why compiler sanitizers and careful coding are essential.

**Q10: Compare how you would design a "Shape" abstraction in Go (interfaces) vs C++ (classes with virtual methods). What are the tradeoffs?**

**Answer:** Go uses structural typing (implicit interface satisfaction). Any type with an `Area() float64` method satisfies the `Shape` interface without declaring it. C++ uses nominal typing (explicit inheritance from a base class). Go's approach is more flexible and allows retroactive interface satisfaction. C++ provides `dynamic_cast` for runtime type inspection, virtual destructors for proper cleanup, and access control (private/protected). C++ pays for virtual dispatch with vtable overhead. Go pays with interface boxing overhead. C++ gives more compile-time guarantees through the explicit inheritance tree. Go gives more decoupling through implicit interfaces.

---

### Junior → FAANG: Using These Questions as a Self-Assessment Rubric

Before a C++ interview, work through these questions in writing, then compare your answers to the provided answers. The gap between your answer and the provided answer shows you what to study. Pay special attention to questions where your answer is technically correct but less precise (for example, saying "UB is bad" vs. citing the specific compiler optimization that makes it exploitable).

For questions that involve Go comparisons, practice giving both sides of the comparison before stating the trade-off. Interviewers reward candidates who can articulate the strength of both choices before explaining the selection.

### Senior @ FAANG: Bar-Raiser Use of These Questions at L5/L6 Calibration

At the bar-raiser level, these questions are not used to test recall. They are used to probe depth and judgment. The follow-up to any question here is "how does this affect a production system?" or "how would you enforce this at scale?"

For example, the UB question follow-up is: "how would you ensure your team's codebase has no new UB introduced per quarter?" The expected L6 answer involves: UBSan in CI with `fno-sanitize-recover`, clang-tidy checks for the most common UB patterns, a code review policy requiring justification for any raw pointer arithmetic, and a quarterly sanitizer coverage report. An L4 answer names the sanitizer. An L6 answer names the policy.

Use the delta between L4 and L6 answers in each question to calibrate your own depth, and to calibrate candidates you are interviewing. The L6 answer always includes the governance mechanism, not just the technical knowledge.

