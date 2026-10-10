## No-Heap Programming

The first rule of embedded programming is the same as the first rule of Fight Club, except engineers actually talk about it. **Do not use the heap.** No `malloc`, no `new`, no `std::vector` that resizes, no `std::string` that holds dynamic data. The constraint is not a performance optimization, it is a correctness requirement.

### Why the Heap Is Banned

`malloc` on a general-purpose allocator does four things that are unacceptable in hard real-time code:

**Non-deterministic latency.** The allocator maintains free lists of varying sizes. Finding a suitable block may require traversing a long chain. The time taken depends on fragmentation state that accumulated over the entire runtime of the system. You cannot bound it at design time.

**Fragmentation failure.** After hours of mixed allocation/deallocation, a system with 50 KB free may be unable to satisfy a 1 KB request because no contiguous 1 KB block exists. On a server, this triggers an OOM condition that the OS handles. On a microcontroller with no MMU and no OS, the allocator returns `nullptr` or enters an infinite loop inside `__sbrk`.

**Silent failure.** Embedded C runtimes often implement `malloc` by calling `sbrk()` which moves a heap break pointer. When RAM is exhausted, `sbrk` returns `(void*)-1`. If the caller does not check the return value of `malloc`, and legacy embedded code often does not, the program writes through a null-ish pointer and corrupts memory elsewhere. The corruption manifests somewhere completely unrelated, possibly hours later.

**Size unknown at design time.** Embedded systems have fixed RAM budgets, 32 KB, 64 KB, 256 KB. Safety certification requires proof that the system can never run out of memory. A heap that grows dynamically makes this proof impossible without exhaustive runtime testing.

```cpp
// Detect accidental heap use: override operator new to abort
// Place this in a dedicated translation unit for the embedded target.
#include <cstddef>
#include <cstdlib>

void* operator new(std::size_t) {
    // In a production system, log the fault address via DWT/ITM then halt.
    std::abort();
}

void* operator new[](std::size_t) {
    std::abort();
}

void operator delete(void*) noexcept   { std::abort(); }
void operator delete[](void*) noexcept { std::abort(); }
```

With this override in place, any code path that reaches `new` will abort immediately, making accidental heap use visible during development rather than causing corruption in the field.

### Static Allocation Patterns

**Static arrays** are the baseline. A `static` local or file-scope array is placed in `.bss` or `.data` by the linker, occupying a fixed address for the entire program lifetime. Size is known at link time, verified by the linker.

```cpp
// File-scope static buffer -- placed in .bss, zeroed at startup
static uint8_t uart_rx_buffer[256];
static uint8_t uart_tx_buffer[256];

// Stack allocation for small, short-lived objects
void process_packet(const uint8_t* raw, size_t len) {
    uint8_t decoded[128];  // Stack -- gone when function returns
    decode(raw, len, decoded);
    // ...
}
```

**`std::array<T, N>`** is a zero-overhead wrapper around a C array. It provides bounds-checked `at()`, iterators, and `size()` without any heap involvement. On embedded targets with `-Os` and LTO it compiles identically to a raw array.

```cpp
#include <array>
#include <cstdint>

// Compile-time fixed-size sensor sample ring
std::array<uint16_t, 64> adc_samples{};
size_t sample_head = 0;

void record_sample(uint16_t val) {
    adc_samples[sample_head % adc_samples.size()] = val;
    ++sample_head;
}
```

**Object pools** pre-allocate a fixed number of objects at startup and hand out slots rather than performing allocations. A slot is either in-use or free, tracked with a bitmask.

```cpp
template<typename T, size_t N>
class ObjectPool {
    alignas(T) uint8_t storage_[N * sizeof(T)];
    bool in_use_[N]{};

public:
    T* acquire() {
        for (size_t i = 0; i < N; ++i) {
            if (!in_use_[i]) {
                in_use_[i] = true;
                return new (&storage_[i * sizeof(T)]) T{};
            }
        }
        return nullptr;  // Pool exhausted -- caller must handle
    }

    void release(T* obj) {
        for (size_t i = 0; i < N; ++i) {
            T* slot = reinterpret_cast<T*>(&storage_[i * sizeof(T)]);
            if (slot == obj) {
                obj->~T();
                in_use_[i] = false;
                return;
            }
        }
    }
};

// Pre-allocate 8 CAN message objects at program start
static ObjectPool<CanMessage, 8> can_pool;
```

### Placement New for In-Place Construction

When you need to construct an object in a pre-allocated region, placement new constructs it without calling any allocator. The memory is yours. The constructor runs in place.

```cpp
#include <cstdint>
#include <new>

struct Motor {
    uint8_t  id;
    uint16_t max_rpm;
    explicit Motor(uint8_t i, uint16_t r) : id(i), max_rpm(r) {}
    ~Motor() = default;
};

// Static storage, aligned to Motor's alignment requirement
alignas(Motor) static uint8_t motor_storage[sizeof(Motor)];

// Construct in-place -- no heap involved
Motor* motor = new (motor_storage) Motor(1, 3000);

// Explicit destruction when done (if needed)
void shutdown_motor() {
    motor->~Motor();
}
```

The `alignas` is critical. If `motor_storage` is misaligned for `Motor`, the placement new produces undefined behavior, a hard fault on ARM Cortex-M when accessing misaligned 32-bit registers.

### The Embedded Template Library

The ETL (Embedded Template Library, `etl.cplusplus.com`) provides STL-compatible containers with compile-time fixed capacities. It is the practical solution for embedded code that needs associative containers and queues without a heap.

```cpp
#include "etl/vector.h"
#include "etl/map.h"
#include "etl/queue.h"

// Vector with compile-time max capacity of 16
etl::vector<uint32_t, 16> fault_codes;
fault_codes.push_back(0x0042);  // Never allocates heap memory

// Map with max 8 entries -- stored as sorted array internally
etl::map<uint8_t, uint16_t, 8> sensor_calibration;
sensor_calibration[0x01] = 1024;

// Fixed-capacity FIFO queue for ISR → main thread communication
etl::queue<SensorReading, 32> reading_queue;
```

When `push_back` exceeds capacity, ETL returns an error or triggers an assertion, it never silently overflows or reallocates. The compile-time capacity makes static analysis and linker size verification straightforward.

### Stack Usage Analysis

Even with no heap, the stack can overflow. Each function call frame consumes stack space, and on Cortex-M without an MMU, a stack overflow silently corrupts adjacent variables or the interrupt vector table.

```
# GCC generates per-function stack usage files
arm-none-eabi-g++ -fstack-usage -Os -c motor.cpp

# Output: motor.cpp.su
# motor.cpp:42:5:Motor::update     96      static
# motor.cpp:67:5:Motor::calibrate  240     dynamic   <-- recursion or VLA
```

The `static` annotation means the maximum stack usage for that function is bounded and known. `dynamic` means it depends on runtime conditions, a warning sign in embedded code. Tools like `avstack` and `cppcheck --check-library` aggregate `.su` files to compute total call-chain stack depth.

**The rule of thumb:** on a Cortex-M3/M4, reserve at least 512 bytes per interrupt level beyond the main stack, and 1-2 KB for the main stack in simple bare-metal systems. Complex RTOS tasks with deep call chains need per-task stack sizing.

### Go Comparison

In Go, most non-trivial values escape to the heap. The compiler's escape analysis is sophisticated, but interfaces, closures, and values whose addresses are taken commonly end up heap-allocated. This is acceptable because Go has a garbage collector. In embedded C++, there is no collector, and the heap may not exist at all. The Go analogy is `sync.Pool`, a fixed set of pre-allocated objects reused across goroutines, which mirrors the object pool pattern above. The difference is that `sync.Pool` is optional optimization in Go. In embedded C++, it is the only option from the start.

---
