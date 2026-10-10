## Summary

C++ is not dying. It is evolving. The language that powered the first web browsers, the first game engines, and the first high-frequency trading systems continues to power their modern successors. Every major database, browser, compiler, game engine, and ML runtime is built on C++.

As a Go engineer, you do not need to become a C++ expert. But you need to understand where C++ lives in the systems you depend on, why it is used there, and when your team should consider it. The key takeaways:

1. **C++ dominates where GC pauses are unacceptable** and deterministic resource management is required.
2. **Every FAANG company maintains major C++ projects** and hires C++ engineers at scale.
3. **Modern C++ (C++17/20/23) is dramatically better** than the C++ you learned in school. Smart pointers, concepts, ranges, and modules make it safer and more productive.
4. **Go and C++ are complements, not competitors.** Use Go for networked services, CLI tools, and distributed systems. Use C++ for storage engines, runtimes, and latency-critical hot paths.
5. **Rust is the modern alternative to C++** for new systems projects, but C++ has 40 years of libraries, tooling, and institutional knowledge that Rust cannot yet match.

The next chapters will take you deeper into C++ syntax, memory management, and the specific patterns used at FAANG companies. This chapter gave you the map. The following chapters provide the territory.

### Junior → FAANG: Locking In the Strategic Frame Before Diving Into Syntax

The most important takeaway from this chapter is not a C++ feature. It is the ability to answer "why C++?" for any given system with a specific, constraint-based answer. Before moving to the next chapter, write down three systems you interact with (a database, a browser feature, an ML API) and the C++ component behind each. Then write one sentence per system explaining which constraint (GC-pause sensitivity, hardware access, ABI compatibility, existing codebase) makes C++ the right choice.

This exercise prevents the "C++ is just faster" reflex and builds the articulation habit that FAANG interviews reward.

### Senior @ FAANG: Chapter 124 as an Onboarding Document and Hiring Rubric

At the staff level, this chapter's material is useful in two unexpected ways: as an onboarding document for Go engineers joining a team that owns C++ infrastructure, and as a rubric for evaluating candidates.

**As an onboarding document.** When a Go engineer joins a team that owns a C++ storage engine or ML runtime, the first week should include a reading assignment that covers exactly this material: where C++ dominates, what the major FAANG C++ projects are, and how the toolchain differs from Go. Orienting engineers to the "why" before the "how" reduces the time to first productive contribution.

**As a hiring rubric.** A staff-level C++ hire should be able to answer every question in this chapter's interview section with structured, trade-off-aware answers. A candidate who can only describe C++ features but cannot explain when Go or Rust would be a better choice is missing the judgment that distinguishes L5 from L6. Use this chapter's framework as a screening rubric: does the candidate demonstrate domain awareness (knowing which FAANG projects use C++ and why), language portfolio thinking (knowing when not to use C++), and toolchain maturity (knowing what sanitizers, hermetic builds, and reproducible builds are)?

---

| [◀ Part XX: Capstone Projects](../../part-20-capstone-projects/00-part-intro.md) | [Chapter 124: Why C++ Still Matters](00-introduction.md) | [Chapter 125: C++ Fundamentals](../chapter-125-cpp-fundamentals/00-introduction.md) ▶ |

