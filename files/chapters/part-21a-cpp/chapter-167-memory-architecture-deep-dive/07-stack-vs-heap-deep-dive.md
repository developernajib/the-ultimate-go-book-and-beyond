## 07. Stack vs Heap: Why the Stack Is Fast and the Heap Is Slow

The performance difference between stack and heap allocation is not mystical. It comes from specific, mechanical differences in how the two regions work. Knowing these differences tells you when to avoid heap allocation and how to structure code to stay stack-resident.

### Why the Stack Is Fast

#### Allocation is a Single Instruction

When a function is called, the CPU pushes a stack frame by subtracting from the stack pointer (SP). On x86-64:

```asm
sub rsp, 64   ; allocate 64 bytes for local vars
```

That is one instruction. It costs about 1 clock cycle. The memory is "allocated", there is no allocator metadata to update, no free list to consult, no lock to acquire.

When the function returns:

```asm
add rsp, 64   ; or: mov rsp, rbp ; pop rbp ; ret
```

The frame is "freed", again, one instruction. Nothing is zeroed, nothing is returned to a pool. The stack pointer just moves back up.

#### The Stack Is Cache-Hot

Stack frames are at the top of the stack, which is the most recently used memory in the process. The top of the stack lives in L1 cache almost always. When you declare a local variable, it is almost certainly already in L1.

Heap allocations return memory from anywhere in a potentially large arena. A freshly allocated heap block may come from a cold region not recently accessed, a TLB miss and a DRAM fetch.

#### No Fragmentation

The stack is always a contiguous block used in LIFO order. There is no fragmentation. Allocation and deallocation are always at the same point (the stack pointer). The heap, by contrast, allocates and frees blocks in arbitrary order, creating holes that fragment the free space.

#### No Synchronization

Each goroutine (or thread) has its own stack. Stack operations are single-threaded by definition. No mutex, no CAS, no atomic needed.

Heap allocation in a multi-threaded program requires the allocator to synchronize access to its free lists. Even with thread-local caches (as in tcmalloc, jemalloc, and Go's mcache), there is still some overhead: atomic operations, lock-free queues, or occasional central lock acquisition.

### Why the Heap Is Slow

#### The Allocator Must Find Space

The heap allocator maintains metadata about free and allocated regions. Servicing an allocation request requires finding a suitable free block, splitting it if necessary, updating the metadata, and returning a pointer. This is 10-100+ clock cycles depending on the allocator and the allocation pattern.

Go's allocator uses a size-class scheme (mspan): objects are rounded up to one of ~70 size classes (8, 16, 24, ... bytes), and each size class has its own free list. This reduces fragmentation and makes allocation for common sizes fast, but it still requires:
- Checking the per-goroutine mcache for the size class.
- On a miss, locking an mcentral to refill the mcache.
- On a further miss, acquiring new pages from the mheap (via `mmap` if needed).

#### GC Pressure

Every heap allocation in Go is a potential source of GC work. The GC must scan live heap objects to find pointers. More allocations mean more objects to scan, more write barrier overhead, and more frequent GC cycles.

A program that allocates 100MB/s of short-lived objects will trigger GC far more often than one that reuses objects. Each GC cycle pauses goroutines for marking (the concurrent GC still has stop-the-world phases), introduces latency jitter, and consumes CPU.

#### Pointer Indirection and Cache Misses

Stack-allocated values are accessed directly by the CPU at their known offset from SP. Heap-allocated values require a pointer dereference: load the pointer, then load the value at the pointer's address. If the heap value is cold (not in cache), this is a cache miss.

A linked list node at a heap address is a pointer chase. Each node dereference is potentially a cache miss. An array of values on the stack is sequential memory, one cache line contains multiple values.

```go
// Heap-allocated linked list: pointer chase, cache-cold
type Node struct {
    val  int64
    next *Node
}

func sumList(head *Node) int64 {
    sum := int64(0)
    for head != nil {
        sum += head.val   // DRAM access if cold
        head = head.next  // DRAM access if cold
    }
    return sum
}

// Stack-friendly equivalent: sequential, cache-hot
func sumSlice(data []int64) int64 {
    sum := int64(0)
    for _, v := range data {
        sum += v  // L1/L2 cache hit (sequential)
    }
    return sum
}
```

For N = 1 million elements, `sumSlice` is typically 10-30x faster than `sumList` on modern hardware.

#### TLB Pressure

A heap that grows to gigabytes spans many 4KB pages. Accessing objects scattered across the heap causes TLB misses as the MMU must translate many different virtual-to-physical mappings. Stack accesses concentrate in a small number of pages, usually just one, and stay TLB-hot.

### When to Use Each

**Use the stack when**:
- The data's lifetime ends when the function returns.
- The data is small enough not to blow the stack (< ~64KB, conservatively).
- Performance is critical and allocation is on a hot path.

**Use the heap when**:
- The data must outlive the function that creates it.
- The data needs to be shared between goroutines.
- The data's size is determined at runtime and may be large.
- The data needs to be returned to the caller.

### Escape Analysis in Go

Go's compiler performs escape analysis to determine whether a variable can be allocated on the stack or must be allocated on the heap. A variable "escapes" to the heap when the compiler cannot prove that its address is not used after the function returns.

```go
// Does not escape: compiler sees the pointer never leaves this function
func noEscape() int {
    x := 42
    return x + 1  // x is used by value, not by pointer
}

// Escapes: pointer returned to caller, must live on heap
func escapes() *int {
    x := 42
    return &x  // x escapes to heap
}

// May escape: passed to interface, compiler cannot see through it
func mayEscape(v interface{}) {
    fmt.Println(v)  // v likely escapes due to fmt.Println's signature
}
```

To see what the compiler decides:

```bash
go build -gcflags='-m -m' ./...
```

Output lines like:
```
./main.go:12:2: x escapes to heap
./main.go:7:7: &x does not escape
```

Key escape triggers in Go:
- Taking the address of a local variable and returning it.
- Storing a pointer in a struct that escapes.
- Passing a value to an `interface{}` parameter (the value is boxed on the heap).
- Closures that capture variables from an outer scope (captured variables escape).
- Slices that grow beyond their initial capacity (the backing array is reallocated on the heap).

### Avoiding Escapes: Practical Patterns

```go
// Bad: allocates on heap for every call
func processRequest(data []byte) error {
    buf := make([]byte, 1024)  // may escape if processRequest escapes
    _ = buf
    return nil
}

// Better: reuse a buffer with sync.Pool
var bufPool = sync.Pool{
    New: func() interface{} { return make([]byte, 1024) },
}

func processRequestPooled(data []byte) error {
    buf := bufPool.Get().([]byte)
    defer bufPool.Put(buf)
    _ = buf
    return nil
}

// Best for fixed-size: stack-allocate with a fixed array
func processRequestStack(data []byte) error {
    var buf [1024]byte  // on stack if processRequestStack does not escape
    _ = buf[:]
    return nil
}
```

```go
// Interface boxing causes escape, avoid on hot paths
type Counter interface {
    Inc()
}

// Every call to doWork boxes c on the heap
func doWorkBad(c Counter) {
    c.Inc()
}

// Use concrete type on hot path, accept interface at a higher level
type concreteCounter struct{ n int64 }
func (c *concreteCounter) Inc() { c.n++ }

func doWorkFast(c *concreteCounter) {
    c.Inc()  // direct call, no interface dispatch, no boxing
}
```

### Stack Size Limits in Go

Goroutine stacks start at 8KB. Go uses segmented stacks (actually contiguous stacks that are grown by copy). When a goroutine's stack is full, the runtime allocates a new, larger stack, copies the contents, and updates all pointers. This copy is O(stack size) and can cause latency spikes for goroutines with large stacks that are growing frequently.

You can avoid stack growth on hot paths by keeping functions shallow (small number of nested calls, small local variables) and avoiding deep recursion.

```go
// Force a goroutine to start with a larger stack (no standard API in Go)
// The only way is to call runtime.GOMAXPROCS (does not help) or
// accept that the stack will grow automatically.
// For performance-critical goroutines, keep the hot path shallow.
```

**Watch:** [Stack vs Heap Memory. Simple Explanation](https://www.youtube.com/watch?v=5OJRqkYbK-4), recommended for visual learners.
