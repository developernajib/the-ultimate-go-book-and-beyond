export default `## Learning Objectives

By the end of this chapter, you will be able to:

1. **Apply composition patterns** using struct embedding and interface composition
2. **Implement functional options** for flexible, self-documenting APIs
3. **Use higher-order functions** including middleware chains and decorators
4. **Follow Go naming conventions** for packages, variables, functions, and interfaces
5. **Organize packages** by feature following production best practices
6. **Write idiomatic Go** that adheres to the Go proverbs and style guide
7. **Implement common patterns** including builder, repository, and service layers
8. **Create testable designs** using dependency injection and interface-based mocking
9. **Understand design decisions** made by Google, Uber, and other Go-heavy companies
10. **Answer interview questions** about Go idioms and design patterns

### Detailed Outcomes

**Mid-level engineer**

- Apply functional options for any new constructor with more than three parameters.
- Replace ad-hoc getter/setter chains with composition and small interfaces.
- Recognise and avoid Java-shaped Go in your own PRs.

**Senior engineer**

- Push back in code review on inheritance-style embedding, config-struct sprawl, and getter/setter-driven APIs.
- Write the team's idiomatic Go guide based on the patterns here.
- Decide when to use each pattern and when to stay concrete.

**Staff or Principal**

- Set the org-wide conventions for package layout, naming, and API design.
- Anticipate the long-term cost of non-idiomatic patterns on the codebase.
- Write and maintain the team idioms guide as a living document. Treat it as a deliverable, not a side project.
- Decide when to depart from community idioms because the org has a specific constraint (regulated data, unusual scale, bespoke tooling) and document the reason so the next staff engineer does not revert the decision.
- Build the review discipline that keeps the codebase converging on the idioms over time, even as headcount grows and the senior pool turns over.
- Measure idiom adoption objectively (sample of interface-design PRs, sample of constructor signatures, sample of package-layout decisions) and report the trend quarterly. What gets measured gets maintained.
- Recognise when an idiom the community has outgrown is still in the team's guide and schedule the update. Idioms change. Go 1.26 Go is not Go 1.9 Go.

---
`;
