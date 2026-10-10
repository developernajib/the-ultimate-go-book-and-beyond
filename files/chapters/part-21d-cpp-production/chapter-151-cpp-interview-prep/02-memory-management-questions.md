## Memory Management Questions

Memory management is the steepest learning curve for Go engineers moving to C++. Go's garbage collector makes ownership invisible. In C++, ownership is the program. These 20 questions cover every dimension of C++ memory management that interviewers test at FAANG.

---

### Q1. What is the difference between stack and heap allocation?

**Stack allocation** is managed by the CPU's call stack. When a function is called, a stack frame is pushed. When it returns, the frame is popped. All local variables live in the stack frame. Allocation is a single pointer decrement, effectively free. The stack is typically 1-8 MB per thread.

**Heap allocation** (`new`, `malloc`, arena allocators) draws from a large pool managed by the allocator. It can hold gigabytes of data, but every allocation involves a lock, free-list search, and possible system call (`mmap`/`sbrk`). A `new int(42)` on a modern system takes ~50-100 ns. A stack allocation takes ~0 ns.

```cpp
void stack_example() {
    int x = 42;             // stack: automatic storage duration
    int arr[1000];          // stack: 4 KB, freed at function exit
}   // x and arr gone here

void heap_example() {
    int* p = new int(42);   // heap: manual storage duration
    int* arr = new int[1000]; // heap: 4 KB, lives until delete is called
    // ... work ...
    delete p;
    delete[] arr;           // must be deleted explicitly
}
```

The rule: prefer stack allocation for small, short-lived objects. Use heap for large data, objects with dynamic size, or objects that need to outlive their creating function.

---

### Q2. When does `new` throw vs `new(std::nothrow)`?

By default, `new` throws `std::bad_alloc` if the allocation fails. In systems where exceptions are disabled (embedded, Google's style guide), you need `new(std::nothrow)`.

```cpp
#include <new>
#include <cstdlib>

// Throwing form (default)
try {
    int* p = new int[1'000'000'000'000LL];  // likely throws
} catch (const std::bad_alloc& e) {
    std::cerr << "Allocation failed: " << e.what() << "\n";
}

// Non-throwing form
int* p = new(std::nothrow) int[1'000'000'000'000LL];
if (!p) {
    std::cerr << "Allocation failed\n";
    return;
}

// Set-new-handler: called on failure before throwing
std::set_new_handler([]() {
    std::cerr << "OOM handler called\n";
    std::abort();  // or throw std::bad_alloc()
});
```

In embedded and real-time systems, heap allocation itself may be forbidden (MISRA C++), and stack-only or arena allocation is used exclusively.

---

### Q3. What is placement new? Give a real use case.

Placement new constructs an object at a pre-allocated memory address. It does not allocate memory, it only calls the constructor.

```cpp
#include <new>
#include <cstdlib>

// Syntax: new (address) Type(constructor_args...)

alignas(Widget) std::byte buf[sizeof(Widget)];
Widget* w = new (buf) Widget(42, "hello");  // construct in-place in buf
w->~Widget();  // must manually call destructor, placement new requires manual cleanup
```

**Real use cases:**

1. **Arena allocators**, allocate a large block, use placement new for every object:
```cpp
class Arena {
    std::byte storage_[65536];
    size_t offset_ = 0;
public:
    template<typename T, typename... Args>
    T* create(Args&&... args) {
        void* p = storage_ + offset_;
        offset_ += sizeof(T);
        return new (p) T(std::forward<Args>(args)...);
    }
};
```

2. **`std::optional` implementation**, the value is stored in an aligned buffer inside the optional. Placement new constructs it when assigned.

3. **Object pools**, reuse fixed-size memory blocks across object lifetimes without going back to the heap allocator.

---

### Q4. What is a memory leak? How does Valgrind find it?

A memory leak is heap memory that has been allocated but never freed, with all pointers to it lost. The memory remains unavailable until the process exits.

```cpp
void leak() {
    int* p = new int[1000];
    // p goes out of scope without delete[] p
    // 4 KB is now unrecoverable until process exit
}
```

**Valgrind's Memcheck** instruments the program at runtime, tracking every `malloc`/`new` and `free`/`delete`. At program exit, it reports:

```
LEAK SUMMARY:
   definitely lost: 4,000 bytes in 1 blocks
   indirectly lost: 0 bytes in 0 blocks
     possibly lost: 0 bytes in 0 blocks
   still reachable: 0 bytes in 0 blocks
```

The key categories:
- **Definitely lost**: no pointer to the block exists anywhere, true leak
- **Indirectly lost**: block pointed to by a definitely-lost block
- **Possibly lost**: pointer to interior of block found (could be intentional or a bug)
- **Still reachable**: pointer exists but not freed (common for global singletons)

Modern alternative: **AddressSanitizer** (`-fsanitize=address`) is 2-3x faster than Valgrind and also detects use-after-free, stack-buffer-overflows, and heap-buffer-overflows that Valgrind misses.

---

### Q5. What is a dangling pointer? How do smart pointers prevent it?

A dangling pointer is a pointer that refers to memory that has already been freed or is out of scope. Accessing it is undefined behavior.

```cpp
int* dangling() {
    int x = 42;
    return &x;  // x is destroyed on return, pointer dangles immediately
}

int* p = new int(10);
delete p;
*p = 5;  // dangling: p still points to freed memory, UB
```

**`std::unique_ptr`** prevents this by:
1. Owning the pointer, it deletes the object in its destructor
2. Not allowing copies, no two raw pointers to the same object
3. Setting itself to null on move, you cannot accidentally use a moved-from unique_ptr

```cpp
auto p = std::make_unique<int>(10);
auto q = std::move(p);   // p is now nullptr
// *p - // would dereference null, well-defined crash, not UB
*q = 5;                  // OK: q owns the int
// q goes out of scope: int is deleted automatically
```

**`std::shared_ptr`** and **`std::weak_ptr`** prevent dangling via reference counting: the object is not destroyed until all shared_ptrs release it. `weak_ptr::lock()` returns a null shared_ptr if the object is gone, rather than a dangling raw pointer.

---

### Q6. What is `unique_ptr`? What is its overhead vs a raw pointer?

`std::unique_ptr<T>` is a RAII wrapper that represents sole ownership of a heap object. When it goes out of scope or is reset, it calls `delete` (or a custom deleter). Move-only: cannot be copied.

**Overhead**: With the default deleter, `unique_ptr` is **zero-overhead** compared to a raw pointer in release builds. It stores exactly one pointer. The destructor call is inlined as a single `free()`. There is no reference count, no atomic, no lock.

```cpp
#include <memory>

// Both are one machine word (8 bytes on 64-bit)
static_assert(sizeof(std::unique_ptr<int>) == sizeof(int*));

auto p = std::make_unique<int>(42);
*p = 100;
// compiled identically to:
int* raw = new int(42);
*raw = 100;
delete raw;
```

The only overhead is when using a **custom deleter**: if the deleter has state (a lambda capturing variables, a pointer to a function), it is stored in the unique_ptr and increases its size. Stateless deleters (function pointers, empty lambdas) are zero-overhead via empty base optimization.

---

### Q7. When should you use `shared_ptr` vs `unique_ptr`?

**`unique_ptr`** is the default. Use it when there is a clear single owner of the resource. It expresses intent clearly and has zero overhead.

**`shared_ptr`** is for shared ownership, multiple objects need access to the same resource, and the resource should be destroyed when the last owner releases it.

```cpp
// unique_ptr: the parser owns the AST
std::unique_ptr<ASTNode> parse(const std::string& src);

// shared_ptr: a texture may be referenced by many mesh objects
std::shared_ptr<Texture> load_texture(const std::string& path);
class Mesh {
    std::shared_ptr<Texture> texture_;  // shared ownership
};
```

**Costs of `shared_ptr`:**
1. Two words in size (pointer + pointer to control block)
2. Heap allocation for the control block (unless using `make_shared`, which allocates object and control block together)
3. Atomic increment/decrement on copy and destruction, not free on multi-core systems
4. Thread-safe reference count does NOT make the pointed-to object thread-safe

The rule of thumb at FAANG: start with `unique_ptr`. Upgrade to `shared_ptr` only when you have a genuine ownership graph. Never use `shared_ptr` as a "I don't want to think about ownership" escape hatch.

---

### Q8. What is `weak_ptr` and what problem does it solve?

`std::weak_ptr<T>` is a non-owning observer of a `shared_ptr`-managed object. It does not increment the reference count. To use the object, you call `lock()` which returns a `shared_ptr`, either valid or null if the object was already destroyed.

**Problem it solves: circular reference leaks.**

```cpp
// Without weak_ptr, LEAK:
struct Node {
    std::shared_ptr<Node> next;
    std::shared_ptr<Node> prev;  // circular: A→B and B→A, ref counts never reach 0
};

// With weak_ptr, CORRECT:
struct Node {
    std::shared_ptr<Node> next;
    std::weak_ptr<Node>   prev;  // non-owning back-pointer: no cycle
};

// Usage pattern
auto a = std::make_shared<Node>();
auto b = std::make_shared<Node>();
a->next = b;
b->prev = a;  // weak: does not keep a alive
// When a goes out of scope: ref count drops to 0, a is destroyed, no leak

// Safe access via weak_ptr
if (auto owner = b->prev.lock()) {  // lock() returns shared_ptr or null
    // owner is valid here
}
```

`weak_ptr` is also used in observer patterns and caches where the cache should not keep objects alive longer than their natural owners want.

---

### Q9. What is the difference between `make_unique` and `new`?

`std::make_unique<T>(args...)` is always preferred over `new T(args...)`:

1. **Exception safety**: `make_unique` guarantees no leak even if the object constructor throws. With `new`, if you write `f(std::unique_ptr<T>(new T()), g())` and `g()` throws before the unique_ptr is constructed, you have a leak.

2. **No raw pointer in code**: `make_unique` never exposes a raw pointer that could be misused.

3. **Single allocation for `make_shared`**: `make_shared` allocates the object and control block together in one allocation (make_unique allocates only the object).

```cpp
// Prefer:
auto p = std::make_unique<Widget>(42, "hello");

// Over:
std::unique_ptr<Widget> p(new Widget(42, "hello"));  // two tokens expose raw ptr
```

The only case where you must use `new` directly: when you need a custom deleter that `make_unique` cannot express, or when you need to adopt a pointer returned by a C API.

---

### Q10. What is `std::allocator`? What is PMR?

`std::allocator<T>` is the default allocator used by all STL containers. It calls `::operator new` and `::operator delete`. You can replace it with a custom allocator to control where container memory comes from.

**PMR (Polymorphic Memory Resources)**, `std::pmr`, is C++17's solution to the problem that custom allocators change a container's type: `std::vector<int, MyAlloc>` is a different type than `std::vector<int>`, making them impossible to mix in interfaces.

PMR separates the allocator from the container type. All `std::pmr` containers use `std::pmr::polymorphic_allocator` under the hood, which defers to a `memory_resource`, a virtual interface that can point to any allocator.

```cpp
#include <memory_resource>
#include <vector>
#include <array>

// Stack-based buffer for PMR
std::array<std::byte, 4096> buf;
std::pmr::monotonic_buffer_resource pool{buf.data(), buf.size()};

// Both are the same type: std::pmr::vector<int>
std::pmr::vector<int> v1{&pool};  // allocates from stack buffer
std::pmr::vector<int> v2{&pool};

void process(std::pmr::vector<int>& data);  // works with any pmr memory source
process(v1);
process(v2);
```

PMR is critical for performance-sensitive code that needs to control allocation strategy per-request or per-frame without changing every API signature.

---

### Q11. What is an arena allocator? When would you use one?

An arena allocator allocates from a contiguous block of memory using a bump pointer. Individual frees are no-ops. The entire arena is released at once.

```cpp
class Arena {
    std::byte* base_;
    size_t     offset_ = 0;
    size_t     capacity_;
public:
    explicit Arena(size_t cap)
        : base_(static_cast<std::byte*>(std::malloc(cap))), capacity_(cap) {}
    ~Arena() { std::free(base_); }

    void* alloc(size_t n, size_t align = alignof(std::max_align_t)) {
        size_t start = (offset_ + align - 1) & ~(align - 1);
        if (start + n > capacity_) return nullptr;
        offset_ = start + n;
        return base_ + start;
    }
    void reset() { offset_ = 0; }
};
```

**Use arena allocators when:**
- Objects share a lifetime (e.g., all AST nodes for one parse, all objects for one HTTP request)
- You need predictable, low-latency allocation (games: one arena per frame, reset each frame)
- You want to eliminate `free()` cost, bulk-freeing the arena is O(1)
- Thread-local arenas eliminate all lock contention

The tradeoff: no individual object freeing. If some objects in the arena need to be freed early, an arena is the wrong tool. Use a pool allocator instead.

---

### Q12. What is false sharing? How do you fix it?

False sharing occurs when two threads modify independent variables that happen to reside on the same CPU cache line (typically 64 bytes). Because the cache coherence protocol operates at the cache-line level, one core's write invalidates the other core's cache line, causing the other core to reload it on its next access, even though it wrote a different variable.

```cpp
// FALSE SHARING: both variables fit in one 64-byte cache line
struct Counters {
    std::atomic<int64_t> count_a;  // bytes 0-7
    std::atomic<int64_t> count_b;  // bytes 8-15
    // Thread 1 writes count_a, Thread 2 writes count_b
    // Both thrash the same cache line
};

// FIXED: pad to separate cache lines
struct alignas(64) Counter {
    std::atomic<int64_t> value;
    std::byte padding[64 - sizeof(std::atomic<int64_t>)];
};

struct Counters {
    Counter a;  // cache line 1
    Counter b;  // cache line 2, no false sharing
};

// C++17 hardware_destructive_interference_size:
struct alignas(std::hardware_destructive_interference_size) AlignedCounter {
    std::atomic<int64_t> value;
};
```

False sharing can reduce throughput by 10-100x on multi-core systems. It is detected by `perf stat -e cache-misses` or hardware performance counters and is a common question in systems-focused FAANG interviews.

---

### Q13. What is memory alignment? What is `alignas`?

Memory alignment means an object's address must be a multiple of its alignment requirement. `int` (4 bytes) must start at an address divisible by 4. `double` (8 bytes) at an address divisible by 8. Misaligned access on some architectures (ARM) causes a hardware fault. On x86, it silently degrades performance.

`alignas(N)` specifies a minimum alignment for a variable or type.

```cpp
#include <cstddef>

struct Normal {
    char  c;    // 1 byte at offset 0
    // 3 bytes padding
    int   i;    // 4 bytes at offset 4
    double d;   // 8 bytes at offset 8
};  // sizeof = 16, alignof = 8

alignas(64) int hot_var;       // aligned to cache-line boundary
alignas(16) float simd_buf[4]; // required by SSE/AVX intrinsics

// alignof: query required alignment
static_assert(alignof(double) == 8);
static_assert(alignof(std::max_align_t) == 16);  // strictest fundamental alignment
```

**Why it matters in interviews:** SIMD intrinsics (`_mm_load_ps` vs `_mm_loadu_ps`) require 16/32-byte alignment. DMA buffers must meet hardware alignment requirements. Padding in structs wastes memory and should be minimized by ordering fields from largest to smallest.

---

### Q14. What is virtual memory? What is a page fault?

**Virtual memory** is an abstraction provided by the OS and MMU: each process sees a flat address space (0 to 2^64-1 on 64-bit systems) even though physical RAM is much smaller. The MMU maps virtual addresses to physical pages (4 KB each) via page tables.

**A page fault** occurs when a program accesses a virtual address whose page table entry is not present in physical RAM. The OS kernel handles it:
- **Minor page fault**: page exists in memory but the page table entry was not set up (e.g., newly allocated page). Fast, ~100 ns.
- **Major page fault**: page must be loaded from disk (swap). Slow, milliseconds.

```cpp
// This triggers page faults:
void* p = mmap(nullptr, 1'000'000'000, PROT_READ|PROT_WRITE,
               MAP_ANONYMOUS|MAP_PRIVATE, -1, 0);
// mmap returns immediately, no physical memory yet
// Each first access to a page triggers a minor fault
for (size_t i = 0; i < 1'000'000'000; i += 4096) {
    static_cast<char*>(p)[i] = 1;  // minor fault: OS maps physical page
}
```

`malloc` for large allocations calls `mmap`. The pages are demand-paged. `mlockall(MCL_CURRENT|MCL_FUTURE)` pre-faults all pages, used in real-time trading systems to eliminate latency spikes.

---

### Q15. What is NUMA? How does it affect allocation strategy?

**NUMA** (Non-Uniform Memory Access) is a hardware architecture in multi-socket servers where each CPU socket has its own local memory. Accessing local memory is fast (~80 ns). Accessing a remote socket's memory crosses the inter-socket interconnect (Intel QPI/UPI or AMD Infinity Fabric) at ~150-200 ns.

In a 4-socket server, code running on socket 0 that allocates from socket 3's memory runs at 2-3x worse memory bandwidth.

```cpp
// Linux NUMA API (libnuma):
#include <numa.h>

// Bind current thread and its future allocations to NUMA node 0
numa_run_on_node(0);
numa_set_preferred(0);

void* p = numa_alloc_local(1024 * 1024);  // allocate on current node's memory
// ...
numa_free(p, 1024 * 1024);

// Check which node an address is on:
int node;
get_mempolicy(&node, nullptr, 0, p, MPOL_F_NODE | MPOL_F_ADDR);
```

The interview point: in high-performance C++ servers (databases, trading systems), NUMA awareness is non-negotiable. Thread pools are pinned to NUMA nodes, memory is allocated on the same node that will access it, and lock-free queues are designed to minimize cross-socket traffic.

---

### Q16. What does AddressSanitizer detect?

AddressSanitizer (ASan), enabled with `-fsanitize=address`, instruments memory accesses at compile time and maintains a shadow memory map to detect:

- **Heap buffer overflow/underflow**: writing past the end of a `new`-allocated array
- **Stack buffer overflow**: writing past a local array
- **Global buffer overflow**: writing past a global array
- **Use-after-free**: reading/writing heap memory after `delete`
- **Use-after-return**: returning a pointer to a local variable (stack-use-after-scope variant)
- **Double-free**: calling `delete` twice on the same pointer
- **Memory leaks** (via LeakSanitizer, often integrated)

```bash
# Compile and run:
g++ -fsanitize=address -fno-omit-frame-pointer -g -O1 prog.cpp -o prog
./prog

# Output on use-after-free:
# ERROR: AddressSanitizer: heap-use-after-free on address 0x...
# READ of size 4 at 0x... thread T0
#     #0 main prog.cpp:12
```

ASan imposes ~2x runtime overhead and 3x memory overhead. It is used in CI pipelines and fuzz testing. Unlike Valgrind (~20x overhead), ASan is fast enough for integration tests. Combine with UBSan (`-fsanitize=undefined`) for maximum coverage.

---

### Q17. What is the small buffer optimization in `std::string`?

The Small Buffer Optimization (SBO, also called SSO, Small String Optimization) avoids heap allocation for short strings by storing the character data inline in the string object itself.

A typical implementation stores a discriminant and either:
- An inline buffer of 15-22 bytes (for short strings)
- A heap pointer, size, and capacity (for long strings)

```cpp
// sizeof(std::string) is typically 24-32 bytes on 64-bit
// Short strings (< ~15 chars) are stored IN those bytes, no heap allocation

std::string short_s = "hello";      // no malloc, stored inline
std::string long_s  = std::string(100, 'x');  // heap allocated

// You can detect (in practice, not portably) by checking address:
std::string s = "hi";
bool is_inline = reinterpret_cast<const char*>(&s) <= s.data() &&
                 s.data() < reinterpret_cast<const char*>(&s) + sizeof(s);
```

The implication: copying short strings is cheap (no heap allocation). Moving a short string may not be faster than copying it, the move cannot avoid the inline-data copy. This is why `noexcept` move for `std::string` can sometimes still copy. Understanding SBO is important for any code that processes many small strings in tight loops.

---

### Q18. What is `std::pmr::monotonic_buffer_resource`?

`std::pmr::monotonic_buffer_resource` is a PMR memory resource that allocates from a fixed buffer monotonically (bump-pointer style) and never frees individual allocations. When the buffer is exhausted, it falls back to an upstream resource (default: `new_delete_resource`).

```cpp
#include <memory_resource>
#include <vector>
#include <string>

void process_request(const std::string& body) {
    // 4 KB stack buffer for request-scoped allocations
    std::array<std::byte, 4096> stack_buf;
    std::pmr::monotonic_buffer_resource pool{stack_buf.data(), stack_buf.size(),
                                             std::pmr::null_memory_resource()};
    // null_memory_resource: throws bad_alloc instead of falling back to heap

    std::pmr::vector<std::pmr::string> tokens{&pool};
    // All tokens and their string data allocated from stack_buf
    // No heap allocation for the common case (small requests)
    // pool is destroyed at end of scope: all memory freed at once
}
```

This is the standard technique for zero-heap-allocation request processing in C++ servers. The Go equivalent would be a sync.Pool, but `monotonic_buffer_resource` is deterministic: the memory is statically pre-allocated, and there is no GC pressure at all.

---

### Q19. How does `jemalloc` differ from the default allocator?

The default system allocator (`ptmalloc2` on Linux glibc) is a general-purpose allocator with a single global lock in its early design, leading to contention in multi-threaded programs.

**`jemalloc`** uses:
1. **Thread-local caches (tcache)**: each thread has a cache of small object size classes. Allocation from the tcache is a single pointer increment, no lock.
2. **Size classes**: objects are bucketed into ~60 size classes (e.g., 8, 16, 32, 48, 64... bytes). Each size class has its own arena, eliminating coalescing overhead for same-size reuse.
3. **Multiple arenas**: configurable number of arenas (default: 4x CPU cores), each with its own lock, reducing contention by sharding.
4. **Transparent huge pages**: uses 2 MB huge pages for large allocations to reduce TLB pressure.

```bash
# Link jemalloc:
g++ -o myserver myserver.cpp -ljemalloc

# Or LD_PRELOAD without recompilation:
LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libjemalloc.so ./myserver
```

`jemalloc` is used by Meta's entire server infrastructure and by Firefox. `tcmalloc` (Google) is the alternative, it uses thread-local free lists with a central cache for cross-thread reclamation. Both are 2-5x faster than glibc `malloc` in multi-threaded workloads.

---

### Q20. What is move semantics? When does the compiler generate a move constructor?

**Move semantics** allow an object to "steal" the resources of a temporary (rvalue) rather than copying them. A move constructor takes an rvalue reference to the source, transfers ownership of heap data (by moving the pointer, not copying bytes), and leaves the source in a valid empty state.

```cpp
class Buffer {
    int* data_;
    size_t size_;
public:
    Buffer(Buffer&& other) noexcept
        : data_(other.data_), size_(other.size_) {
        other.data_ = nullptr;   // source is now empty but valid
        other.size_ = 0;
    }
};
```

**When the compiler auto-generates a move constructor:**
The compiler generates a defaulted move constructor if:
- No user-declared copy constructor
- No user-declared copy assignment operator
- No user-declared move assignment operator
- No user-declared destructor

If you declare a destructor (even `= default`), the compiler will NOT generate a move constructor, this is the "Rule of Five" trigger. The auto-generated move constructor does memberwise move.

```cpp
struct Good {
    std::vector<int> data;    // no user declarations: move ctor auto-generated
    std::string      name;    // both members have move ctors, delegated
};

struct Bad {
    int* raw_ptr;
    ~Bad() { delete raw_ptr; }  // user destructor: NO auto-generated move ctor!
    // Without explicit move ctor, moves fall back to copies
};
```

---
