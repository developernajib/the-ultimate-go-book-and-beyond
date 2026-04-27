export default `## 10B.11 go fix Modernizers (Go 1.26)

### Source-Level Automated Fixes

Go 1.26 expands \`go fix\` with automated code modernizers that rewrite your source to use newer idioms. Each fixer targets a specific pattern, replacing manual min/max conditionals with the built-in \`min\`/\`max\`, converting raw \`append\` chains to \`slices\` package calls, and updating HTTP handler registrations to Go 1.22's pattern routing. Run with \`-diff\` first to review proposed changes before applying them.

\`\`\`bash
# Run all applicable fixers
go fix ./...

# Specific fixer: update deprecated API usage
go fix -fix=httpserver ./...

# Preview changes without applying
go fix -diff ./...

# Available fixers in Go 1.26:
go fix -list
# loopvar          - range loop variable capture fix (Go 1.22)
# appends          - merge append(s, append(t, ...)...) patterns
# httpserver       - update to Go 1.22 http.ServeMux pattern routing
# errorf           - update fmt.Errorf with %w
# slices           - replace manual slice operations with slices package
# maps             - replace manual map operations with maps package
# minmax           - replace if a < b { return a } with min(a, b)
# // +more in 1.26...
\`\`\`

### The //go:fix inline Directive

The \`//go:fix inline\` directive marks deprecated functions so that \`go fix\` can automatically replace call sites with the recommended alternative, enabling phased API evolution.

\`\`\`go
// Go 1.26: //go:fix inline directive
// Marks a function as a candidate for source-level inlining by go fix

package oldapi

// Deprecated: Use NewFoo instead.
//go:fix inline
func OldFoo(x int) int {
    return NewFoo(x, DefaultOption)
}

func NewFoo(x int, opt Option) int {
    return x * int(opt)
}

// After running: go fix -fix=inline ./...
// All calls to OldFoo(x) are replaced with NewFoo(x, DefaultOption)
// The OldFoo function can then be removed in a subsequent release
\`\`\`

A typical workflow combines \`//go:fix inline\` with the migration commands. Mark the deprecated function, run the fixer to rewrite all call sites, verify with \`go vet\` and your test suite, then remove the deprecated function in the next release cycle.

\`\`\`bash
# Typical migration workflow using go fix:

# 1. Add //go:fix inline to deprecated functions
# 2. Run go fix to migrate callsites
go fix -fix=inline ./...

# 3. Verify with go vet
go vet ./...

# 4. Run tests
go test ./...

# 5. Remove deprecated functions in next release
\`\`\`

---
`;
