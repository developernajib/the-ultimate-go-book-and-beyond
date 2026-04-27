export default `## 7D.14 go:linkname, Accessing Unexported Runtime Symbols

\`go:linkname\` is a compiler pragma that creates a named alias to an unexported symbol in another package, including the \`runtime\` package itself.

### Legitimate Uses

\`//go:linkname\` accesses unexported symbols in other packages by bypassing the linker's visibility rules. Its primary legitimate use is linking to runtime internals that have no public API.

\`\`\`go
// file: fasttime/fasttime.go
// Access runtime.nanotime - the fast monotonic clock used internally by time.Now()
// This avoids the overhead of time.Now() when you only need nanoseconds
package fasttime

import _ "unsafe" // required for go:linkname

//go:linkname nanotime runtime.nanotime
func nanotime() int64

// NanoTime returns nanoseconds since process start using the runtime's fast clock.
// ~3ns vs ~15ns for time.Now().UnixNano() on x86-64.
func NanoTime() int64 {
    return nanotime()
}
\`\`\`

The same technique provides access to the runtime's internal PRNG, which is significantly faster than \`math/rand\` for non-cryptographic use cases:

\`\`\`go
// file: randfast/randfast.go
// Access runtime's internal fast random number generator
package randfast

import _ "unsafe"

//go:linkname fastrand runtime.fastrand
func fastrand() uint32

// FastRand returns a pseudo-random uint32 using the runtime's internal PRNG.
// Not cryptographically secure. ~1ns vs ~5ns for math/rand.
func FastRand() uint32 {
    return fastrand()
}
\`\`\`

### Testing Unexported Functions

In rare cases, \`//go:linkname\` in a test file provides access to internal functions that are intentionally unexported but require direct testing. This pattern appears in the Go standard library itself.

\`\`\`go
// file: internal/parser/parser_test.go
// Use go:linkname to test an unexported function without exposing it
package parser_test

import _ "unsafe"

// Link to the unexported function in the package under test
//go:linkname parseToken internal/parser.parseToken
func parseToken(input string) (string, int, error)

func TestParseToken(t *testing.T) {
    token, pos, err := parseToken("hello world")
    if err != nil || token != "hello" || pos != 5 {
        t.Errorf("unexpected: %q %d %v", token, pos, err)
    }
}
\`\`\`

### Risks and When NOT to Use It

Using \`//go:linkname\` creates tight coupling to implementation details that may change across Go versions without notice. The following guidelines describe when to avoid it and safer alternatives.

\`\`\`
┌────────────────────────────────────────────────────────────────────────┐
│              go:linkname Risks and Guidelines                          │
├────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  RISKS:                                                                │
│  ✗ Breaks silently on Go version upgrades                             │
│    (runtime internals change between minor versions)                  │
│  ✗ No compile-time type safety                                        │
│    (wrong signature = silent memory corruption or panic)              │
│  ✗ Not supported by Go backward compatibility promise                 │
│  ✗ Triggers build errors with -buildvcs=true or toolchain checks      │
│                                                                         │
│  WHEN IT IS ACCEPTABLE:                                                │
│  ✓ High-performance libraries (fasthttp, ristretto cache)             │
│    that explicitly target a narrow Go version range                   │
│  ✓ Runtime monitoring tools that need internal state                  │
│  ✓ Accessing your own internal packages in tests                      │
│    (though a better option is moving the function to a testable file) │
│                                                                         │
│  SAFER ALTERNATIVES:                                                   │
│  • Export the function/method properly                                │
│  • Use a testing helper file: internal_test.go in the same package    │
│  • Use the plugin package for runtime extension                       │
│  • Use runtime/debug.ReadBuildInfo for build metadata                 │
│                                                                         │
│  Go 1.23+ restriction: packages using go:linkname must explicitly     │
│  declare it in go.mod or the compiler emits a warning.                │
└────────────────────────────────────────────────────────────────────────┘
\`\`\`

### Senior Rule

Every \`go:linkname\` in application code deserves a comment explaining why the public API is insufficient and a commitment to re-evaluate on every Go upgrade. Without that discipline, these directives rot and break at the worst possible time.

---
`;
