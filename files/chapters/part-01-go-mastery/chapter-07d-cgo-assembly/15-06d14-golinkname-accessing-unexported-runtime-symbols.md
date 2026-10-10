## 7D.14 go:linkname, Accessing Unexported Runtime Symbols

`go:linkname` is a compiler pragma that creates a named alias to an unexported symbol in another package, including the `runtime` package itself.

### Legitimate Uses

`//go:linkname` accesses unexported symbols in other packages by bypassing the linker's visibility rules. Its primary legitimate use is linking to runtime internals that have no public API.

```go
// file: fasttime/fasttime.go
// Access runtime.nanotime - the fast monotonic clock used internally by time.Now()
// This avoids the overhead of time.Now() when you only need nanoseconds
package fasttime

import _ "unsafe" // required for go:linkname

// NOTE: no .s file is required. //go:linkname itself suppresses the
// "missing function body" error for the body-less declaration below.

//go:linkname nanotime runtime.nanotime
func nanotime() int64

// NanoTime returns nanoseconds since process start using the runtime's fast clock.
// ~3ns vs ~15ns for time.Now().UnixNano() on x86-64.
func NanoTime() int64 {
    return nanotime()
}
```

The same technique was long used to reach the runtime's internal PRNG:

```go
// file: randfast/randfast.go
// Access runtime's internal fast random number generator
package randfast

import _ "unsafe"

//go:linkname fastrand runtime.fastrand
func fastrand() uint32

// FastRand returns a pseudo-random uint32 using the runtime's internal PRNG.
// Not cryptographically secure.
func FastRand() uint32 {
    return fastrand()
}
```

This one is now a historical example. `runtime.fastrand` survives only on the compatibility pin list the Go team created for the Go 1.23 linkname crackdown, and since Go 1.22 `math/rand/v2` provides a fast, properly supported PRNG. New code should use `math/rand/v2`.

### Testing Unexported Functions

In rare cases, `//go:linkname` in a test file provides access to internal functions that are intentionally unexported but require direct testing. This pattern appears in the Go standard library itself.

```go
// file: internal/parser/parser_test.go
// Use go:linkname to test an unexported function without exposing it
package parser_test

import (
    "testing"

    _ "unsafe"
)

// Link to the unexported function in the package under test.
// No .s file is needed: //go:linkname itself suppresses the missing-body error.
//go:linkname parseToken internal/parser.parseToken
func parseToken(input string) (string, int, error)

func TestParseToken(t *testing.T) {
    token, pos, err := parseToken("hello world")
    if err != nil || token != "hello" || pos != 5 {
        t.Errorf("unexpected: %q %d %v", token, pos, err)
    }
}
```

### Risks and When NOT to Use It

Using `//go:linkname` creates tight coupling to implementation details that may change across Go versions without notice. The following guidelines describe when to avoid it and safer alternatives.

```
┌─────────────────────────────────────────────────────────────────────────┐
│              go:linkname Risks and Guidelines                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  RISKS:                                                                 │
│  ✗ Breaks silently on Go version upgrades                               │
│    (runtime internals change between minor versions)                    │
│  ✗ No compile-time type safety                                          │
│    (wrong signature = silent memory corruption or panic)                │
│  ✗ Not supported by Go backward compatibility promise                   │
│  ✗ Restricted since Go 1.23: linkname into stdlib/runtime internals     │
│    that have not opted in can fail to link on newer toolchains          │
│                                                                         │
│  WHEN IT IS ACCEPTABLE:                                                 │
│  ✓ High-performance libraries (fasthttp, ristretto cache)               │
│    that explicitly target a narrow Go version range                     │
│  ✓ Runtime monitoring tools that need internal state                    │
│  ✓ Accessing your own internal packages in tests                        │
│    (though a better option is moving the function to a testable file)   │
│                                                                         │
│  SAFER ALTERNATIVES:                                                    │
│  • Export the function/method properly                                  │
│  • Use a testing helper file: internal_test.go in the same package      │
│  • Use the plugin package for runtime extension                         │
│  • Use runtime/debug.ReadBuildInfo for build metadata                   │
│                                                                         │
│  Go 1.23+ restriction: the linker blocks //go:linkname references to    │
│  standard-library symbols that have not explicitly opted in, so         │
│  pulling runtime internals this way can fail to link outright.          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Senior Rule

Every `go:linkname` in application code deserves a comment explaining why the public API is insufficient and a commitment to re-evaluate on every Go upgrade. Without that discipline, these directives rot and break at the worst possible time.

---
