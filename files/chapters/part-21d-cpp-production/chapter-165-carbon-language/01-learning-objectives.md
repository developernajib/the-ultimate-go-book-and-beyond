## Learning Objectives

By the end of this chapter you should be able to:

### Conceptual

1. Explain in two minutes what Carbon is, who built it, and what specific problem it tries to solve that Rust does not solve well.
2. Describe Carbon's positioning relative to Rust, Cpp2/CppFront, Hylo, and Mojo, and identify which slot each language occupies in the post-C++ ecosystem.
3. Articulate the central design bet of Carbon: cheap bidirectional C++ interop first, evolve toward safety later.
4. Describe Carbon's official status as of early 2026 and explain why the project explicitly tells users not to deploy it in production.

### Language Design

5. Identify the design goals Carbon has stated publicly: C++ interop as a first-class feature, performance parity with C++, modern toolchain, generics rather than templates, separation of safe and unsafe code.
6. Identify the non-goals: backward source compatibility with C++, drop-in replacement, stability before 1.0.
7. Compare Carbon's constraint-based generics with C++ templates, C++20 concepts, Rust traits, and Swift protocols, and explain what "checked at definition site" means and why it matters for compiler errors.
8. Describe Carbon's planned class and inheritance model, including how it differs from C++ multiple inheritance and from Rust's trait-based composition.
9. Describe Carbon's stated direction on error handling and explain why exceptions were rejected as the default.
10. Describe Carbon's evolutionary memory and ownership story and contrast it with Rust's borrow checker and Hylo's mutable value semantics.

### Practical

11. Read a short Carbon code sample, identify the Carbon-specific syntax (`fn`, `var`, `let`, packages, imports), and translate it mentally to the equivalent C++.
12. Walk through a hypothetical file-by-file migration plan from a C++ codebase to Carbon, identifying which files should migrate first and which should not migrate at all.
13. Set up the Carbon toolchain on a development machine using the project's currently documented Bazel-based build process, or use the Carbon Explorer browser playground to run a small generic function.
14. File a useful issue or design discussion comment against the carbon-lang repository, demonstrating that you have read the relevant design document and engaged with its actual content.

### Strategic

15. Make an honest call on whether Carbon is relevant to a specific team and codebase you work on, based on codebase size, migration constraints, and risk tolerance. For most readers the answer is no, and you should be able to explain why without dismissiveness.
16. Evaluate Google's track record on language and platform launches (Go succeeded, Dart found a niche through Flutter, others did not survive) and apply that lens to Carbon's risk profile.
17. Track Carbon's progress over the next several years using the right signals: design document merges, toolchain milestones, and public adoption announcements rather than star count or social media buzz.

### Junior at FAANG

You should reach objectives 1 through 4 and 11. That is enough to participate in a hallway conversation about Carbon without saying something embarrassing.

### Senior at FAANG

You should reach all 17. If a director asks you in a planning meeting whether your team should be tracking Carbon, you should be able to give a one-paragraph answer that references the interop model, the current status, and your team's specific constraints.

---
