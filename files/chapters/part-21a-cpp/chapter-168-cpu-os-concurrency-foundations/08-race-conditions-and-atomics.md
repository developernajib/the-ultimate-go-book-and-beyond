## 08. Race Conditions, Memory Barriers, and Atomic Operations

### Why Most Operations Are Not Atomic

An atomic operation completes in one indivisible step. No other CPU can observe it in a partially-complete state.

Most high-level operations are not atomic. Consider incrementing a counter:

```go
counter++
```

This compiles to three machine instructions:

```asm
mov rax, [counter]   ; 1. Load current value from memory into register
inc rax              ; 2. Add 1 to the register
mov [counter], rax   ; 3. Store result back to memory
```

If two goroutines run this sequence concurrently on separate cores, they can interleave:

```
Core 0                      Core 1
mov rax, [counter]   → reads 0
                            mov rax, [counter]   → also reads 0
inc rax              → rax = 1
mov [counter], rax   → writes 1
                            inc rax              → rax = 1
                            mov [counter], rax   → writes 1 (lost an increment)
```

Counter ends at 1 instead of 2. This is a race condition, the result depends on the timing of two concurrent threads, which is nondeterministic.

---

### The Critical Section

A critical section is a block of code that accesses shared mutable state. Only one thread should execute in the critical section at a time. The rest of concurrency design is figuring out how to enforce this property without deadlock, livelock, or excessive contention.

Three requirements for a correct solution:
1. **Mutual exclusion:** At most one thread in the critical section at a time
2. **Progress:** If no thread is in the critical section and some want to enter, eventually one enters (no deadlock)
3. **Bounded waiting:** No thread waits forever to enter (no starvation)

---

### Why Software-Only Solutions Fail on Modern Hardware

Peterson's algorithm is a classic software-only solution for mutual exclusion between two threads. It uses two flag variables and a turn variable. It provably satisfies all three requirements, on a sequential, in-order machine.

Modern CPUs execute instructions out of order. The CPU does not guarantee that stores appear to other cores in program order. A store to `flag[0]` and then to `turn` might be observed by another core as `turn` first, then `flag[0]`. This breaks Peterson's algorithm.

```c
// Peterson's algorithm
flag[0] = 1;   // "I want in"
turn = 1;      // "Give them a chance"
while (flag[1] && turn == 1) { }  // Wait
// Critical section
flag[0] = 0;
```

If the CPU reorders the writes to `flag[0]` and `turn`, the other thread might observe `turn == 1` before `flag[0] == 1`, incorrectly deciding to enter the critical section.

This is not a theoretical problem. Real code that "works in testing" on x86 (which has relatively strong ordering guarantees) fails on ARM (which has weak ordering guarantees) in production.

---

### Memory Barriers and Fences

A memory barrier (also called a fence) is an instruction that prevents the CPU and compiler from reordering memory operations across it.

Types of barriers:
- **Store-store barrier:** All stores before the barrier appear before stores after it
- **Load-load barrier:** All loads before the barrier appear before loads after it
- **Full barrier:** All memory operations before the barrier appear before all operations after it

Different ISAs have different barrier instructions:
- x86: `mfence`, `sfence`, `lfence`, or implicit barriers from locked instructions
- ARM: `dmb ish` (data memory barrier, inner shareability domain)
- RISC-V: `fence` with operand flags

In Go, you do not write barriers directly. The `sync/atomic` operations include the necessary barriers. The memory model guarantees that if goroutine A performs an atomic store and goroutine B observes that stored value in an atomic load, then all writes before A's store are visible to B after B's load.

---

### Memory Models: Strongly vs Weakly Ordered

Different architectures give different guarantees about memory ordering:

**x86 (Total Store Order / TSO):** Stores from one core appear to all other cores in program order. Loads can be reordered with stores (a load can see a value that a subsequent store will overwrite). This is relatively strong. Many bugs that require explicit barriers on ARM go unnoticed on x86.

**ARM (weakly ordered):** Almost no ordering guarantees by default. Loads and stores can be reordered with other loads and stores. Explicit barriers are required for any cross-core synchronization.

**Go's memory model:** Guarantees happens-before relationships for specific operations: channel sends/receives, sync.Mutex lock/unlock, sync/atomic operations, goroutine creation. For anything not on this list, the behavior is undefined.

---

### Atomic Instructions

Modern CPUs provide atomic instructions that complete as single, indivisible operations. Other cores cannot observe them in a partially-complete state.

**Test-and-set:** Read a memory location and set it to 1 in one atomic step. Returns the old value. Used to implement spinlocks.

```c
// Pseudocode for test-and-set based spinlock
while (test_and_set(&lock) == 1) {
    // lock was already held, spin
}
// Critical section
lock = 0;  // Release
```

**Compare-and-swap (CAS):** If the current value equals expected, write new_value and return true. Otherwise return false and return the current value. This is the foundation of most lock-free data structures.

```go
// Go's atomic CAS
var counter int64 = 0
expected := int64(0)
new_val := int64(1)
swapped := atomic.CompareAndSwapInt64(&counter, expected, new_val)
// if counter == 0, sets counter = 1 and swapped = true
// if counter != 0, does nothing and swapped = false
```

CAS is how you implement any lock-free update: read current value, compute new value, CAS, if CAS fails (another thread changed it), retry with the new current value.

---

### Mutex Built on Atomics

A mutex is implemented using atomic operations:

```
Lock:
  loop:
    if CAS(&state, 0, 1) succeeds → acquired the lock, enter
    else → lock is held, put this thread to sleep (OS wait queue)

Unlock:
  state = 0  (atomic store)
  wake up one waiting thread (OS futex/notification)
```

The OS provides the `futex` (fast userspace mutex) syscall on Linux. The fast path (no contention) uses only atomic instructions in user space, no syscall. Only when the mutex is contended does the thread call into the kernel to sleep.

This is why uncontended mutex operations are very fast (a few nanoseconds) but contended ones are much slower (they involve a syscall and context switch).

---

### Go's sync/atomic Package

```go
package main

import (
	"fmt"
	"sync/atomic"
)

func main() {
	var counter int64

	// Atomic add, returns new value
	newVal := atomic.AddInt64(&counter, 1)

	// Atomic load (with full barrier)
	val := atomic.LoadInt64(&counter)

	// Atomic store
	atomic.StoreInt64(&counter, 42)

	// Compare-and-swap
	swapped := atomic.CompareAndSwapInt64(&counter, 42, 100)

	// Swap, sets to new, returns old
	oldVal := atomic.SwapInt64(&counter, 0)

	fmt.Println(newVal, val, swapped, oldVal)

	// In Go 1.19+, typed atomics provide a cleaner, type-safe API:
	var typedCounter atomic.Int64
	typedCounter.Store(42)
	typedCounter.Add(1)
	fmt.Println("Typed atomic:", typedCounter.Load())
}
```

`atomic.Value` allows storing and loading any value atomically using `Store()` and `Load()`. Useful for configuration that needs to be updated atomically.

---

### The Go Race Detector

Go ships with a race detector built on ThreadSanitizer:

```bash
go test -race ./...
go run -race main.go
```

The race detector instruments every memory access at compile time and tracks which goroutine last wrote to each memory location at runtime. When it detects concurrent access with at least one write and no synchronization, it reports the race with a full stack trace of both goroutines.

The race detector adds overhead (5-10x slower, 5-10x more memory) but is invaluable during development and testing. Running it in CI catches races that are hard to reproduce manually.

---

### Practical Rule

Use channels or `sync.Mutex` for most shared state. Use `sync/atomic` only when:
- You have a hot path where mutex overhead is measurable
- You are implementing a data structure that genuinely requires lock-free access
- You are reading or writing a single value (not a compound operation on multiple fields)

If you are using atomics, document exactly why the atomic is sufficient (which invariant it maintains) and run the race detector.

---

**Watch:** [Hardware Atomics and Memory Barriers](https://www.youtube.com/watch?v=IMceN4_rieo)

**Watch:** [Race Conditions. Why Concurrent Writes Corrupt Data](https://www.youtube.com/watch?v=bhpzTWtee2A)
