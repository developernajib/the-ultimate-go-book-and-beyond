## Migration Strategies from C++ to Carbon

If, at some point in the future, Carbon delivers on its promises and your codebase is one of the few that fits the target profile, the migration is a multi-year project. The strategies that will work and the strategies that will not are predictable from the design.

This section is hypothetical. No one has done a large Carbon migration yet. The strategies described here are extrapolations from the design intent and from analogous migrations in other ecosystems (Java to Kotlin, Objective-C to Swift, JavaScript to TypeScript).

### File-by-File Migration

The intended migration model is file-by-file. You pick a single C++ source file, rewrite it in Carbon, and the rest of the codebase keeps building. The Carbon file imports the same C++ headers the original C++ file imported. The C++ files that depended on the migrated file continue to call into it through Carbon's interop layer.

The rules of thumb for picking which file to migrate first:

- **Leaf files**: files with few or no dependents are safer to migrate first because mistakes have a smaller blast radius.
- **Files with simple types**: files dominated by ordinary classes and functions are easier than files dominated by templates and metaprogramming.
- **Files with active maintainers**: the engineer who knows the file should be the one who migrates it. Migration without code knowledge is dangerous.
- **Files with good test coverage**: tests are how you know the migration did not break behavior. Files without tests should get tests before they get migrated.

Files to defer or skip:

- **Heavy template metaprogramming**: until Carbon's interop on these patterns is mature, leave them in C++.
- **Macro-heavy code**: Carbon has no preprocessor and macros do not migrate cleanly. Either rewrite to remove macros first, or leave the file in C++ until tooling exists.
- **Code with strict ABI requirements**: anything with documented ABI guarantees needs careful interop testing before migration.
- **Critical safety code**: a financial calculation engine or a security primitive should be one of the last things you migrate, not one of the first.

### Module-by-Module Migration

For larger units, you can migrate a self-contained module (a directory of related files) as a unit, which lets you redesign the module's API along Carbon idioms rather than mechanically translating each function.

This is more disruptive but can produce cleaner Carbon code. The trade is that the module's API surface to the rest of the codebase changes, which means callers need updating in the same change.

A reasonable hybrid is to migrate file-by-file within a module, then in a final pass redesign the module's public API to be Carbon-idiomatic.

### Automated Translation

The carbon-lang project's stated direction includes interest in automated C++ to Carbon translation tooling. The model is similar to Google's `clang-tidy` based refactoring tools or Apple's Objective-C to Swift translator: take well-typed C++ code, produce equivalent Carbon code, leave the engineer to clean up the result.

The honest expectation is that automated translation will handle the easy 70 percent of code mechanically and require human review for the remaining 30 percent. The exact ratio depends on how much of the codebase is the easy 70 percent (boring CRUD-style classes and functions) versus the hard 30 percent (templates, metaprogramming, macros, complex inheritance).

As of early 2026, this tooling is not built. It is a stated direction, not a delivered capability. Plan migrations assuming you will do them by hand.

### Testing the Migration

The single most important practice in any large migration is testing. The pattern that works:

1. **Test the C++ code first**. If there is no test, write one. Migration without tests is malpractice.
2. **Run the tests against the C++ implementation** to confirm they pass and the test asserts the behavior you care about.
3. **Migrate the file to Carbon**.
4. **Run the same tests against the Carbon implementation**. They must still pass.
5. **Add Carbon-specific tests** for any behavior that the original C++ tests did not cover.

Carbon's interop with C++ test frameworks is part of what the toolchain needs to deliver. As of early 2026, this story is not fully baked. In the future, expect to be able to write Carbon code that is tested by GoogleTest or Catch2 the same way C++ code is.

### What Should Not Be Migrated

A migration plan should explicitly identify code that stays in C++ permanently or for the foreseeable future:

- **Vendor libraries** you do not own the source of.
- **Heavily optimized hand-written assembly or intrinsics-laden code** where translation risks regressing performance.
- **Code with regulatory certification** that has been certified in its current C++ form.
- **Code at retirement**: if a subsystem is being decommissioned, do not migrate it.
- **Code where the original team is gone**: migrating code with no maintainer is high-risk.

Migration is not a goal. It is a tool for achieving other goals (safer code, faster builds, easier hiring, modern toolchain). Code that does not benefit from those goals does not need to migrate.

### The Reverse Migration Risk

A migration that gets stuck halfway through (a codebase that is 30 percent Carbon and 70 percent C++ permanently) is worse than either endpoint. You pay the cognitive cost of two languages, the build complexity of two toolchains, the hiring complexity of two skill sets, and you do not get the benefits of either pure state.

A serious migration plan includes a kill switch. If at some checkpoint the migration is failing (toolchain not delivering, productivity not improving, safety not arriving), you back out and stay on C++ rather than continuing to spend on a stuck migration.

### Junior at FAANG

You should be able to describe file-by-file migration at a high level and identify the obvious gotchas (templates, macros, ABI). You will not run a migration yourself.

### Senior at FAANG

You should be able to plan a migration with explicit phases, success criteria, and a kill switch. The most important thing a staff engineer does in a migration is set the conditions under which the migration is abandoned, because most migrations fail and the failure mode of "drag on forever" is the worst one.

---
