export default `## 7D.1 CGO Fundamentals

### Hello CGO

CGO enables Go programs to call C functions by placing C declarations in a comment block immediately before \`import "C"\`. The \`import "C"\` pseudo-package provides access to all C types and declared functions.

\`\`\`go
// file: main.go
package main

/*
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// C functions can be defined right in the comment block
void hello(const char* name) {
    printf("Hello from C, %s!\\n", name);
}

int add(int a, int b) {
    return a + b;
}
*/
import "C" // this import MUST immediately follow the comment

import "fmt"

func main() {
    // Call C function
    result := C.add(3, 4)
    fmt.Println("C.add(3, 4) =", int(result)) // 7

    // Pass a Go string to C - must convert to C string
    name := "Gopher"
    cName := C.CString(name) // allocates C memory - MUST be freed!
    defer C.free(unsafe.Pointer(cName)) // free the C allocation
    C.hello(cName)
    // Output: Hello from C, Gopher!
}
\`\`\`

Note that the above example also requires \`import "unsafe"\` alongside \`import "C"\`. CGO is enabled by default (\`CGO_ENABLED=1\`); set \`CGO_ENABLED=0\` to force a pure-Go build with no C dependencies.

### Type Conversions Between Go and C

CGO requires explicit type conversion between Go and C because the two languages have different memory layouts and ownership rules. CGO provides conversion functions for strings, slices, and pointer types.

\`\`\`go
package main

/*
#include <stdint.h>
#include <stdbool.h>

typedef struct {
    int32_t x;
    int32_t y;
    double  distance;
} Point;

Point make_point(int32_t x, int32_t y) {
    Point p;
    p.x = x;
    p.y = y;
    p.distance = x * x + y * y;  // simplified
    return p;
}
*/
import "C"

import (
    "fmt"
    "unsafe"
)

func main() {
    // Numeric type conversions
    var goInt int = 42
    var cInt C.int = C.int(goInt)    // Go int → C int
    var backInt int = int(cInt)       // C int → Go int
    _ = backInt

    // C type sizes (platform-dependent in C, fixed in CGO)
    fmt.Println("C.int size:", C.sizeof_int)         // 4
    fmt.Println("C.long size:", C.sizeof_long)        // 8 on 64-bit Linux
    fmt.Println("C.char size:", C.sizeof_char)        // 1

    // C struct usage
    p := C.make_point(3, 4)
    fmt.Printf("Point: x=%d y=%d dist=%f\\n",
        int(p.x), int(p.y), float64(p.distance))

    // CGO type mapping table:
    // C.char        ↔ byte
    // C.int         ↔ int32 (usually)
    // C.long        ↔ int32 or int64 (platform-dependent!)
    // C.longlong    ↔ int64
    // C.float       ↔ float32
    // C.double      ↔ float64
    // C.void*       ↔ unsafe.Pointer
    // C.size_t      ↔ uintptr
    // *C.char       ↔ *byte (C string)
    // *C.int        ↔ *int32

    _ = unsafe.Pointer(nil)
    _ = cInt
}
\`\`\`

### String Memory Management, The Critical Part

Memory management across the Go/C boundary is the most common source of CGO bugs: leaks, double-frees, and use-after-free.

\`\`\`go
package main

/*
#include <stdlib.h>
#include <string.h>

char* reverse_string(const char* s) {
    if (!s) return NULL;
    int len = strlen(s);
    char* result = (char*)malloc(len + 1);
    if (!result) return NULL;
    for (int i = 0; i < len; i++) {
        result[i] = s[len - 1 - i];
    }
    result[len] = '\\0';
    return result;  // caller must free() this!
}
*/
import "C"

import (
    "fmt"
    "unsafe"
)

// ReverseString calls C to reverse a string
func ReverseString(s string) string {
    // C.CString:
    // - Allocates memory in C's heap (malloc)
    // - Copies the Go string's bytes + null terminator
    // - Caller MUST call C.free() on the result
    cStr := C.CString(s)
    defer C.free(unsafe.Pointer(cStr)) // ALWAYS defer free immediately after CString

    // Call C function - it returns a newly malloc'd C string
    cResult := C.reverse_string(cStr)
    if cResult == nil {
        return ""
    }
    defer C.free(unsafe.Pointer(cResult)) // free the returned C string too!

    // C.GoString:
    // - Creates a Go string by COPYING the bytes from the C string
    // - The returned Go string is in Go's heap - safe after C.free
    return C.GoString(cResult)
}

// GoStringFromBytes: Go string from C pointer + length (no null terminator needed)
func GoStringFromBytes(ptr *C.char, length C.int) string {
    // C.GoStringN creates a Go string from pointer + explicit length
    // Useful for binary data that may contain null bytes
    return C.GoStringN(ptr, length)
}

// PassGoSliceToC: passing a Go byte slice to a C function expecting char*
func PassGoSliceToC(data []byte) {
    if len(data) == 0 {
        return
    }
    // &data[0] gives a *byte - cast to *C.char
    // The memory is owned by Go - C must not free it, must not store the pointer!
    cPtr := (*C.char)(unsafe.Pointer(&data[0]))
    _ = cPtr
    // C.process_bytes(cPtr, C.int(len(data))) // example call
}

func main() {
    result := ReverseString("Hello, World!")
    fmt.Println(result) // !dlroW ,olleH
}
\`\`\`

### Memory Ownership Rules

The fundamental CGO memory rule is that Go memory must not be retained by C code after the CGO call returns. The garbage collector may move or collect memory that C code holds a pointer to, causing undefined behavior.

\`\`\`
┌─────────────────────────────────────────────────────────────────────┐
│              CGO Memory Ownership Rules                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Go memory allocated by Go runtime:                                 │
│  ✓ Go can use it freely                                             │
│  ✓ GC manages its lifetime                                         │
│  ✗ C must NOT free it                                              │
│  ✗ C must NOT hold a pointer to it past the CGO call               │
│     (GC may move Go memory - called "pinning" violation)           │
│                                                                      │
│  C memory allocated by malloc:                                      │
│  ✓ C can use it freely                                             │
│  ✓ Go can read/write it via unsafe.Pointer                         │
│  ✗ Go's GC does NOT manage it                                      │
│  ✗ You MUST call C.free() exactly once                             │
│                                                                      │
│  The Pinning Rule (Go 1.21+: runtime/cgo.Handle):                 │
│  - Go pointers passed to C must not be stored past the CGO call    │
│  - Use cgo.Handle to pass a stable reference to Go data into C     │
│  - The CGO checker (GOEXPERIMENT=cgocheck2) enforces this          │
│                                                                      │
│  Memory conversion cheat sheet:                                     │
│  Go string → C *char:  C.CString(s) + defer C.free(ptr)           │
│  C *char  → Go string: C.GoString(p) (copies into Go heap)        │
│  Go []byte → C *char:  (*C.char)(unsafe.Pointer(&b[0]))           │
│  C *char + len → Go []byte: C.GoBytes(ptr, n) (copies)            │
└─────────────────────────────────────────────────────────────────────┘
\`\`\`

### Calling Go from C: //export

The \`//export\` directive makes Go functions callable from C code. This is essential when implementing C callbacks in Go or exposing a Go library as a shared object.

\`\`\`go
// file: callbacks.go
package main

/*
#include <stdio.h>

// Forward declaration - implemented by Go via //export
extern void onEvent(int event_type, const char* data);

// C function that calls back into Go
void process_events(int count) {
    for (int i = 0; i < count; i++) {
        onEvent(i, "event_data");
    }
}
*/
import "C"

import "fmt"

// //export makes this function visible to C with the given name
// RESTRICTIONS when using //export:
// 1. Cannot use C types from the import "C" comment in the exported function signature
// 2. File cannot have any non-//export functions that reference C
// 3. The package must be compiled as a C shared library: go build -buildmode=c-shared
//export onEvent
func onEvent(eventType C.int, data *C.char) {
    // Called from C - must be goroutine-safe!
    goData := C.GoString(data)
    fmt.Printf("Go received event %d: %s\\n", int(eventType), goData)
}

func main() {
    // Call C, which calls back into Go
    C.process_events(3)
    // Go received event 0: event_data
    // Go received event 1: event_data
    // Go received event 2: event_data
}
\`\`\`

### Passing Go Values Safely to C Callbacks with cgo.Handle

\`cgo.Handle\` provides a safe mechanism to pass Go values through the CGO boundary as an integer handle. The Go value is retrieved by dereferencing the handle in a subsequent CGO call.

\`\`\`go
package main

/*
#include <stdlib.h>

extern void goCallback(uintptr_t handle, int value);

void call_with_value(uintptr_t handle, int value) {
    goCallback(handle, value);
}
*/
import "C"

import (
    "fmt"
    "runtime/cgo"
)

// EventHandler is a Go interface we want to pass to C
type EventHandler interface {
    Handle(value int)
}

type MyHandler struct {
    prefix string
}

func (h *MyHandler) Handle(value int) {
    fmt.Printf("[%s] received: %d\\n", h.prefix, value)
}

//export goCallback
func goCallback(handle C.uintptr_t, value C.int) {
    // Recover the Go value from the handle
    h := cgo.Handle(handle).Value().(EventHandler)
    h.Handle(int(value))
}

func registerAndCall() {
    handler := &MyHandler{prefix: "test"}

    // cgo.Handle stores the Go value and returns a stable integer handle
    // The handle prevents GC from collecting the handler while C holds it
    handle := cgo.NewHandle(handler)
    defer handle.Delete() // MUST delete when C is done with it

    // Pass the handle (a uintptr) to C - safe, GC won't move a uintptr
    C.call_with_value(C.uintptr_t(handle), 42)
    // Output: [test] received: 42
}

func main() {
    registerAndCall()
}
\`\`\`

### #cgo Directives: Linking External Libraries

CGO directives in comments before \`import "C"\` configure the C compiler and linker, specifying include paths, library names, and compiler flags needed to build on each target platform.

\`\`\`go
// Linking a system library
package sqlite3

/*
#cgo CFLAGS: -I/usr/include
#cgo LDFLAGS: -lsqlite3

// Platform-specific flags:
#cgo linux LDFLAGS: -ldl -lpthread
#cgo darwin LDFLAGS: -lsqlite3
#cgo windows LDFLAGS: -lsqlite3

// Using pkg-config (recommended for complex libraries):
#cgo pkg-config: sqlite3
#cgo pkg-config: openssl

#include <sqlite3.h>
*/
import "C"
\`\`\`

For static linking, add \`-static\` to \`LDFLAGS\`: \`#cgo LDFLAGS: -L/path/to/lib -lmylib -static\`. Cross-compilation with CGO requires the target architecture's C compiler, for example, \`CC=aarch64-linux-gnu-gcc GOOS=linux GOARCH=arm64 go build\`. Use the \`//go:build cgo\` constraint to include a file only when CGO is enabled.

### The Hidden Costs of CGO

Before approving a CGO dependency, weigh all the costs:

1. **Cross-compilation becomes harder.** You need a C toolchain for every target architecture. CI grows.
2. **Binary size grows.** Statically linking C libraries adds megabytes. Dynamic linking adds deployment complexity.
3. **Debugging crosses a boundary.** Stack traces are opaque at the C/Go boundary. Backtraces skip frames.
4. **Goroutine scheduling is affected.** CGO calls park the goroutine's M, potentially starting a new one.
5. **Security posture widens.** Every CGO dependency is a C-level supply-chain risk.

For a senior engineer evaluating the decision, the rule is "pure Go unless no viable pure-Go alternative exists". The exceptions (SQLite, OpenSSL, hardware-specific drivers) are well-known. Everything else deserves a pure-Go rewrite attempt first.

---
`;
