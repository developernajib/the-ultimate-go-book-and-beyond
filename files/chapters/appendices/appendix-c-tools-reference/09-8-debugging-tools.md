## 8. Debugging Tools

### 8.1 Delve Debugger

Delve is the standard Go debugger. It understands goroutines, channels, and deferred calls natively. Build with `-gcflags="all=-N -l"` to disable optimizations for the most accurate debugging experience.

```bash
# Install
go install github.com/go-delve/delve/cmd/dlv@latest

# Debug program
dlv debug ./cmd/api

# Debug with arguments
dlv debug ./cmd/api -- -port 8080

# Debug test
dlv test ./internal/user

# Debug specific test
dlv test ./internal/user -- -test.run TestCreate

# Attach to running process
dlv attach $(pgrep myapp)

# Debug binary
go build -gcflags="all=-N -l" -o myapp
dlv exec ./myapp
```

#### Delve Commands

```bash
# Start Delve
dlv debug

# Common commands
(dlv) break main.main       # Set breakpoint
(dlv) break user.go:42      # Breakpoint at line
(dlv) break Create          # Breakpoint on function
(dlv) condition bp1 x > 10  # Conditional breakpoint

(dlv) continue              # Continue execution
(dlv) next                  # Step over
(dlv) step                  # Step into
(dlv) stepout               # Step out

(dlv) print x               # Print variable
(dlv) print user.Email      # Print field
(dlv) locals                # Print local variables
(dlv) args                  # Print function arguments
(dlv) vars                  # Print package variables

(dlv) goroutines            # List goroutines
(dlv) goroutine 5           # Switch to goroutine
(dlv) threads               # List threads

(dlv) stack                 # Print stack trace
(dlv) frame 2               # Select stack frame

(dlv) list                  # Show source code
(dlv) list user.Create      # Show function source

(dlv) clear 1               # Remove breakpoint
(dlv) clearall              # Remove all breakpoints

(dlv) restart               # Restart program
(dlv) exit                  # Quit debugger
```

#### Remote Debugging

```bash
# Start headless server
dlv debug --headless --listen=:2345 --api-version=2 ./cmd/api

# Connect from another machine
dlv connect localhost:2345
```

#### VS Code Integration

```json
// File: .vscode/launch.json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Launch Package",
            "type": "go",
            "request": "launch",
            "mode": "debug",
            "program": "${workspaceFolder}/cmd/api",
            "args": ["-port", "8080"],
            "env": {
                "DB_URL": "postgres://localhost/testdb"
            }
        },
        {
            "name": "Attach to Process",
            "type": "go",
            "request": "attach",
            "mode": "local",
            "processId": "${command:pickProcess}"
        }
    ]
}
```

### 8.2 GDB (GNU Debugger)

```bash
# Build with debug symbols
go build -gcflags="all=-N -l" -o myapp

# Start GDB
gdb myapp

# GDB commands
(gdb) break main.main
(gdb) run
(gdb) next
(gdb) step
(gdb) print variable
(gdb) backtrace
(gdb) continue
(gdb) quit

# Load Go runtime helpers
(gdb) source $(go env GOROOT)/src/runtime/runtime-gdb.py

# Go-specific GDB commands
(gdb) info goroutines
(gdb) goroutine 1 bt
```

### 8.3 Race Detector

```bash
# Run with race detector
go run -race ./cmd/api

# Test with race detector
go test -race ./...

# Build with race detector
go build -race -o myapp ./cmd/api

# Environment variables
GORACE="log_path=/tmp/race.log halt_on_error=1" go test -race ./...

# Race detector options
GORACE="strip_path_prefix=/path/to/project/" go test -race ./...
GORACE="history_size=3" go test -race ./...
GORACE="atexit_sleep_ms=100" go test -race ./...
```

### 8.4 Print Debugging

```go
package main

import (
    "fmt"
    "log"
    "runtime"
)

func debug(format string, args ...any) {
    pc, file, line, _ := runtime.Caller(1)
    fn := runtime.FuncForPC(pc)

    log.Printf("[DEBUG] %s:%d %s: %s",
        file, line, fn.Name(),
        fmt.Sprintf(format, args...))
}

func debugVar(name string, value any) {
    log.Printf("[DEBUG] %s = %#v", name, value)
}

type User struct {
    ID    int
    Email string
}

func main() {
    x := 42
    debug("Processing value")
    debugVar("x", x)

    // Or use fmt.Printf with %#v for detailed output
    user := User{ID: 1, Email: "test@example.com"}
    fmt.Printf("user = %#v\n", user)
    // Output: user = main.User{ID:1, Email:"test@example.com"}
}
```

---
