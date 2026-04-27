export default `## 10C.18 Mutex and WaitGroup Disasters

### Mutex Copy After First Use

Copying a \`sync.Mutex\` after it has been used copies its internal state and can cause deadlocks. The \`go vet\` \`copylocks\` checker detects this. Mutexes must always be passed and stored by pointer.

\`\`\`go
package main

import (
    "fmt"
    "sync"
)

type Counter struct {
    mu    sync.Mutex
    count int
}

func (c *Counter) Inc() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.count++
}

func main() {
    c1 := Counter{}
    c1.Inc()

    // DISASTER: copying a sync.Mutex (or any sync type) after first use is a bug
    // The copy contains the internal state of the mutex (locked/unlocked)
    // Running go vet catches this: "assignment copies lock value"
    c2 := c1 // WRONG: copies the mutex internal state
    c2.Inc() // may deadlock if c1 was locked when copied

    // CORRECT: Always use pointers for types containing sync types
    c3 := &Counter{}
    c3.Inc()
    c4 := c3 // copies the pointer, not the mutex - safe!
    c4.Inc()
    fmt.Println(c4.count) // 2

    // go vet catches mutex copies:
    // run: go vet ./... to detect this automatically
}
\`\`\`

### WaitGroup Misuse

\`sync.WaitGroup\` requires that \`Add\` calls happen before the goroutines they track are launched, and that \`Done\` is called exactly once per \`Add\`. The following examples show common misuse patterns and their consequences.

\`\`\`go
package main

import (
    "fmt"
    "sync"
)

func main() {
    var wg sync.WaitGroup

    // TRAP 1: Add inside goroutine - race between Add and Wait
    for i := range 5 {
        go func(n int) {
            wg.Add(1) // BUG: if wg.Wait() runs before this Add, it returns early
            defer wg.Done()
            fmt.Println(n)
        }(i)
    }
    wg.Wait() // might return before all goroutines have run!

    // CORRECT: Add before launching goroutines
    var wg2 sync.WaitGroup
    for i := range 5 {
        wg2.Add(1) // Add before go
        go func(n int) {
            defer wg2.Done()
            fmt.Println(n)
        }(i)
    }
    wg2.Wait()

    // TRAP 2: Done called more times than Add - panics with negative counter
    var wg3 sync.WaitGroup
    wg3.Add(1)
    wg3.Done()
    // wg3.Done() // panic: sync: negative WaitGroup counter

    // TRAP 3: Copying WaitGroup (same as mutex copy issue)
    var wg4 sync.WaitGroup
    wg4.Add(1)
    wg5 := wg4 // WRONG: copies WaitGroup state
    _ = wg5
    // Use pointers for WaitGroup when passing around
}
\`\`\`

---
`;
