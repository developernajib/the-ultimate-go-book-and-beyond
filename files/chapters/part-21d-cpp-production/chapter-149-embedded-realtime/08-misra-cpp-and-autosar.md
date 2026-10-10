## Safety-Critical Standards: MISRA C++ and AUTOSAR

Writing correct embedded C++ for a safety-critical system is not enough. You must prove it is correct, to a regulator, a customer, or a certification body. Safety standards are the framework for that proof. They do not guarantee bug-free code, but they eliminate entire categories of defects by restricting the language to a well-understood, formally analyzed subset.

### Why Safety Standards Exist

C++ inherited C's approach to undefined behavior: the standard defines what is and is not well-formed, and anything that violates the rules has undefined behavior, meaning the compiler can do anything, including silently producing code that corrupts data or skips safety-critical checks. The standard committee left these cases undefined to give compilers optimization freedom. But in safety-critical systems, undefined behavior caused by a programmer error must not silently produce dangerous output. It must produce a detectable fault.

The history of embedded software fatalities is partly a history of undefined behavior reaching production. Therac-25 race conditions. Ariane 5 type conversion overflow. Toyota unintended acceleration linked (controversially) to stack overflow and bit-flip in SRAM without ECC. Safety standards exist to break this pattern.

### MISRA C++ 2008

MISRA (Motor Industry Software Reliability Association) published MISRA C++ 2008 as a coding standard for automotive and safety-critical C++. It defines 228 rules in three categories:

- **Required:** Must be followed. Violations require deviation justification filed with quality management.
- **Advisory:** Should be followed. Violations may be acceptable with documented rationale.
- **Document:** Must be documented if used or intentionally not followed.

Key required rules with direct embedded impact:

```
Rule 0-1-1:   A project shall not contain unreachable code.
              [Dead code may indicate logic error or incomplete state machines]

Rule 5-0-5:   There shall be no implicit floating-integral conversions.
              [Silent precision loss; embedded FP values must be explicitly cast]

Rule 6-2-1:   Assignment operators shall not be used in sub-expressions.
              [Prevents while(*p++ = *q++) pattern, common in C but reads poorly]

Rule 6-6-1:   Any label referenced by a goto statement shall be declared in the
              same block, or in a block enclosing the goto statement.
              [In practice: no goto across scopes; most guidance treats as "no goto"]

Rule 10-8-1:  An object with integer type or enumeration type shall not be
              converted to a different type.
              [Forces explicit casts; eliminates implicit narrowing]

Rule 15-0-1:  Exceptions shall only be used for error handling.
              [In embedded MISRA: exceptions are generally prohibited (Rule 15-0-3)]

Rule 18-4-1:  Dynamic heap memory allocation shall not be used.
              [The foundational rule for deterministic memory]
```

**What MISRA compliance does not mean:** A codebase with zero MISRA violations still contains bugs. MISRA reduces the class of bugs caused by undefined behavior and implicit language features. It does not verify algorithm correctness, timing properties, or system-level behavior.

### MISRA C++ 2023

MISRA C++ 2023 (released October 2023) modernizes the standard for C++17 and partially C++20:

- Relaxes some overly conservative 2008 rules that blocked beneficial modern C++
- Adds rules covering `auto`, lambdas, structured bindings, `constexpr` functions
- Incorporates CERT C++ and C++ Core Guidelines recommendations
- Replaces the required/advisory classification with a compliance model based on rule categories (Mandatory, Required, Advisory, Disapplied)

Notable changes: `constexpr` is actively encouraged (forces compile-time evaluation, eliminates runtime risk). Range-based `for` is permitted. `std::array` is permitted. `std::string` and heap containers remain prohibited.

### AUTOSAR C++14 Guidelines

AUTOSAR (Automotive Open System Architecture) published C++14 coding guidelines in 2017, updated to 2020, targeting the automotive domain at ASIL A-D levels. AUTOSAR extends MISRA C++ with 300+ rules and explicitly targets modern C++ features:

```
Rule A5-1-1:   Literal values shall not be used apart from type initialization,
               otherwise symbolic names shall be used instead.
               [Magic numbers are prohibited; all constants must be named constexpr]

Rule A7-1-1:   Constexpr specifier shall be used for values that can be determined
               at compile time.
               [Maximum use of constexpr; shifts computation to build time]

Rule A12-6-1:  All class data members that are initialized by the constructor shall
               be initialized using member initializers.
               [Prevents uninitialized-member defects from construction order issues]

Rule A15-5-3:  The std::terminate() function shall not be called implicitly.
               [noexcept functions that throw terminate; banned in safety code]

Rule A18-5-1:  Functions malloc, calloc, realloc and free shall not be used.
               [Heap prohibition at AUTOSAR level, stronger than MISRA]
```

AUTOSAR-compliant code must also satisfy MISRA C++ 2008 (by reference), so the two standards are additive.

### ISO 26262: Automotive Functional Safety

ISO 26262 is the process standard for functional safety of electrical/electronic systems in road vehicles. It defines ASIL (Automotive Safety Integrity Level) ratings A-D, where D is the highest.

```
ASIL A: Minor injury risk         -- turn signals, courtesy lighting
ASIL B: Moderate injury risk      -- parking assist, HVAC control
ASIL C: Serious injury risk       -- electric power steering, engine control
ASIL D: Life-threatening risk     -- airbags, ABS, ESC, steer-by-wire
```

Each ASIL level has software requirements for:

**Code coverage:** ASIL D requires Modified Condition/Decision Coverage (MC/DC), every condition in every boolean expression must independently affect the decision outcome. MC/DC proves that every branch is exercised and cannot be silently bypassed.

**Redundancy:** ASIL D systems use hardware and software redundancy. Dual MCUs running independent software implementations, cross-checking outputs. Single-point failure tolerance.

**Static analysis:** ASIL D requires static analysis tools (Polyspace, Klocwork, LDRA) in the development process, with documented rationale for every finding.

**Traceability:** Every software requirement must trace to a test case. Every test case must trace to a requirement. No requirement may exist without a test. No code may exist without a traced requirement.

```cpp
// ISO 26262 ASIL-D compliant function annotation example
// (Tool-specific -- Polyspace uses pragma - CodePeer uses comments)

// @req SWR-0042: Compute braking torque from wheel slip ratio
// @asil D
// @tested TST-BRK-042-001, TST-BRK-042-002, TST-BRK-042-003
int32_t compute_brake_torque(int32_t slip_ratio_q16,
                              int32_t vehicle_speed_mmps,
                              int32_t max_torque_nm)
{
    // Input validation -- ASIL D: every input checked
    if (slip_ratio_q16 < 0 || slip_ratio_q16 > (1 << 16)) {
        return 0;  // Invalid -- apply zero torque (safe default)
    }
    if (vehicle_speed_mmps < 0) {
        return 0;
    }
    // ... computation ...
    return 0;
}
```

### DO-178C: Aviation Software

DO-178C (2011) is the airworthiness standard for civil aviation software. Development Assurance Levels (DAL) A-E correspond to catastrophic, hazardous, major, minor, and no safety effect. DAL A (flight control, auto-landing) requires:

- 100% statement and decision coverage minimum. MC/DC coverage required
- Formal review of every requirement, design, and code artifact
- Independence: reviewers cannot review their own code
- Tool qualification: any tool that generates code or checks requirements must itself be qualified (RTCA DO-330)

The constraints make DAL A software extremely expensive to develop: \$50 - \$200 per line of code is a common industry estimate for fully qualified avionics software. This is why aviation software moves slowly, not technical limitation, but certification cost.

### Static Analysis Tools for Safety

Static analysis tools examine source code without executing it, flagging common bugs, style violations, and security vulnerabilities early in the development cycle. Integrating a linter into the CI pipeline ensures that issues are caught before code review rather than in production.
```
Polyspace Bug Finder / Code Prover (MathWorks):
  - Bug Finder: detects runtime errors (overflow, div-by-zero, dead code)
  - Code Prover: formally verifies absence of runtime errors using abstract interpretation
  - Used for: ISO 26262, DO-178C, IEC 61508 certification

Klocwork (Perforce):
  - Flow-sensitive analysis, interprocedural
  - MISRA checker integrated
  - Used in automotive and aerospace

LDRA (TBvision):
  - Structural coverage analysis (MC/DC), MISRA enforcement
  - Traceability from requirements to tests to coverage results
  - Widely used in avionics (DO-178C)

Parasoft C/C++test:
  - MISRA C++ 2008/2023, AUTOSAR enforcement
  - Integrated unit testing framework
  - Used in automotive (ISO 26262) and medical (IEC 62304)
```

### Go Comparison

Go has no MISRA equivalent, no AUTOSAR analog, no ISO 26262 toolchain support. The Go runtime (garbage collector, goroutine scheduler, reflection) violates the core requirements of hard real-time safety standards:

- Dynamic memory allocation is pervasive and non-deterministic
- GC pause times are bounded in average case but not formally bounded for worst case
- Reflection and interface dispatch cannot be statically proven free of type errors
- No tool-qualified static analysis toolchain exists for certified aviation or automotive use

TinyGo for bare-metal gets closer, no GC, no scheduler in the simplest configuration, but the toolchain is not qualified, the memory model is not formally specified, and no certification body has accepted TinyGo code for ASIL C/D or DAL A applications. For safety-critical systems, C++ (with Ada as the alternative) remains the only viable compiled language with existing certification toolchains.

---
