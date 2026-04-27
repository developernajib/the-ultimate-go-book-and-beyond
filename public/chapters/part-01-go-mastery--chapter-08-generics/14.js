export default `## Summary

Generics provide:

- **Type safety**: Compile-time type checking without runtime assertions
- **Code reuse**: Write once, use with many types
- **Performance**: Near-zero runtime overhead via GCShape stenciling (value types get specialized code. Pointer types share one implementation with dictionary dispatch)
- **Expressiveness**: Type-safe containers and algorithms

Key concepts:

- **Type parameters**: \`[T any]\`, \`[K comparable, V any]\`
- **Constraints**: \`any\`, \`comparable\`, \`cmp.Ordered\`, custom interfaces
- **Type sets**: \`~int | ~float64\`
- **Approximation**: \`~T\` for underlying types

Best practices:

1. Use generics for containers and algorithms
2. Prefer interfaces when behavior matters more than type
3. Use meaningful type parameter names
4. Don't over-generalize, start specific, generalize when needed
5. Test with multiple type instantiations

Standard library packages:
- \`slices\`: Sort, Search, Contains, Unique, etc.
- \`maps\`: Clone, Copy, Equal, etc.
- \`cmp\`: Ordered constraint, Compare, Less, Or

### What you should be able to do now

- Use \`slices\`, \`maps\`, \`cmp\` fluently.
- Write a simple generic function when the alternative is \`any\` or duplication.
- Decide whether a specific use case should be generic, use an interface, or stay concrete.
- Push back in code review on gratuitous generics.

### For the senior-at-FAANG track

The discipline is the artifact. The team that reaches for generics by default accumulates complexity. The team that reaches for generics only when justified stays maintainable. Write the team's "when to use generics" guide and enforce it in review.

---
`;
