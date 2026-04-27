export default `## 7D.2 CGO Performance Overhead

A CGO function call is roughly 30 to 100 nanoseconds, compared to a few nanoseconds for a regular Go function call. Go 1.26 (February 2026) reduced cgo call overhead by approximately 30 percent through runtime changes, so recent measurements on 1.26 land closer to the lower end of this range. The overhead comes from:

\`\`\`
┌────────────────────────────────────────────────────────────────────┐
│              Why CGO Calls Are Slow                                 │
├────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. Stack switch: Go uses growable stacks (8KB–1GB)               │
│     C uses fixed-size stacks. CGO must switch stacks.             │
│     Cost: ~20ns                                                    │
│                                                                     │
│  2. Goroutine handoff: The goroutine must be handed off to an     │
│     "external thread" (OS thread, not managed by Go scheduler)    │
│     Cost: ~20ns                                                    │
│                                                                     │
│  3. GC notification: Go runtime must be notified that a           │
│     goroutine is in C (it cannot be GC'd during CGO call)         │
│     Cost: ~10ns                                                    │
│                                                                     │
│  Total per-call overhead: ~50-100ns (vs ~1-2ns for Go call)      │
│                                                                     │
│  Rule of thumb:                                                    │
│  - CGO worth it when: C call does >1μs of work                   │
│  - CGO NOT worth it when: C call does <100ns of work              │
│    (overhead dominates the actual work)                           │
│                                                                     │
│  Strategy: Batch small C operations into fewer calls              │
│  Example: Don't call C.process(item) in a loop.                  │
│  Instead: C.process_batch(items, count)                           │
└────────────────────────────────────────────────────────────────────┘
\`\`\`

The following example contrasts two approaches: calling a C function once per element (where CGO overhead dominates) versus passing the entire slice in a single call (where the overhead is paid only once). In practice, this batching pattern can turn a CGO bottleneck into a net performance win.

\`\`\`go
package main

/*
#include <string.h>

// Single-item processing: called per item - HIGH CGO OVERHEAD
int process_one(int x) {
    return x * 2;
}

// Batch processing: called once for all items - AMORTIZED OVERHEAD
void process_batch(int* input, int* output, int count) {
    for (int i = 0; i < count; i++) {
        output[i] = input[i] * 2;
    }
}
*/
import "C"

import (
    "fmt"
    "unsafe"
)

// SLOW: CGO overhead per item
func processSlowly(data []int) []int {
    result := make([]int, len(data))
    for i, v := range data {
        result[i] = int(C.process_one(C.int(v))) // CGO call per iteration!
    }
    return result
}

// FAST: One CGO call for all items
func processFast(data []int32) []int32 {
    if len(data) == 0 {
        return nil
    }
    result := make([]int32, len(data))
    C.process_batch(
        (*C.int)(unsafe.Pointer(&data[0])),
        (*C.int)(unsafe.Pointer(&result[0])),
        C.int(len(data)),
    )
    return result
}

func main() {
    data := []int32{1, 2, 3, 4, 5}
    result := processFast(data)
    fmt.Println(result) // [2 4 6 8 10]
}
\`\`\`

### Batching Across the Boundary

The per-call overhead (100-200ns in 2026) dominates when you make millions of tiny CGO calls per second. The canonical fix: batch. Pass a slice of work to C in one call, process, return the results. The per-call cost amortises across the batch size.

---
`;
