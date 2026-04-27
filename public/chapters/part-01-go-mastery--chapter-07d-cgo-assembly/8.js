export default `## 7D.7 Error Handling Across the CGO Boundary

C functions signal errors through return codes, \`errno\`, output parameters, and opaque error handles. Each pattern requires a different translation strategy to produce idiomatic Go errors.

### errno: The C Global Error Code

C functions signal errors by setting the global \`errno\` variable. CGO makes \`errno\` available as a second return value when calling C functions, following a specific import comment pattern.

\`\`\`go
package main

/*
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

// errno is thread-local in modern C - safe to read immediately after the call
int open_file(const char* path, int flags) {
    return open(path, flags);
}
*/
import "C"

import (
    "fmt"
    "os"
    "syscall"
    "unsafe"
)

// OpenFile wraps the C open() syscall with proper errno handling
func OpenFile(path string, flags int) (int, error) {
    cPath := C.CString(path)
    defer C.free(unsafe.Pointer(cPath))

    fd, errno := C.open_file(cPath, C.int(flags))
    if fd < 0 {
        // errno is automatically captured by CGO when you use
        // the two-return-value form: result, errno := C.func(...)
        return -1, fmt.Errorf("open %q: %w", path, errno)
    }
    return int(fd), nil
}

// The two-return-value CGO pattern:
// result, err := C.some_function(args...)
// err is *C.int (errno) cast to error - automatically set by CGO
// Only use this form when the C function sets errno on failure

// Alternative: read errno directly via C.errno (less reliable - thread timing)
func OpenFileDirect(path string) (int, error) {
    cPath := C.CString(path)
    defer C.free(unsafe.Pointer(cPath))

    // Reset errno before call
    C.__errno_location() // Linux: clears errno (platform-specific!)

    fd := C.open_file(cPath, C.O_RDONLY)
    if fd < 0 {
        // Read errno - this is the WRONG pattern (use two-return-value instead)
        errNum := syscall.Errno(C.__errno_location())
        return -1, fmt.Errorf("open failed: %v", errNum)
    }
    return int(fd), nil
}

func main() {
    fd, err := OpenFile("/tmp/test.txt", int(C.O_RDONLY)|int(C.O_CREAT))
    if err != nil {
        if os.IsNotExist(err) {
            fmt.Println("file not found")
        } else {
            fmt.Println("error:", err)
        }
        return
    }
    fmt.Println("opened fd:", fd)
    C.close(C.int(fd))
}
\`\`\`

### C Return Code Patterns

C libraries use several error-signaling conventions: negative return codes, NULL pointers, and error output parameters. Each requires a different CGO wrapping strategy to translate C errors into Go error values.

\`\`\`go
package main

/*
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

// Pattern 1: Returns 0 on success, negative on error (common in POSIX)
typedef struct {
    char message[256];
    int  code;
} AppError;

int do_work(int input, AppError* err) {
    if (input < 0) {
        err->code = -1;
        strncpy(err->message, "input must be non-negative", 255);
        return -1;
    }
    return input * 2;
}

// Pattern 2: Opaque error handle (OpenSSL-style)
typedef struct { int code; char msg[128]; } MyLib_Error;

MyLib_Error* mylib_last_error() {
    static MyLib_Error err = {0, ""};
    return &err;
}

int mylib_operation(int x, MyLib_Error* out_err) {
    if (x < 0) {
        out_err->code = 42;
        strncpy(out_err->msg, "negative input", 127);
        return -1;
    }
    out_err->code = 0;
    return x * 3;
}
*/
import "C"

import (
    "errors"
    "fmt"
)

// CError wraps a C error code and message
type CError struct {
    Code    int
    Message string
}

func (e *CError) Error() string {
    return fmt.Sprintf("C error %d: %s", e.Code, e.Message)
}

// DoWork wraps the C function with proper error propagation
func DoWork(input int) (int, error) {
    var cErr C.AppError
    result := C.do_work(C.int(input), &cErr)
    if result < 0 {
        return 0, &CError{
            Code:    int(cErr.code),
            Message: C.GoString(&cErr.message[0]),
        }
    }
    return int(result), nil
}

// MyLibOperation wraps the opaque error handle pattern
func MyLibOperation(x int) (int, error) {
    var errOut C.MyLib_Error
    result := C.mylib_operation(C.int(x), &errOut)
    if result < 0 {
        return 0, &CError{
            Code:    int(errOut.code),
            Message: C.GoString(&errOut.msg[0]),
        }
    }
    return int(result), nil
}

func main() {
    result, err := DoWork(-5)
    if err != nil {
        var cErr *CError
        if errors.As(err, &cErr) {
            fmt.Printf("C error code=%d message=%s\\n", cErr.Code, cErr.Message)
        }
        return
    }
    fmt.Println("result:", result)
}
\`\`\`

### The Senior-Track Error Contract

Define the CGO wrapper's error contract explicitly:

1. **Which C errno or status codes map to which Go error types?** Document the mapping.
2. **Are C errors wrapped or transparent?** Callers want \`errors.Is(err, ErrInvalidInput)\` to work.
3. **Is the error message safe for logging?** C error messages may contain sensitive data or implementation details.

Without an explicit contract, every caller invents their own and the library becomes a source of inconsistency.

---
`;
