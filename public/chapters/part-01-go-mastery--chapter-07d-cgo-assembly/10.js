export default `## 7D.9 Thread Safety: runtime.LockOSThread

CGO and Go's goroutine scheduler interact in a critical way: Go goroutines are multiplexed onto OS threads (the M in GMP). During a CGO call, the goroutine is bound to a specific OS thread. Some C libraries are **thread-local** - they store state in thread-local storage (TLS) and require that all calls from the same "session" happen on the same OS thread.

\`\`\`go
package main

/*
#include <stdio.h>
#include <stdlib.h>

// Simulates a C library that uses thread-local state (like OpenGL, Python GIL, libcurl)
// All calls must come from the same OS thread that called init_context()
static __thread int thread_context_id = -1;

int init_context(int id) {
    thread_context_id = id;
    return 0;
}

int do_operation(int value) {
    if (thread_context_id < 0) {
        return -1; // context not initialized on this thread!
    }
    return value * thread_context_id;
}

void destroy_context() {
    thread_context_id = -1;
}
*/
import "C"

import (
    "fmt"
    "runtime"
)

// ThreadBoundContext wraps a C library that requires thread affinity
type ThreadBoundContext struct {
    id      int
    results chan int
    ops     chan int
    done    chan struct{}
}

// NewThreadBoundContext creates a context pinned to a single OS thread.
// ALL calls to the C library happen on the same OS thread.
func NewThreadBoundContext(id int) *ThreadBoundContext {
    ctx := &ThreadBoundContext{
        id:      id,
        results: make(chan int),
        ops:     make(chan int),
        done:    make(chan struct{}),
    }

    go func() {
        // Pin this goroutine to one OS thread for its entire lifetime.
        // LockOSThread ensures this goroutine always runs on the same M.
        // The thread is retired (not returned to the pool) when the goroutine exits.
        runtime.LockOSThread()
        defer runtime.UnlockOSThread()

        // Initialize C context on THIS OS thread
        C.init_context(C.int(id))
        defer C.destroy_context()

        // All C operations are serialized through this goroutine's event loop
        for {
            select {
            case value := <-ctx.ops:
                result := C.do_operation(C.int(value))
                ctx.results <- int(result)
            case <-ctx.done:
                return
            }
        }
    }()

    return ctx
}

// Call sends an operation to be executed on the pinned thread
func (ctx *ThreadBoundContext) Call(value int) int {
    ctx.ops <- value
    return <-ctx.results
}

// Close shuts down the pinned goroutine
func (ctx *ThreadBoundContext) Close() {
    close(ctx.done)
}

func main() {
    ctx := NewThreadBoundContext(5)
    defer ctx.Close()

    // All calls correctly execute on the same OS thread as init_context
    fmt.Println(ctx.Call(10)) // 50 (10 * 5)
    fmt.Println(ctx.Call(7))  // 35 (7 * 5)
}
\`\`\`

### When to Use runtime.LockOSThread

Certain C libraries require their functions to be called from the same OS thread, particularly those using thread-local storage. \`runtime.LockOSThread\` pins the current goroutine to its OS thread for the duration needed.

\`\`\`
┌────────────────────────────────────────────────────────────────────────┐
│              LockOSThread Use Cases                                     │
├──────────────────────────────────────────────────────────────────────  ┤
│                                                                         │
│  REQUIRED for:                                                          │
│  • OpenGL / Vulkan - GPU context is thread-local                       │
│  • Python embedding - Python GIL is per-thread                        │
│  • libcurl easy_handle - curl handles are thread-local                 │
│  • POSIX per-thread signals (sigprocmask affects current thread only)  │
│  • COM objects on Windows (apartment threading model)                  │
│  • Any library that uses pthread_key_t (thread-local storage)          │
│                                                                         │
│  NOT needed for:                                                        │
│  • Most modern thread-safe libraries                                   │
│  • Libraries using explicit handles/sessions passed as parameters      │
│  • libsodium, OpenSSL (thread-safe when used correctly)               │
│                                                                         │
│  Cost of LockOSThread:                                                 │
│  • The OS thread is dedicated to that goroutine                        │
│  • If the goroutine is blocked, the thread is also blocked             │
│  • Go may create additional OS threads to compensate                  │
│  • Too many LockOSThread goroutines → thread explosion                │
│  • Mitigation: use a worker pool with one locked goroutine per worker │
└────────────────────────────────────────────────────────────────────────┘
\`\`\`

### \`LockOSThread\` Discipline

Three rules:

1. **Always pair \`Lock\` with \`Unlock\` via defer.** A leaked lock keeps the thread forever.
2. **One locked goroutine per thread-local C state.** GUI toolkits, OpenGL contexts, OS APIs that use TLS all require this.
3. **Document why.** The next engineer will not know. The comment next to \`LockOSThread\` should explain the C-side requirement.

---
`;
