export default `## Overview

Every senior Go engineer should understand what happens between \`go build\` and a running binary. This chapter dissects the Go compiler pipeline from source text to machine code, explores the toolchain's internal architecture, and shows you how to apply that knowledge for optimization, metaprogramming, and custom tooling.

After this chapter you will be able to:
- Trace the full compilation pipeline: scanning → parsing → type-checking → IR → SSA → codegen
- Read and manipulate ASTs using \`go/ast\`, \`go/parser\`, and \`go/types\`
- Write static analysis tools with \`golang.org/x/tools/go/analysis\`
- Use SSA form and understand optimization passes
- Master \`go generate\`, build tags, and conditional compilation
- Understand Profile-Guided Optimization (PGO) internals
- Build custom linters, code generators, and refactoring tools
- Work with the linker, build cache, and module system internals

### The Senior Engineer's Tooling Toolkit

The outcome from this chapter is not "I know how the compiler works". It is "I can build the tool my team needs". The representative tools a senior Go engineer builds:

1. A custom linter that catches the team's recurring anti-patterns.
2. A code generator that produces boilerplate from a team-specific schema.
3. A build-time architectural check that enforces package boundary rules.
4. A diagnostic tool that emits escape-analysis summaries for hot packages.
5. A migration tool that rewrites old patterns to new ones across the codebase.

Each is a one-afternoon project once you know the \`go/ast\` and \`go/analysis\` APIs. The leverage compounds as the codebase grows.

---
`;
