## Further Reading

1. **Go Blog**: "An Introduction to Generics", https://go.dev/blog/intro-generics
2. **Go Blog**: "When to Use Generics", https://go.dev/blog/when-generics, the single most important guide on restraint
3. **Go Proposal**: Type Parameters Proposal, https://go.googlesource.com/proposal/+/refs/heads/master/design/43651-type-parameters.md
4. **Go 1.26 Release Notes**: Self-referential type parameters
5. **Go 1.27 Release Notes** (https://go.dev/doc/go1.27): Generic methods and generalized function type inference
6. **Standard Library**: `slices`, `maps`, `cmp` package documentation at https://pkg.go.dev
7. **golang.org/x/exp**: The experimental `slices` and `maps` packages (`golang.org/x/exp/slices`, `.../maps`), the pre-1.21 precursors to today's standard-library versions

### Senior-Track Reading List

8. **Sandi Metz's "The Wrong Abstraction".** Not Go-specific, but the canonical argument that duplication is cheaper than the wrong abstraction. It applies directly to the "when not to use generics" discipline.
9. **Go 1.21 release notes on `slices` and `maps`.** These are the first standard library uses of generics at scale. Read as reference examples.
10. **Your team's code review log.** The recurring generics findings on your team's PRs are the institutional memory of what works and what does not. Build the team's "when to use generics" guide from them.
