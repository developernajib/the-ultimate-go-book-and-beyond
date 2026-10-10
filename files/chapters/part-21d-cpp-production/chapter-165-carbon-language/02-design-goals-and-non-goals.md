## Design Goals and Non-Goals

Most language projects fail because they try to be everything. Carbon's design document is interesting precisely because it states, in the same breath, what the language wants to be and what the language refuses to be. Reading the goals without reading the non-goals gives you a misleading picture.

### Stated Design Goals

#### 1. C++ Interop as a First-Class Feature

Carbon is not designed to interoperate with C++ through a foreign function interface. It is designed so that calling a C++ function from Carbon is the same kind of operation as calling another Carbon function: same calling conventions where possible, full visibility into C++ templates, full visibility into C++ classes, full visibility into C++ inheritance hierarchies. This is the central goal and almost every other goal is constrained by it.

This is the bet that distinguishes Carbon from every other "successor language" attempt. Rust treats C++ interop as an unfortunate necessity that you bolt on with `cxx`. Carbon treats C++ interop as the reason the language exists.

#### 2. Performance Parity with C++

Carbon must compile to code that performs as well as equivalent C++. No tax for using the new language. The same machine code generation pipeline (LLVM), the same optimization opportunities, the same ability to control layout and allocation. If Carbon were 5 percent slower than C++ on the same workload, no one at Google would migrate, because the codebases that need migrating are exactly the ones that exist for performance reasons.

#### 3. Modern Toolchain

C++'s toolchain is its weakest link. Header files, the preprocessor, the include order pitfalls, build systems that struggle with templates, the absence of a standard package manager. Carbon's compiler is built around a proper module system, predictable builds (Bazel as the reference build system), and a unified package and dependency story. This is not glamorous work but it is most of the daily pain of C++.

#### 4. Generics Rather than Templates

Carbon's generics are constraint-based and checked at the definition site, not at instantiation. This is the same direction Rust traits and Swift protocols took. The practical difference is that when you write a generic function in Carbon and ship it as a library, the compiler verifies that your function only uses operations the constraints permit, before any caller instantiates it. The error message you get is in your code, not deep inside an instantiation chain in a user's translation unit.

#### 5. Separation of Safe and Unsafe Code

Carbon's plan is to have a clearly delineated unsafe subset, similar to Rust's `unsafe` blocks, with the safe subset being the default. The team has been explicit that day-one Carbon will not be memory safe in the way Rust is, but the design preserves the option to evolve toward stronger guarantees over time. This is one of the biggest critiques of Carbon and also one of the most honest things about it.

#### 6. Readable, Modern Syntax

C++ syntax has accreted. Carbon resets it. Declarations read left to right. Types come after names. Function syntax is consistent. Generics use a different bracket so they do not collide with comparison operators. None of these are individually important. Together they reduce the daily cognitive load of reading code.

### Stated Non-Goals

The non-goals are the more interesting half of the document because they tell you what Carbon is willing to give up to achieve its goals.

#### 1. Backward Source Compatibility with C++

Carbon code is not C++ code. You cannot compile a `.cpp` file as Carbon. You cannot copy a C++ snippet into a `.carbon` file and expect it to work. This is a deliberate break that lets Carbon clean up syntax, semantics, and defaults without inheriting every historical mistake. Interop is at the package level, not the source level.

#### 2. Drop-in Replacement

Carbon is not trying to be the language you reach for instead of writing C++. Greenfield code should usually pick Rust, or whichever language fits. Carbon is for codebases where the option to start over does not exist.

#### 3. Stability Before 1.0

The project explicitly reserves the right to make breaking changes during the alpha and beta phases. This is the right call for a language still finding its feet, but it means anyone deploying Carbon today is signing up for churn.

#### 4. Memory Safety as a Day-One Guarantee

This is the non-goal that gets the most pushback. Carbon will not ship at 1.0 with Rust-style borrow checking. The argument is that you cannot get safety and free C++ interop simultaneously, and Carbon's job is to give you the migration path first, then evolve. People who consider memory safety the table stakes of any new systems language find this unacceptable. People who have tried to interop a 30-million-line C++ codebase with Rust find it pragmatic.

#### 5. Replacing C

Carbon is targeted at C++ codebases. It is not trying to be a better C, the way Zig is. If you write embedded firmware in C with no C++ in sight, Carbon is not for you.

### Why the Non-Goals Matter

The Carbon team's discipline about non-goals is what gives the project a chance. Languages that promise to be a better C++ and a better Rust and a better Swift end up shipping nothing. By saying "we will not be safe at 1.0, we will not run your existing C++ source, and we are not for greenfield code", Carbon dramatically narrows its design space. That narrowing is what makes the C++ interop goal achievable.

### Junior at FAANG

You should be able to recite the five goals and the five non-goals in any order. Knowing the non-goals is what separates someone who has actually read the design from someone who has only read a Hacker News thread.

### Senior at FAANG

You should be able to argue both sides of the safety non-goal. The pro case is that interop with C++ is the entire point and safety can be added incrementally. The con case is that history shows "we will add safety later" almost never happens at scale. A staff engineer should be able to articulate which side they come down on for their specific codebase and why.

---
