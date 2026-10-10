## ISO 26262 Functional Safety

ISO 26262 is the international standard for functional safety of road vehicles. It defines a process that, if followed and audited, gives reasonable confidence that the electrical and electronic systems in a vehicle will not cause unreasonable risk due to failures. Every shipping ECU in a modern car has an ISO 26262 work product trail behind it, often hundreds of pages of artifacts per ECU.

For a C++ engineer, ISO 26262 shows up in three places: the language subset you are allowed to write, the software development process you must follow, and the testing rigor you must apply.

### The Standard Structure

ISO 26262 has 12 parts. The relevant ones for software:

- **Part 3** Concept phase: hazard analysis and risk assessment, ASIL determination
- **Part 4** System level: requirements, safety mechanisms, integration
- **Part 5** Hardware level: the silicon
- **Part 6** Software level: this is the part that governs your C++
- **Part 8** Supporting processes: configuration management, verification, documentation
- **Part 9** ASIL-oriented and safety-oriented analyses: dependent failures, decomposition

Part 6 is what you read as a C++ engineer. It defines requirements for software architecture, design, unit implementation, and unit testing, with the requirements scaling up by ASIL. ASIL D requires the most rigorous process, ASIL A the least.

### ASIL Levels

The four levels from the chapter on AUTOSAR, restated with examples:

- **QM (Quality Managed, no ASIL)**: infotainment, cup holder lighting, seat memory
- **ASIL A**: instrument cluster lighting brightness, audio volume control
- **ASIL B**: rear lights on/off, headlight high-beam control, fuel gauge
- **ASIL C**: cruise control, electric power steering with redundant mechanical fallback
- **ASIL D**: brake-by-wire, steer-by-wire, airbag deployment, high-voltage battery management

ASIL is determined by the combination of severity (S0-S3), exposure (E0-E4), and controllability (C0-C3) of the hazard. A failure that causes an instant crash with high severity, high exposure, and low controllability gets ASIL D. A failure that causes an inconvenience the driver can manage gets QM.

### ASIL Decomposition

A clever and commonly used technique. An ASIL D requirement can be decomposed into two ASIL B requirements that are independent, where each must fail for the safety goal to be violated. This is how brake-by-wire systems are built: a primary ASIL B controller plus a redundant ASIL B controller, totaling ASIL D, instead of a single ASIL D controller.

The independence requirement is strong. It must apply to design, implementation, hardware, and operating conditions. Two C++ functions in the same binary are not independent. Two cores in lockstep are not independent (a silicon flaw affects both). Two ECUs from different vendors with different power supplies and different software stacks are independent.

### C++ Coding Standards Relevant to ISO 26262

The ISO 26262 process requires the use of a "language subset" appropriate for the ASIL. Part 6 names several acceptable subsets. For C++, the relevant standards are:

- **MISRA C++ 2008**: the original automotive C++ subset, very restrictive (no exceptions, no RTTI, no dynamic memory, no `goto`, no multiple inheritance)
- **AUTOSAR C++14 (2017)**: superset of MISRA C++ 2008 modernized for C++14, used heavily in Adaptive
- **MISRA C++ 2023**: the unification of the above, the modern reference subset for new programs
- **CERT C++**: focused on security rather than safety, complementary to MISRA
- **JSF AV C++ (Joint Strike Fighter)**: aerospace subset, similar in spirit to MISRA

A program targeting ASIL D in 2026 is most likely using MISRA C++ 2023 with deviation forms for any rules the team cannot meet.

### Software Development Process

Part 6 mandates a V-model development process:

```
Requirements -----------------------> Acceptance Tests
   |                                          ^
   v                                          |
Architecture ----------------------> Integration Tests
   |                                          ^
   v                                          |
Design --------------------------------> Unit Tests
   |                                          ^
   v                                          |
Implementation -----------------------------> /
```

Each level has a verification activity at the same level. Requirements are reviewed against acceptance criteria. Architecture is reviewed against requirements. Unit tests verify implementation against design. Integration tests verify the architecture. Acceptance tests verify the requirements.

Every artifact has traceability. A requirement traces to its design element traces to the unit code traces to the unit test. A defect found in integration traces back to a requirement. The traceability matrix is one of the most-audited deliverables. Tools like IBM DOORS, Polarion, and Jama Connect maintain these traces because spreadsheets do not scale to a real ECU project.

### Software Architecture Requirements (Table 3)

For ASIL D, the standard "highly recommends" the following architectural principles:

- Hierarchical structure with clearly defined modules
- Restricted size of modules (small enough to test thoroughly)
- Restricted size of interfaces (the public API of a module)
- Strong cohesion within modules
- Loose coupling between modules
- Restricted use of interrupts (predictable interrupt latency)
- Appropriate scheduling properties (priority-preemptive, predictable)

A C++ class hierarchy with clean public interfaces, single-responsibility modules, and limited use of templates (because templates expand and complicate code coverage analysis) maps cleanly to these requirements.

### Software Unit Implementation Requirements (Table 6)

For ASIL D, the standard requires:

- One entry and one exit point per function (single return)
- No unconditional jumps (no `goto`)
- No use of dynamic memory after initialization
- Initialization of variables before use
- No multiple use of variable names (variable shadowing)
- Avoidance of global variables, or justification when used
- Restricted pointer use
- No implicit type conversions
- No hidden data flow or control flow
- No unconditional or unbounded loops

These look familiar because MISRA C++ codifies most of them. They are not arbitrary, they exist because each item is a category of historical bugs.

### Software Unit Testing (Table 7)

ASIL D requires:

- Requirements-based testing
- Interface testing
- Fault injection testing
- Resource usage evaluation
- Back-to-back comparison test (when an alternative implementation exists)
- Statement coverage: 100 percent
- Branch coverage: 100 percent
- MC/DC (Modified Condition/Decision Coverage): 100 percent

100 percent MC/DC coverage is the requirement that drives most of the testing effort. For a function with N boolean conditions in a decision, you need N+1 test cases that demonstrate each condition independently affects the outcome. Tools like Cantata, VectorCAST, LDRA TBrun, and BullseyeCoverage instrument the binary, run the test suite, and produce coverage reports auditors accept.

Achieving 100 percent MC/DC on a non-trivial C++ template-heavy codebase is genuinely hard. It is one reason templates are restricted in safety-critical code: every instantiation generates code that must be covered.

### Tool Qualification

ISO 26262 also requires qualification of any tool whose output is part of the safety case. A compiler that miscompiles a function can defeat all the unit tests. The standard defines Tool Confidence Levels (TCL1, TCL2, TCL3) and corresponding qualification activities. Companies like Validas and BTC Embedded Systems publish qualified versions of GCC, Clang, ARM Compiler, IAR, and Tasking with formal qualification reports.

A qualified GCC build is not a different compiler. It is the same source with a documented test matrix, a formal report on errors found and remaining, and a known-good binary. Using `gcc-12.3` from Ubuntu apt for an ASIL D project is not acceptable. Using `gcc-12.3` provided by Validas with its qualification report is.

### Practical Workflow

A typical day for a C++ engineer on an ASIL D ECU:

1. Pull the latest from the source repository
2. Run static analysis (Polyspace or LDRA) on changed files, fix violations
3. Implement the assigned design item, traced to a requirement in DOORS
4. Write unit tests first, run them with VectorCAST or Cantata
5. Run coverage report, ensure MC/DC is at 100 percent for new code
6. Submit a code review that includes the traceability links
7. CI runs the full test suite plus static analysis on a qualified compiler
8. Once merged, the integration test team runs hardware-in-the-loop scenarios

The cycle is slower than non-safety C++ work. A senior engineer at a Tier 1 might commit two or three meaningful changes per week. The reward is that when the ECU ships, the company has documented evidence that the software meets the safety case, and that evidence is what protects the company in a liability claim.

---
