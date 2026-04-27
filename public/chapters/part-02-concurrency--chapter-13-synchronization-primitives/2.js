export default `## 13.1 Understanding Synchronization in Go

While channels are Go's primary mechanism for goroutine communication and synchronization, the \`sync\` package provides essential primitives for scenarios where protecting shared mutable state is more appropriate than message passing.

### When Channels vs Sync Primitives

Choosing between channels and sync primitives is one of the most consequential design decisions in concurrent Go code. The decision tree below captures the key question: channels excel when data ownership moves between goroutines, while sync primitives are the right tool when multiple goroutines must coordinate access to the same shared memory without transferring ownership.

\`\`\`
┌─────────────────────────────────────────────────────────────────┐
│                   Synchronization Decision                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Need to transfer ownership of data?                            │
│  ├── Yes → Channels                                             │
│  │         • Ownership transfers to receiver                    │
│  │         • Clear data flow                                    │
│  │         • Built-in blocking semantics                        │
│  │                                                              │
│  └── No → Need to protect shared state?                        │
│           ├── Yes → Sync Primitives                             │
│           │         • Multiple goroutines access same memory    │
│           │         • State is too large to copy                │
│           │         • Need atomic read-modify-write             │
│           │                                                     │
│           └── No → No synchronization needed                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
\`\`\`

### The sync Package Overview

The \`sync\` and \`sync/atomic\` packages together cover every major synchronization need in Go. The declarations below serve as a quick reference: \`sync.Mutex\` and \`sync.RWMutex\` protect critical sections, \`sync.Once\` guarantees single execution, \`sync.WaitGroup\` waits for a set of goroutines to finish, and the \`atomic\` types introduced in Go 1.19 provide lock-free operations on primitive values without the overhead of a full mutex.

\`\`\`go
package main

import (
    "sync"
    "sync/atomic"
)

// Core sync primitives
var (
    mu       sync.Mutex      // Mutual exclusion lock
    rw       sync.RWMutex    // Reader/writer lock
    once     sync.Once       // One-time execution
    wg       sync.WaitGroup  // Goroutine completion waiting
    cond     *sync.Cond      // Condition variable
    pool     sync.Pool       // Object pool for reuse
    smap     sync.Map        // Concurrent map
)

// Atomic types (Go 1.19+)
var (
    counter  atomic.Int64    // Atomic integer
    flag     atomic.Bool     // Atomic boolean
    ptr      atomic.Pointer[Config]  // Atomic pointer
    value    atomic.Value    // Atomic any
)
\`\`\`

### Memory Model Considerations

Go's memory model guarantees that synchronization primitives provide proper happens-before relationships:

\`\`\`go
// Memory ordering with mutex
var data int
var mu sync.Mutex

// Goroutine 1
mu.Lock()
data = 42  // Write happens before unlock
mu.Unlock()

// Goroutine 2
mu.Lock()   // Lock happens after unlock in G1
fmt.Println(data)  // Guaranteed to see 42
mu.Unlock()
\`\`\`

### Synchronization Edges You Can Actually Rely On

The Go memory model defines specific synchronization edges. The ones you use in practice:

1. **Channel send happens before receive.** Anything the sender wrote before the send is visible to the receiver after the receive.
2. **\`mu.Unlock\` happens before the next \`mu.Lock\`.** Writes under one critical section are visible in the next.
3. **\`once.Do(f)\` return happens before any other \`once.Do\` return.** Writes in \`f\` are visible after any call to \`once.Do\` returns.
4. **\`atomic\` operations provide specific orderings.** All atomic loads and stores are sequentially consistent in Go (stronger than C++'s relaxed ordering).
5. **Goroutine creation happens before the goroutine starts.** \`go f()\` happens before the first instruction of \`f\` in the new goroutine.

Without one of these synchronization edges between two goroutines accessing shared state, the access is a data race and the behaviour is undefined. The Go memory model document is short and worth reading directly at \`go.dev/ref/mem\`.

### Staff Lens: Synchronization Is a Contract

Every piece of shared state has a synchronization contract: who can read, who can write, under which locks. The contract is either explicit (documented next to the field) or implicit (buried in the logic). Implicit contracts drift. Explicit contracts survive refactors.

\`\`\`go
type Cache struct {
    mu sync.RWMutex // protects items and stats below
    items map[string]Item
    stats Stats
}
\`\`\`

The comment is load-bearing. Without it, the next engineer does not know which fields the mutex protects. The staff-level discipline: every shared-state struct has this comment. Without it, the review is incomplete.

---
`;
