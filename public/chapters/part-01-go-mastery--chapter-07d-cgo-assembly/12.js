export default `## 7D.11 Testing and Debugging CGO

### Testing CGO Code

Testing CGO code requires the C build infrastructure to be available, which affects CI configuration. The following examples show how to structure CGO tests and use the C sanitizers to detect memory errors.

\`\`\`bash
# Test with CGO enabled (default)
go test ./...

# Test the pure-Go fallback path (CGO disabled)
CGO_ENABLED=0 go test ./...
# This tests that your package has proper build constraints and fallbacks

# Run with the CGO pointer checker (detects Go pointers stored in C)
GOEXPERIMENT=cgocheck2 go test -race ./...
# cgocheck2 is more thorough than the default checker (cgocheck=1)

# Run with address sanitizer (finds memory errors in C code)
go test -asan ./...
# Requires: CGO_ENABLED=1, gcc/clang with -fsanitize=address

# Run with C sanitizers via cflags
# #cgo CFLAGS: -fsanitize=address -fno-omit-frame-pointer
# #cgo LDFLAGS: -fsanitize=address
\`\`\`

A solid CGO testing strategy provides both a CGO implementation and a pure-Go fallback. Define a shared interface, then use build constraints to select the right implementation. This way, \`go test\` exercises the CGO path on developer machines while \`CGO_ENABLED=0 go test\` validates the fallback in constrained environments:

\`\`\`go
// Testing strategy: provide both CGO and pure-Go implementations
// file: hasher.go
package hasher

import "crypto/sha256"

// Hash is the interface both implementations satisfy
type Hasher interface {
    Sum256(data []byte) [32]byte
}

// file: hasher_cgo.go - only compiled when CGO is enabled
//go:build cgo

package hasher

// CGOHasher uses OpenSSL for hardware-accelerated SHA256
type CGOHasher struct{}

func (CGOHasher) Sum256(data []byte) [32]byte {
    // ... CGO implementation using EVP_DigestOneShot
    return [32]byte{}
}

// DefaultHasher returns the best available implementation
func DefaultHasher() Hasher {
    return CGOHasher{}
}

// file: hasher_pure.go - compiled when CGO is disabled
//go:build !cgo

package hasher

type PureGoHasher struct{}

func (PureGoHasher) Sum256(data []byte) [32]byte {
    return sha256.Sum256(data)
}

func DefaultHasher() Hasher {
    return PureGoHasher{}
}
\`\`\`

### Debugging CGO with Delve and GDB

Debugging across the CGO boundary requires a debugger that understands both Go and C call frames. Delve supports basic CGO debugging. GDB provides deeper inspection of C code called from Go.

\`\`\`bash
# Delve works with CGO (uses DWARF debug info from both Go and C)
dlv debug ./myprogram

# Inside delve: set breakpoints in both Go and C code
(dlv) break main.MyGoFunc
(dlv) break mylib.c:42        # C file and line
(dlv) print C.my_c_variable   # inspect C variables

# GDB for C-heavy debugging
# Build with debug info preserved:
go build -gcflags="all=-N -l" -ldflags="-extldflags=-g" -o myapp .
gdb ./myapp

# GDB commands
(gdb) set auto-load safe-path /usr/local/go/src/runtime/runtime-gdb.py
(gdb) source /usr/local/go/src/runtime/runtime-gdb.py
(gdb) info goroutines    # list all goroutines (Go GDB extension)
(gdb) goroutine 5 bt     # backtrace of goroutine 5

# Valgrind for C memory errors (Linux only)
CGO_ENABLED=1 go build -o myapp .
valgrind --leak-check=full --error-exitcode=1 ./myapp

# Print CGO debugging info during build
go build -v -x ./... 2>&1 | grep -E '(cgo|gcc|ld)'
\`\`\`

### Valgrind in CI

For services using CGO with hand-written wrappers around a C library, wire Valgrind into CI. The leak detection catches mismatched malloc/free, use-after-free, and uninitialised-memory reads that Go's race detector cannot see. The cost is slow CI runs. The payoff is catching bugs that would otherwise surface as production crashes weeks later.

---
`;
