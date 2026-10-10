## 7C.6 go:linkname, Accessing Unexported Symbols

`go:linkname` is a compiler directive that creates a symbol alias, letting your code call an unexported function in another package as if it were local. The Go standard library uses it internally, for example, the `time` package links to `runtime.nanotime` this way.

This technique is fragile. The linked function's signature, behavior, or existence can change between Go releases with no deprecation warning, because unexported symbols carry no compatibility guarantee. Use it only when no public API exists for the functionality you need, and pin your Go version in CI to catch breakage early.

The directive requires an `import _ "unsafe"` to signal to the compiler that the file performs low-level operations. The syntax is `//go:linkname localName importpath.remoteName`, where `localName` is the function declaration in your file and `remoteName` is the unexported target.

```go
// This is an ADVANCED and FRAGILE technique.
// Only use it for accessing runtime internals when absolutely necessary.
// It breaks with Go version changes.

// file: mypkg/runtime_ext.go
package mypkg

import _ "unsafe" // required for go:linkname

// The //go:linkname directive itself suppresses the "missing function body"
// error. No .s file is required (an empty .s file is only a legacy alternative).

//go:linkname nanotime runtime.nanotime
func nanotime() int64

// Usage:
func HighPrecisionNow() int64 {
    return nanotime() // calls runtime.nanotime directly
}

// More legitimate use: testing unexported functions
// //go:linkname testableFunc mypackage.unexportedFunc
// func testableFunc(x int) int
```

Starting in Go 1.23, the Go team has been tightening restrictions on `go:linkname`. The linker now rejects pull-only linknames of standard library internals unless the defining package explicitly pushes the symbol with its own `//go:linkname`, or the symbol sits on a legacy compatibility list of widely used names (the `-checklinkname=0` linker flag disables the check). If you rely on this directive in production code, expect it to stop working as the toolchain evolves. Prefer using public APIs, build tags, or code generation instead.

### Senior-Track Guidance

For a senior engineer, `go:linkname` should almost never appear in application code. Legitimate uses:

1. **Standard library implementations.** `time`, `sync`, `runtime` use it internally.
2. **Deep integration libraries.** High-performance serializers such as `bytedance/sonic` and `goccy/go-json` cross the boundary to reach runtime internals.
3. **Test-only access to unexported functions.** Acceptable when no cleaner alternative exists.

Anything else is a red flag in code review. Removing it is almost always the right call.

---
