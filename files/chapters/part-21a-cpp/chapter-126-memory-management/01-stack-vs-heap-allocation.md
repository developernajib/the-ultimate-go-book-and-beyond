## Stack vs Heap Allocation

Every running program divides its memory into distinct regions. The two most important for day-to-day programming are the **stack** and the **heap**.

### The Stack

The stack is a contiguous block of memory that grows and shrinks automatically as functions are called and return. Each function call pushes a new **stack frame** containing its local variables, return address, and saved registers.

```
    High Address
    +-----------------------+
    |   main() frame        |
    |   - argc, argv        |
    |   - local variables   |
    +-----------------------+
    |   processData() frame |
    |   - buffer[256]       |
    |   - counter           |
    +-----------------------+
    |   calculate() frame   |  <-- Stack Pointer (SP)
    |   - result            |
    |   - temp              |
    +-----------------------+
    |                       |
    |   (unused stack)      |
    |                       |
    v                       v
    Low Address
```

Stack allocation is essentially free, it costs a single pointer adjustment. When `calculate()` returns, the stack pointer moves back up and all its local variables are instantly "freed" without any deallocation call.

```cpp
// Stack allocation in C++
void processOrder() {
    int orderId = 42;                    // 4 bytes on stack
    int64_t totalCents = 9995;          // 8 bytes on stack
    char buffer[1024];                  // 1024 bytes on stack
    std::array<int, 100> items;         // 400 bytes on stack
    
    // All of the above are freed automatically when this function returns.
    // No allocator involved. No fragmentation. No GC pause.
}
```

Compare this with Go:

```go
// Go: the compiler decides stack vs heap via escape analysis
func processOrder() {
    orderId := 42            // likely stack-allocated
    totalCents := int64(9995)// likely stack-allocated
    buffer := [1024]byte{}   // likely stack-allocated
    items := [100]int{}      // likely stack-allocated
    
    // Go's escape analysis determines placement.
    // If none of these escape, they stay on the stack -- same as C++.
}
```

**Key insight for Go developers:** Go performs escape analysis at compile time to decide whether a variable lives on the stack or heap. C++ gives you explicit control, local variables are always on the stack, heap allocation requires explicit calls.

### The Heap

The heap is a large pool of memory managed by an allocator (like `malloc`/`free` or `new`/`delete`). Heap allocation is orders of magnitude slower than stack allocation because:

1. The allocator must search for a free block of the right size
2. It must update bookkeeping metadata (free lists, size headers)
3. The memory may not be in CPU cache (cache miss)
4. Deallocation must also update the allocator's data structures
5. Over time, the heap can become **fragmented**

```
    Heap Memory (fragmented after many alloc/free cycles)
    +-------+----+----------+----+---+--------+----+----------+
    | Used  |Free|  Used    |Free|Usd| Used   |Free|  Used    |
    | 64B   |32B |  256B    |16B |8B | 128B   |48B |  512B    |
    +-------+----+----------+----+---+--------+----+----------+
    
    Requesting 40 bytes: must scan free list.
    The 48-byte block works, but the 32-byte and 16-byte blocks don't.
    This search takes time and the resulting allocation leaves 8 bytes wasted.
```

```cpp
// Heap allocation in C++
void processLargeData() {
    // Explicitly heap-allocated
    int* data = new int[1000000];       // 4 MB on the heap
    
    // ... use data ...
    
    delete[] data;                       // You MUST free it yourself
}
```

### Performance Comparison

Here is a benchmark that demonstrates the difference:

```cpp
#include <chrono>
#include <iostream>
#include <vector>

void benchmarkStack() {
    auto start = std::chrono::high_resolution_clock::now();
    
    for (int i = 0; i < 1000000; ++i) {
        int buffer[256];  // Stack allocation
        buffer[0] = i;    // Prevent optimization
        volatile int sink = buffer[0];
    }
    
    auto end = std::chrono::high_resolution_clock::now();
    auto duration = std::chrono::duration_cast<std::chrono::microseconds>(end - start);
    std::cout << "Stack: " << duration.count() << " us\n";
}

void benchmarkHeap() {
    auto start = std::chrono::high_resolution_clock::now();
    
    for (int i = 0; i < 1000000; ++i) {
        int* buffer = new int[256];  // Heap allocation
        buffer[0] = i;
        volatile int sink = buffer[0];
        delete[] buffer;             // Heap deallocation
    }
    
    auto end = std::chrono::high_resolution_clock::now();
    auto duration = std::chrono::duration_cast<std::chrono::microseconds>(end - start);
    std::cout << "Heap:  " << duration.count() << " us\n";
}

int main() {
    benchmarkStack();  // Typically: ~1,000 us
    benchmarkHeap();   // Typically: ~25,000 us (25x slower)
}
```

Typical results on modern hardware:

| Method | Time (1M iterations) | Relative Speed |
|--------|---------------------|----------------|
| Stack  | ~1 ms               | 1x (baseline)  |
| Heap   | ~25 ms              | ~25x slower    |

### When to Use Each

**Use the stack when:**
- Object lifetime matches function scope
- Size is known at compile time
- Size is small (typically < 1 MB, stack size is usually 1-8 MB)
- Performance is critical (tight loops, hot paths)

**Use the heap when:**
- Object must outlive the creating function
- Size is determined at runtime
- Size is large (megabytes+)
- Object must be shared across threads or data structures
- Polymorphism requires dynamic dispatch (base pointer to derived object)

**Go comparison:** In Go, you rarely think about this. The compiler's escape analysis handles placement, and the GC cleans up heap objects. The trade-off is that you surrender control over allocation placement, which matters in latency-sensitive systems.

---
