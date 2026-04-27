export default `## Summary

This chapter covered the patterns and principles that separate Go code that merely compiles from Go code that experienced developers recognize as idiomatic.

**Composition replaces inheritance.** Struct embedding promotes methods and fields to the outer type, enabling interface satisfaction without inheritance hierarchies. Interface composition builds larger contracts from small, single-method interfaces. Together, these give you code reuse and polymorphism without tight coupling.

**Functional patterns provide flexibility.** The functional options pattern solves optional configuration cleanly and scales as APIs grow. Middleware chains compose HTTP behaviors as independent layers. Decorators like retry, timeout, and caching wrap any function without modifying it.

**Constructor patterns enforce validity.** Factory functions with validation prevent invalid objects from existing. The \`Must\` pattern handles initialization that cannot fail in production. The builder pattern manages multi-step construction with deferred error checking.

**Naming and organization signal intent.** Package names are short and lowercase. Variables are brief in tight scopes, descriptive in wide ones. Interfaces use \`-er\` suffixes for single methods. Packages organize by business domain, not by technical layer.

**Testing idioms keep tests readable.** Table-driven tests cover many cases with minimal duplication. Test helpers with \`t.Helper()\` produce clear failure messages. Interface-based mocking avoids external frameworks. \`t.Cleanup\` handles teardown reliably.

**The Go proverbs encode real tradeoffs:**
- "The bigger the interface, the weaker the abstraction", keep interfaces small
- "Make the zero value useful", design types that work without explicit initialization
- "Clear is better than clever", optimize for the reader, not the author
- "Errors are values", program with errors, don't just check them
- "A little copying is better than a little dependency", avoid unnecessary imports

### What you should be able to do now

- Apply functional options by default for any constructor with optional parameters.
- Replace Java-shaped Go with composition and small interfaces in review.
- Cite Go proverbs by name when pushing back on non-idiomatic patterns.

### For the senior-at-FAANG track

Write the team's idiomatic Go guide based on this chapter. Enforce it. Update it as the team's conventions evolve. The guide is the leverage that compounds over years.

### For the staff and principal track

Idiomatic Go at scale is not about any one pattern. It is about the consistency across hundreds of services that makes a new engineer productive on day five. The staff deliverable is the written idiom. The principal deliverable is the machinery that keeps it current: tooling, review discipline, quarterly audits, deprecation of outdated idioms, onboarding material for new engineers. This chapter is a catalog. The real output is what the team does with it over three years.

### What Gets Measured Gets Maintained

For a principal engineer thinking about impact, the metrics worth tracking are:

- **Percentage of new constructors using functional options.** Target 80%+.
- **Count of packages violating the "accept interfaces, return structs" rule.** Trend should be declining.
- **Percentage of services using the shared middleware library.** Trend should be increasing.
- **Lint-rule violations per 1000 lines.** Trend should be decreasing.
- **Time-to-first-PR-approved for new engineers.** Trend should be decreasing as conventions become learnable.

These are not vanity metrics. They are leading indicators of whether the team's Go codebase is converging on idiomatic patterns or fragmenting. The principal who tracks them sees the trend before it becomes a problem. The principal who does not track them discovers the fragmentation in a postmortem.

---
`;
