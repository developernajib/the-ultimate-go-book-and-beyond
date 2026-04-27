export default `## Summary

Interfaces are central to Go programming:

- **Implicit satisfaction**: No \`implements\` keyword, just have the methods
- **Small interfaces**: One or two methods is ideal
- **Composition**: Build larger interfaces from smaller ones
- **Standard interfaces**: io.Reader, io.Writer, error, fmt.Stringer
- **Design principles**: Accept interfaces, return structs. Define at point of use
- **Patterns**: Functional options, decorator, strategy, adapter
- **Testing**: Interfaces enable powerful mocking patterns
- **Performance**: Understand interface overhead for hot paths

Key points:
1. Keep interfaces small and focused
2. Define interfaces at the point of consumption
3. Use composition to build larger interfaces
4. Prefer explicit nil returns to avoid the nil interface gotcha
5. Use interface guards to ensure compile-time compliance
6. Use interfaces to make code testable

### What you should be able to do now

- Explain implicit interface satisfaction without hedging.
- Write a type that satisfies an interface on sight.
- Diagnose the typed-nil interface bug and name the fix.
- Decide where an interface should live (consumer, not producer).
- Push back in code review on Java-shaped Go.

### For the FAANG-entry track

Practice translating real Java or Python code into idiomatic Go. Notice where the source code had explicit class hierarchies and interfaces, and where the Go version should use composition and small interfaces instead. The mental-model shift is the single biggest interview signal for candidates crossing from OO languages.

### For the senior-at-FAANG track

The institutional artifact from this chapter is the team's interface-design guide. Write it. Update it quarterly. Use it as the reference for every code review discussion about "should this be an interface?". The guide is the leverage. The individual code reviews are the application.

### For the staff and principal track

Interfaces are how teams decouple. The staff-level contribution is not better interfaces in your own code. It is the shared vocabulary, the deprecation machinery, and the review discipline that keep the org's total interface population coherent. Three deliverables worth your calendar time: an interface-directory page listing every public interface in shared packages, a deprecation registry with named owners and hard dates, and a one-page design-review rubric the senior pool applies consistently. These are unglamorous. They are also what separates a Go org that scales from one that accretes indefinitely. Build them once. Maintain them quarterly. Measure the result in the number of cross-team migrations that shipped on time without escalation.

### Mental Model to Take Away

Interfaces are not types. They are contracts between packages that let the packages evolve independently. The method set is the syntactic part of the contract. The doc comment is the semantic part. Both must be right. A change to either is a change to the contract, which means a change that every implementer and every caller has to absorb. Treat interfaces with the care you would give a wire protocol. The teams that do this ship Go that compounds in value. The teams that do not ship Go that requires a rewrite every three years. Which kind of team you are is decided one interface PR at a time.

---
`;
