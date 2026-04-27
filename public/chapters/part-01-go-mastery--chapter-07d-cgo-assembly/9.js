export default `## 7D.8 Working with C Arrays, Enums, and Unions

### C Arrays

C arrays and Go slices have different memory layouts and ownership semantics. Converting between them requires \`unsafe.Pointer\` to reinterpret C array memory as a Go slice header, with careful attention to bounds and lifetime.

\`\`\`go
package main

/*
#include <stdlib.h>
#include <string.h>

// C function returning a dynamically allocated array
// Caller must free() the returned pointer
int* create_sequence(int n, int* out_len) {
    *out_len = n;
    int* arr = (int*)malloc(n * sizeof(int));
    for (int i = 0; i < n; i++) {
        arr[i] = i * i;  // squares: 0, 1, 4, 9, 16...
    }
    return arr;
}

// C function taking an array
int sum_array(const int* arr, int len) {
    int total = 0;
    for (int i = 0; i < len; i++) total += arr[i];
    return total;
}
*/
import "C"

import (
    "fmt"
    "unsafe"
)

// CArrayToGoSlice converts a C int array to a Go []int32 WITHOUT copying
// The caller must NOT call free() while the slice is in use
func CArrayToGoSlice(ptr *C.int, length int) []int32 {
    return (*[1 << 30]int32)(unsafe.Pointer(ptr))[:length:length]
}

func GetSequence(n int) ([]int, func()) {
    var length C.int
    ptr := C.create_sequence(C.int(n), &length)
    // Create a Go slice that VIEWS the C memory (no copy)
    view := CArrayToGoSlice(ptr, int(length))
    // Return a cleanup function - caller must call it
    cleanup := func() { C.free(unsafe.Pointer(ptr)) }
    // Copy to Go heap so C memory can be freed safely
    result := make([]int, len(view))
    for i, v := range view {
        result[i] = int(v)
    }
    return result, cleanup
}

// PassSliceToC passes a Go []int32 to a C function taking int*
func SumGoSlice(data []int32) int {
    if len(data) == 0 {
        return 0
    }
    // &data[0] pins the slice header; Go runtime pins the backing array
    // during the CGO call (automatic since Go 1.17)
    result := C.sum_array((*C.int)(unsafe.Pointer(&data[0])), C.int(len(data)))
    return int(result)
}

func main() {
    seq, cleanup := GetSequence(5)
    defer cleanup()
    fmt.Println(seq) // [0 1 4 9 16]

    data := []int32{1, 2, 3, 4, 5}
    fmt.Println("sum:", SumGoSlice(data)) // 15
}
\`\`\`

### C Enums and Bit Flags

C enums are represented as integer constants accessed via the \`C\` pseudo-package. Bit flag enums map naturally to Go's \`iota\` and bitwise operations for use within Go code.

\`\`\`go
package main

/*
#include <stdint.h>

// C enum
typedef enum {
    STATUS_OK       = 0,
    STATUS_ERROR    = 1,
    STATUS_TIMEOUT  = 2,
    STATUS_CANCELED = 3,
} Status;

// C bit flags
typedef uint32_t Flags;
#define FLAG_READ    (1 << 0)
#define FLAG_WRITE   (1 << 1)
#define FLAG_EXECUTE (1 << 2)
#define FLAG_ADMIN   (1 << 7)

Status check_flags(Flags f) {
    if (f & FLAG_READ) return STATUS_OK;
    return STATUS_ERROR;
}
*/
import "C"

import "fmt"

// Map C enum to Go type
type Status int

const (
    StatusOK       Status = Status(C.STATUS_OK)
    StatusError    Status = Status(C.STATUS_ERROR)
    StatusTimeout  Status = Status(C.STATUS_TIMEOUT)
    StatusCanceled Status = Status(C.STATUS_CANCELED)
)

func (s Status) String() string {
    switch s {
    case StatusOK:
        return "OK"
    case StatusError:
        return "Error"
    case StatusTimeout:
        return "Timeout"
    case StatusCanceled:
        return "Canceled"
    default:
        return fmt.Sprintf("Status(%d)", int(s))
    }
}

// Map C flags to Go constants
const (
    FlagRead    = C.FLAG_READ
    FlagWrite   = C.FLAG_WRITE
    FlagExecute = C.FLAG_EXECUTE
    FlagAdmin   = C.FLAG_ADMIN
)

func CheckFlags(flags uint32) Status {
    return Status(C.check_flags(C.Flags(flags)))
}

func main() {
    s := CheckFlags(FlagRead | FlagWrite)
    fmt.Println(s) // OK

    s2 := CheckFlags(0)
    fmt.Println(s2) // Error
}
\`\`\`

### C Unions

C unions have no direct Go equivalent. CGO represents unions as \`[N]byte\` arrays sized to the union's total size, requiring explicit byte-level casting to access individual members.

\`\`\`go
package main

/*
#include <stdint.h>
#include <string.h>

// C union - all fields share the same memory
typedef union {
    int32_t  as_int;
    float    as_float;
    uint8_t  as_bytes[4];
} Value;

Value make_int_value(int32_t v) {
    Value val;
    val.as_int = v;
    return val;
}
*/
import "C"

import (
    "fmt"
    "unsafe"
)

// Go cannot directly represent C unions - access the underlying bytes
func UnionAsInt(v C.Value) int32 {
    // Access the union's memory as int32 via the first field
    return int32(*(*C.int)(unsafe.Pointer(&v)))
}

func UnionAsFloat(v C.Value) float32 {
    return *(*float32)(unsafe.Pointer(&v))
}

func main() {
    v := C.make_int_value(1078523331) // IEEE 754 bits for 3.14...
    fmt.Println("as int:", UnionAsInt(v))
    fmt.Println("as float:", UnionAsFloat(v)) // ~3.14
}
\`\`\`

### Layout Fragility

C arrays, enums, and unions assume a specific memory layout that can change between C compiler versions, target platforms, and library revisions. The senior-track discipline: generate the Go types from the C headers using \`cgo -godefs\` or \`c-for-go\`, and regenerate whenever the C library updates. Hand-maintained layout definitions silently drift.

---
`;
