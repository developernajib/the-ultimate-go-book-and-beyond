export default `## Learning Objectives

By the end of this chapter, you will:
- Understand the full Go compilation pipeline from source scanning through lexing, parsing, type-checking, IR generation, SSA construction, optimization, and code generation to a linked binary
- Be able to use \`go build\` flags such as \`-gcflags\`, \`-ldflags\`, \`-trimpath\`, and \`-race\` to control and inspect the compilation process
- Know how to read and interpret Go assembly output using \`go tool compile -S\` and \`go tool objdump\` to reason about generated machine code
- Understand linker behavior including symbol resolution, dead code elimination, and how \`go tool link\` produces final ELF/Mach-O/PE binaries
- Work with the build cache mechanics, including how Go determines what to recompile, cache keys, and how to diagnose stale cache issues
- Know how to use \`go generate\` effectively for code generation, including writing and wiring custom generators into the build pipeline
- Understand build constraints (build tags) for conditional compilation across OS, architecture, and custom tags
- Be able to perform cross-compilation for any supported GOOS/GOARCH target, including CGo considerations and toolchain requirements

### Detailed Outcomes

**Mid-level engineer**

- Read \`-gcflags="-m"\` output fluently and explain each escape decision.
- Write a small \`go/analysis\` pass that catches a team-specific anti-pattern.
- Debug a slow build using the build cache and remote build caching.
- Use \`go generate\` to generate code for the team without breaking CI.

**Senior engineer building team tooling**

- Own the team's custom linter suite wired into CI.
- Evaluate the build-time vs correctness trade-off for each lint rule.
- Diagnose a build-cache miss using \`GOFLAGS\` and \`go build -x\`.
- Author the team's code-generation discipline document.

**Staff or Principal engineer**

- Set the org-wide tooling strategy: which linters are mandatory, which are opt-in, which are banned.
- Evaluate whether a new bug class deserves a custom lint rule vs review-time attention.
- Own the build infrastructure: remote build cache, CI parallelism, binary size tracking.
`;
