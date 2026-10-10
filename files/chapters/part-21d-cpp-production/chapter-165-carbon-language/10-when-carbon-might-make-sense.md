## When Carbon Might Make Sense

The honest version of this chapter section is that for most readers in 2026, Carbon does not make sense yet. The language is pre-1.0, the toolchain is alpha, the ecosystem is empty, and shipping production code in Carbon today is closer to research than to engineering. The interesting question is not "should I use Carbon today" (no) but "what would have to be true for Carbon to make sense for my codebase, and how would I know when that day arrives".

### The Codebase Profile Carbon Targets

Carbon is designed for codebases that look like this:

- **Tens of millions of lines or more of C++**. Smaller codebases can be rewritten in Rust faster than they can be migrated to Carbon, because the migration overhead and the wait for Carbon to mature both cost more than the rewrite.
- **Heavily templated**, where C++ templates carry a lot of the abstraction weight. These are exactly the codebases where Rust interop is most painful.
- **Long-lived**, with engineering investments measured in decades. Codebases that will be retired in five years should not start a Carbon migration.
- **Performance-sensitive**, where the C++ choice was deliberate and replacement languages need to match performance. Carbon's design preserves this.
- **Dependency-heavy**, where the cost of rewriting dependencies (or finding equivalents) in another language is prohibitive.

If you tick all of these, Carbon is at least worth tracking. If you tick none of them, Carbon is not for you.

### Concrete Examples

Codebases that match the profile, at organizations that have publicly discussed C++ pain:

- Google's internal monorepo.
- Chromium (Google's browser, ~25 million lines of C++).
- Large parts of the Android system (though Android has been adopting Rust aggressively).
- Some Microsoft platform codebases (though Microsoft has invested heavily in Rust and in their own safe-C++ proposals).
- Some bank and trading firm C++ codebases (though these are unlikely to adopt experimental languages early).

These are the codebases the design has in mind. None of them have committed to Carbon. The Carbon project is run by Google but is open-source and explicitly community-governed. Google has not committed to migrating its codebase to Carbon either. The migration is hypothetical.

### When Carbon Should Not Be Considered

Most cases. Specifically:

- **Greenfield projects**. Use Rust, Go, Swift, or whatever fits your problem. There is no benefit to picking a pre-1.0 language for new code.
- **Small to medium C++ codebases** (under a few million lines). The migration cost of Rust or even of staying on modern C++ is lower than the wait-and-see cost of Carbon.
- **Embedded firmware** in C with no C++. Carbon is not aimed at C and adopting it adds complexity for no gain.
- **Game engines** with heavy multiple inheritance and metaprogramming. Carbon's class model drops some of what these codebases use.
- **Codebases with strict regulatory or certification requirements**. A pre-1.0 experimental language will not pass safety certification (DO-178C, ISO 26262, IEC 62304) for years if ever.
- **Anything that needs to ship in 2026**. The toolchain is not ready.

### What Would Move the Needle

The signals that would shift Carbon from "track it" to "consider it":

1. **A public 1.0 announcement** with a stability commitment.
2. **At least one production codebase** at non-trivial scale reporting they have shipped Carbon in production.
3. **A working safe subset** of the language with a real-world validation story.
4. **A complete language server** with refactoring tools.
5. **Package ecosystem** with at least basic libraries available.
6. **Documented migration tooling** that automates the C++ to Carbon translation for common cases.

If two or three of these arrive, Carbon becomes a serious option for the codebases that match its target profile. None of them have arrived as of early 2026.

### The Honest Take

Most readers of this book are doing one of: writing Go services, writing modern C++, learning Rust, or some combination. For all of those readers, Carbon is something to know exists, not something to use. Reading this chapter and being able to discuss Carbon coherently in a hallway conversation is the right level of engagement.

If you are a staff engineer at an organization that does match the Carbon target profile, your job is to track the project, read the design documents, possibly contribute to discussions, and make a recommendation when the signals listed above start to land. That recommendation might be "adopt Carbon", or it might be "keep watching", or it might be "Carbon did not deliver and we should commit to Rust instead". All three outcomes are plausible.

The cost of being wrong about Carbon is not symmetric. If you bet on Carbon and it fails, you have wasted migration effort on a dead language. If you bet against Carbon and it succeeds, you have stayed on C++ longer than necessary but you can still migrate later. The asymmetry suggests waiting for stronger signals before committing, which is what most organizations are doing.

### Junior at FAANG

You should be able to articulate that Carbon is not for production use today and explain in two sentences what kinds of codebases it is targeted at.

### Senior at FAANG

You should be able to construct a decision matrix for your specific codebase, identifying which conditions would make Carbon worth adopting, what the alternatives are (stay on modern C++, migrate to Rust, mixed approach), and what the cost of each path is. A staff-level recommendation is not "use Carbon" or "do not use Carbon" but "here are the four signals we are watching, here is our default plan, here is the plan we switch to if those signals arrive".

---
