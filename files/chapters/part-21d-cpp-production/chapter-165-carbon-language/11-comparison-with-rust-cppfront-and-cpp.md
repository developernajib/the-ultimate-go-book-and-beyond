## Comparison with Rust, Cpp2/CppFront, Hylo, Mojo, and C++

Carbon is one entry in a crowded field of "what comes after C++" projects. None of these projects are direct competitors in the strict sense. They occupy adjacent slots in the design space, with different bets about which trade-offs matter most. Understanding the field as a whole gives you a better sense of where Carbon fits.

### Rust

**What it is**: A systems language with a borrow checker that statically prevents data races and memory safety bugs. Mature, stable, widely adopted (Linux kernel, Android system services, much of the Rust crates ecosystem on crates.io).

**Strengths**: Memory safety. Strong type system. Fearless concurrency. Excellent tooling (cargo, rustc, rust-analyzer). Mature ecosystem. Production-ready since 2015.

**Weaknesses**: C++ interop is painful. Templates do not survive the boundary. Inheritance does not survive the boundary. Compile times are slow. The borrow checker has a learning curve and sometimes rejects code that would actually be safe.

**Where Rust beats Carbon**: Greenfield projects. Code that needs day-one safety. Anywhere C++ interop is rare. Most network services, most CLI tools, most embedded targets.

**Where Carbon beats Rust**: Large existing C++ codebases that need file-by-file migration with zero interop friction.

### Cpp2 / CppFront (Herb Sutter)

**What it is**: An alternative cleaner syntax for C++, designed by Herb Sutter, that compiles to C++1 (today's C++). Cpp2 is not a new language with new semantics, it is a syntactic skin over C++ that produces C++ source as its output, which is then compiled by an ordinary C++ compiler.

**Strengths**: 100% interop with C++ because it is C++ underneath. No new compiler needed. Cleaner syntax. Demonstrably simpler. Backed by one of the most respected C++ committee members.

**Weaknesses**: Inherits all of C++'s semantic problems. No memory safety story beyond what C++ already offers. Limited adoption, mostly experimental. Not officially endorsed by the C++ committee or any major company.

**Where Cpp2 beats Carbon**: Teams that want better C++ syntax today, without committing to a new language. Cpp2 is available now, runs through any C++ compiler, and is reversible.

**Where Carbon beats Cpp2**: Teams that want a real new language with a chance of evolutionary safety, not just a syntax skin.

The two projects are not direct competitors because they have different ambitions. Cpp2 is a refactor of C++. Carbon is a successor.

### Hylo (formerly Val)

**What it is**: A research language built around mutable value semantics. Every value is owned by exactly one variable, mutable aliases are statically prevented through scope rules rather than lifetime annotations. Led by Dimi Racordon and others, with backing from various academic and industrial collaborators.

**Strengths**: Mathematically clean safety model. Provably safe without lifetime annotations. Generic programming with definition-site checking. Strong academic foundation.

**Weaknesses**: Very early. Smaller team than Carbon or Rust. No production users. Not aimed at C++ interop. The mutable value semantics model, while clean, is a big mental shift even for engineers who already know Rust.

**Where Hylo fits**: Research and projects that value design coherence over migration paths.

**Where Carbon beats Hylo**: Real C++ codebase migration. Hylo is not in that game.

Hylo is worth reading even if you never use it, because the mutable value semantics model is one of the most interesting design experiments in the systems language space.

### Mojo

**What it is**: A systems language by Modular Inc., aimed primarily at machine learning workloads. Supersets Python syntactically (or claims to), compiles ahead of time, integrates with MLIR for ML-targeted code generation.

**Strengths**: Targeted use case (ML kernel programming, accelerator code) that has clear customers. Familiar Python syntax. Strong MLIR integration. Real performance numbers on ML workloads.

**Weaknesses**: ML-focused. Not a general systems language despite the marketing. Proprietary in some forms. Less open than the other projects on this list.

**Where Mojo fits**: ML infrastructure, accelerator programming, replacing the Python plus C++ split that dominates ML libraries.

**Where Carbon and Mojo do not overlap**: Carbon is about migrating C++ application and system code. Mojo is about ML kernels. They are not competing for the same engineers or codebases.

### Modern C++ (the comparison nobody mentions)

**What it is**: The C++ you are using today. C++23 with `std::expected`, `std::ranges`, `std::span`, modules where the toolchain supports them. C++26 in some experimental forms.

**Strengths**: Existing codebase compatibility. No migration. Decades of optimizer investment. Massive ecosystem. Standards-committee process, slow but real.

**Weaknesses**: Backward compatibility constraints. Slow standards process. Memory safety only through tooling and discipline. The accumulation of legacy syntax and semantics.

**Where modern C++ beats Carbon**: Today, for everyone. Modern C++ is a real language you can ship in production. Carbon is not.

**Where Carbon could eventually beat modern C++**: If the safety story delivers and the toolchain matures, Carbon offers a cleaner foundation than C++ can ever achieve through evolution alone.

The case for staying on modern C++ is strong and underrated. Most teams should not migrate away from C++ at all in the next several years. They should adopt the parts of modern C++ that improve their daily life (smart pointers, ranges, expected, sanitizers) and leave the rest alone.

### Where Carbon Fits

Carbon's slot in this space is narrow and specific:

- Not for new code (Rust wins).
- Not for ML kernels (Mojo wins).
- Not for syntax cleanup with full C++ semantics (Cpp2 wins).
- Not for design-clean research (Hylo wins).
- Not for "I want to upgrade my C++ skills today" (modern C++ wins).
- For: large existing C++ codebases that need a successor language with free interop, accepting day-one unsafety in exchange for migration feasibility.

That slot is real. It contains some of the most economically important codebases on the planet. Whether Carbon will be the language that occupies the slot, or whether something else will, is the open question.

### Junior at FAANG

You should be able to name each of these languages, identify the slot it targets, and avoid making the common mistake of treating any two of them as direct competitors when they are not.

### Senior at FAANG

You should be able to advise leadership on which language fits a specific codebase, drawing the trade-offs explicitly. You should also be able to recognize when the answer is "stay on modern C++" rather than picking any of the alternatives, because that answer is correct more often than the language-bake-off framing suggests.

---
