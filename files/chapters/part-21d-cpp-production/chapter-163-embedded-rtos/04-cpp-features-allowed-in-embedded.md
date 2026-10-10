## C++ Features Allowed in Embedded

Modern C++ has more features than any embedded program can afford. The job of a senior firmware engineer is to know which features pay for themselves on a 64 KB part and which features quietly burn flash, RAM, or determinism. The following is the working subset that ships in production at Apple, Tesla, NVIDIA, and the major automotive Tier 1s.

### Allowed Without Reservation

**`constexpr` and `consteval`.** Compile-time evaluation costs nothing at runtime. Every CRC table, sine lookup, baud rate divisor, and pin mapping should be `constexpr`. C++20 `consteval` forces evaluation at compile time and is preferable for anything that must not leak into the runtime image.

```cpp
constexpr std::uint16_t crc16_ccitt(std::span<const std::uint8_t> data) {
    std::uint16_t crc = 0xFFFF;
    for (auto b : data) {
        crc ^= static_cast<std::uint16_t>(b) << 8;
        for (int i = 0; i < 8; ++i) {
            crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
        }
    }
    return crc;
}

constexpr auto firmware_crc = crc16_ccitt(firmware_bytes);
```

**Templates.** Instantiated templates produce only the code paths the application uses. A `Register<0x40020000, uint32_t>` template is the same machine code as the equivalent C macro, with type safety. AUTOSAR C++14 explicitly allows templates.

**`std::array`.** Fixed-size, no allocation, identical layout to a C array, and adds `.size()`, iterators, and bounds checking with `at()` if you want it. There is no reason to use a raw C array in modern embedded C++.

**`std::span`.** Pointer plus length, no ownership, no allocation. The right way to pass a buffer to a driver function. Replaces the old "pointer plus separate size_t" idiom that constantly produced off-by-one bugs.

**`std::optional` and `std::variant`.** Both are stack-allocated. `optional<T>` is `T` plus a discriminator byte. `variant<T1,T2,...>` is the largest member plus a discriminator. Useful for protocol parsers that may or may not produce a value. Avoid `std::variant` in code paths where the dispatch overhead matters, the dispatch is a switch on the active type, which is fine for warm code but visible in hard real-time loops.

**RAII.** Constructors and destructors are the entire point of C++ on bare metal. Guard objects, lock guards, peripheral acquisition, and DMA transfer scopes all become safer.

**Concepts (C++20).** Concepts replace SFINAE and produce vastly better error messages. They cost nothing at runtime.

### Allowed With Care

**Inheritance and virtual functions.** A virtual call is a load of the vtable pointer, a load of the method pointer, and an indirect branch. On a Cortex-M4 that is roughly 4 cycles plus a likely cache miss. In a 100 kHz control loop you cannot afford it. In a UI task running at 50 Hz it is fine. The rule is to use `virtual` deliberately, not by default. CRTP is the alternative when you want polymorphic interfaces with zero runtime cost.

**`std::function`.** It type-erases callables, which is convenient. The implementation typically has a small-buffer optimization for callables up to 16 or 24 bytes, anything larger triggers a heap allocation. In an embedded build with no heap, this is a runtime crash waiting to happen. The replacement is a fixed-capacity callable wrapper like `etl::delegate` or a templated callback that does not type-erase.

**`std::string`.** Allocates on the heap unless the small-string optimization (SSO) covers the string. SSO is typically 15 or 22 bytes. Strings longer than that allocate. In a no-heap build, `std::string` cannot be used at all. The replacement is `etl::string<N>` or a fixed `std::array<char, N>` with manual length tracking.

**Function-local statics.** The compiler inserts a guard variable and a lock to make initialization thread-safe. On a single-threaded MCU this is wasted code. Pass `-fno-threadsafe-statics` to GCC to suppress it. With that flag, function-local statics are fine.

### Banned in Most Production Builds

**Exceptions.** The unwind tables alone are 20 to 40 KB on Cortex-M for a non-trivial program. Throwing an exception walks the call stack inspecting unwind info, calling destructors, and possibly allocating on the heap to construct the exception object. The latency is unpredictable, which is fatal in real-time code. Standard practice in automotive, aerospace, and most IoT shops is `-fno-exceptions`. Error handling is done with return codes, `std::expected` (C++23), or `std::optional`.

**RTTI.** The `dynamic_cast` operator and the `typeid` operator both require runtime type information embedded in every polymorphic class. The cost is one pointer per virtual class plus type-info string tables. AUTOSAR C++14 rule A5-2-1 forbids `dynamic_cast`. Standard practice is `-fno-rtti`.

**`std::vector` and other heap containers.** `std::vector` allocates on construction, reallocates on growth, and the worst-case latency of `push_back` is unbounded. In hard real-time and no-heap builds, `std::vector` is replaced by `std::array`, `etl::vector<T,N>`, or a custom static-storage container. Some shops allow `std::vector` only at init time before the heap is locked.

**`std::shared_ptr`.** The reference count is atomic, which is fine, but the control block is heap-allocated. Banned in no-heap builds. Replaced by raw pointers with documented ownership, `std::unique_ptr` with a custom deleter, or intrusive reference counting.

**`std::iostream`.** Pulls in roughly 80 KB of code on a typical Cortex-M build. Replaced by `printf` from picolibc or a custom `format` that writes to a fixed buffer.

**`std::regex`.** Heap-heavy and slow. Never used in embedded.

**Multiple inheritance with virtual base classes.** The vtable layout is complicated, the offsets to virtual bases are runtime computed, and AUTOSAR C++14 forbids it (rule A10-1-1).

**`new` and `delete` after init.** Standard practice is to allocate any required dynamic objects during boot, then either lock the heap or override `operator new` to call `abort` for any subsequent allocation. This is enforced at runtime to catch the rare case where a library does an allocation behind your back.

```cpp
// Catch any post-init heap allocation
namespace {
    bool g_heap_locked = false;
}
extern "C" void lock_heap() { g_heap_locked = true; }

void* operator new(std::size_t n) {
    if (g_heap_locked) {
        // Hard fault deliberately
        asm volatile("bkpt #0");
        for (;;) {}
    }
    void* p = std::malloc(n);
    if (!p) { asm volatile("bkpt #0"); for (;;) {} }
    return p;
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
```

### Concrete Trade-Off Examples

**Polymorphic sensor driver.** A naive design has an `ISensor` base class with a virtual `read()` method. On a Cortex-M4 reading at 1 kHz, the vtable indirect branch costs roughly 4 cycles per call, or 4000 cycles per second, which is 0.005 percent of a 80 MHz core. Use virtual.

A naive design has `ISensor` with a virtual `read()` called from a 50 kHz control loop. Now you are spending 200,000 cycles per second on dispatch, which is 0.25 percent of the core. Still fine. But the cache cost of the indirect branch is what hurts: the branch target buffer cannot predict it, and on Cortex-M7 a mispredicted indirect branch costs 8 to 12 cycles. Now you are at 1 percent overhead. Use CRTP instead.

**`std::function` in an event dispatcher.** A UI task has 20 button handlers stored in a vector of `std::function<void()>`. Each handler is a lambda capturing 8 bytes of context. SSO covers it, no heap allocation. Use it.

The same UI task adds support for runtime-loadable plugin handlers that capture a 64-byte plugin context. Now `std::function` allocates. Either move to a fixed callable type with a static buffer (`etl::delegate`) or budget the heap.

### The Working Subset for a Typical Cortex-M Build

A reasonable starting point for a senior team's coding standard:

```
- C++20 language, C++17 library minimum
- -fno-exceptions -fno-rtti -fno-threadsafe-statics
- No new/delete after boot (enforced by overriding operator new)
- No std::vector, std::string, std::shared_ptr, std::function, std::regex, std::iostream
- No multiple inheritance with virtual bases
- constexpr/consteval encouraged for any computation that can be done at compile time
- Templates encouraged but watch for code bloat (instantiate with PODs not large objects)
- virtual allowed, but document the dispatch frequency in comments
- RAII required for all hardware peripherals, locks, DMA channels, and scopes
- std::array, std::span, std::optional, std::variant, std::bit_cast, std::byte, std::endian: encouraged
```

This subset is close to what AUTOSAR C++14 codifies and very close to what Apple, NVIDIA, and the major Tier 1s actually run.

---
