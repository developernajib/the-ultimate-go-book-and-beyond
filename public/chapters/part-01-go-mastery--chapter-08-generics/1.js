export default `## Learning Objectives

By the end of this chapter, you will be able to:

1. **Explain why Go added generics** and compare to pre-generics alternatives (empty interface, code generation, copy-paste)
2. **Write generic functions and types** using type parameters and constraints
3. **Create and use constraints** including \`any\`, \`comparable\`, \`cmp.Ordered\`, and custom type sets
4. **Implement generic data structures** like stacks, queues, sets, maps, trees, and heaps
5. **Apply generics effectively** knowing when to use generics vs interfaces
6. **Use the standard library generics** including \`slices\`, \`maps\`, and \`cmp\` packages
7. **Implement advanced patterns** including Result types, Optional types, functional programming patterns
8. **Understand performance characteristics** of generics vs interfaces vs code generation
9. **Avoid common mistakes** and anti-patterns when writing generic code
10. **Answer interview questions** about generics with confidence

Why this matters:
- **Code reuse**: Write algorithms once, use with any compatible type
- **Type safety**: Catch errors at compile time, not runtime
- **Performance**: Generics use GCShape stenciling, near-zero runtime overhead for value types
- **Modern Go**: Understanding generics is required for modern Go development
- **Interviews**: Generics questions are increasingly common in Go interviews

### Detailed Outcomes

**Junior to FAANG-entry track**

- Use \`slices.Sort\`, \`slices.Clone\`, \`maps.Keys\`, \`cmp.Compare\` on sight.
- Write a simple generic function (\`Map\`, \`Filter\`, \`Reduce\`) when the type parameter is obvious.
- Explain the difference between \`any\` and a type parameter in interview.

**Mid-level engineer**

- Decide whether a specific function should be generic, use an interface, or stay concrete.
- Refactor an \`any\`-heavy helper into a type-safe generic version.
- Write custom constraints with type sets when the standard ones do not fit.

**Senior engineer**

- Push back in code review on generic-for-generic-sake PRs.
- Evaluate the performance impact of generics on hot paths with benchmarks.
- Migrate a codebase from pre-1.18 patterns (code generation, \`interface{}\`) to generics without over-abstracting.

**Staff or Principal engineer**

- Set the team's discipline: default to concrete types, use generics when the alternative is measurably worse, document the reasoning.
- Anticipate compile-time cost explosions from generics adoption and advise on patterns that scale.

---
`;
