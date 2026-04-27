export default `## 7B.17 Compiler Directives Reference

Compiler directives are special \`//go:\` comments that instruct the Go compiler or linker to alter default behavior for a specific function or type. Most are intended for runtime internals and low-level library authors. Using \`//go:nosplit\` in application code, for example, can cause a stack overflow because the compiler will no longer insert the stack-growth check that allows goroutine stacks to expand dynamically. The directives listed below are recognized by \`cmd/compile\`; they must appear immediately before the declaration they annotate, with no blank line between the comment and the \`func\` or \`type\` keyword, or they are silently ignored.

\`\`\`go
package directives

// Runtime hints
//go:nosplit     - do not insert stack growth check
//go:noescape   - pointer arguments do not escape
//go:norace     - do not apply race detector instrumentation
//go:noinline   - do not inline this function
//go:inline     - hint to inline (advisory, Go 1.21+)

// Memory and layout
//go:notinheap  - type must not be in GC heap
//go:systemstack - must run on system stack
//go:nowritebarrier - must not include write barriers
//go:nowritebarrierrec - ditto, recursively

// Linking
//go:linkname localname importpath.name - link to unexported function
//go:cgo_export_static name             - export to C
//go:cgo_export_dynamic name            - dynamic export to C

// Assembly
//go:registerparams - use register-based calling convention (internal)

// Examples of safe directives for user code:
//go:noinline
func doNotInline(x int) int {
	return x * 2
}

//go:norace
func unsafeIncrement(p *int) {
	*p++ // intentionally racy, e.g., in test helper
}
\`\`\`

### Directive Discipline

Compiler directives are load-bearing in small quantities and destructive in large ones. The senior-track rules:

1. **Every directive deserves a comment.** Explain why the directive is there. The next engineer will not know.
2. **Most directives in user code are wrong.** \`//go:noinline\` for performance tuning, \`//go:linkname\` for internal package tricks, \`//go:nosplit\` for runtime-level code. If you are reaching for a directive in application code, check whether the restructure is cleaner.
3. **\`//go:generate\` is the exception.** It is the canonical way to wire code generation. Use freely.

---
`;
