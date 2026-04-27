export default `## Learning Objectives

By the end of this chapter, you will be able to:

- Understand Go's implicit interface satisfaction and why it matters
- Design small, composable interfaces following industry best practices
- Implement and use standard library interfaces effectively
- Apply production interface patterns used by FAANG companies
- Optimize interface usage for performance-critical code
- Test code using interface-based mocking patterns
- Recognize and fix common interface design mistakes
- Answer common interface-related interview questions
- Build complete applications using interface-driven architecture

### Detailed Outcomes

**Junior to FAANG-entry track**

- Explain implicit interface satisfaction without hedging, the way a phone-screen interviewer expects.
- Write a type that satisfies \`io.Reader\` or \`error\` from a blank file in under five minutes.
- Diagnose the typed-nil-interface bug on sight and name the fix.
- Define a small interface in the consuming package and explain why.
- Recognise the five most common interface patterns (accept interfaces, return structs, one-method interface, interface segregation, error wrapping, option types).

**Mid-level engineer**

- Refactor a large interface into smaller focused interfaces.
- Use \`errors.Is\` and \`errors.As\` correctly to inspect wrapped errors.
- Design a service boundary using interfaces so the consumer does not know about the implementation.
- Write a testable component with interface-based dependency injection.
- Identify the allocation cost of interface boxing and decide when to use concrete types.

**Senior at FAANG track**

- Push back in code review on Java-shaped Go (large service interfaces, I-prefixed names, one-interface-per-class).
- Design the team's interface-design guidelines and wire the review discipline into CI where possible.
- Identify when an interface has grown large enough to split, and sequence the split so callers do not break.
- Evaluate the allocation cost of an interface on a hot path with pprof and decide between concrete types, generics, or acceptable-cost interfaces.
- Maintain the team's "accept interfaces, return structs" discipline and defend it against the "but we might need polymorphism" pushback.

**Staff / Principal track**

- Treat every exported interface in a shared package as a cross-team contract. Own the versioning story (parallel interfaces, method-at-a-time migration, deprecation windows) the way an API team owns a wire protocol.
- Author the org-wide interface-evolution RFC: when adding a method is acceptable, when a new parallel interface is required, and how long a deprecation lives before removal.
- Sequence multi-quarter interface migrations across dozens of caller repos. Know which teams unblock which, and where to place adapter layers so the critical-path team is not held by a long tail of stragglers.
- Decide when generics-as-constraints should replace a runtime interface on a hot platform path, and when keeping the runtime interface is the correct tradeoff for API stability even at a measurable performance cost.
- Establish the architectural review bar: a monolithic service interface is rejected at the design-doc stage, not at the code-review stage. Build the review checklist and train the senior pool to apply it without your involvement.
- Understand when the team has outgrown interface-driven dependency injection (hand-rolled or \`uber-go/fx\`) and needs a different seam (process boundary, RPC, event bus). Interfaces are the default, not the only answer.

---
`;
