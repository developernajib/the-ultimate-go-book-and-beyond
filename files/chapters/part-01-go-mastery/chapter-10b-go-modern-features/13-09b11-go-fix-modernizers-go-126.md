## 10B.11 go fix Modernizers (Go 1.26)

### Source-Level Automated Fixes

Go 1.26 expands `go fix` with automated code modernizers that rewrite your source to use newer idioms. Each fixer targets a specific pattern, replacing manual min/max conditionals with the built-in `min`/`max`, rewriting three-clause loops as range-over-int, replacing `interface{}` with `any`, and converting hand-written search and copy loops to `slices` and `maps` package calls. Run with `-diff` first to review proposed changes before applying them.

```bash
# Run all applicable fixers
go fix ./...

# Preview changes without applying
go fix -diff ./...

# Modernizers shipped with Go 1.26 include:
# minmax         : replace if a < b { return a } chains with min(a, b)
# rangeint       : replace for i := 0 - i < n - i++ with for i := range n
# efaceany       : replace interface{} with any
# slicescontains : replace manual search loops with slices.Contains
# mapsloop       : replace manual copy loops with maps.Copy / maps.Insert
# fmtappendf     : replace []byte(fmt.Sprintf(...)) with fmt.Appendf
# stringsbuilder : replace += string concatenation with strings.Builder
```

### The //go:fix inline Directive

The `//go:fix inline` directive marks deprecated functions so that `go fix` can automatically replace call sites with the recommended alternative, enabling phased API evolution.

```go
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

// After running: go fix ./...
// All calls to OldFoo(x) are replaced with NewFoo(x, DefaultOption)
// The OldFoo function can then be removed in a subsequent release
```

A typical workflow combines `//go:fix inline` with the migration commands. Mark the deprecated function, run the fixer to rewrite all call sites, verify with `go vet` and your test suite, then remove the deprecated function in the next release cycle.

```bash
# Typical migration workflow using go fix:

# 1. Add //go:fix inline to deprecated functions
# 2. Run go fix to migrate callsites
go fix ./...

# 3. Verify with go vet
go vet ./...

# 4. Run tests
go test ./...

# 5. Remove deprecated functions in next release
```

---
