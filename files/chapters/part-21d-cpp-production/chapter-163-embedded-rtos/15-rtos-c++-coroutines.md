## RTOS C++ Coroutines

C++20 coroutines are a tantalizing fit for embedded code. An async I/O operation expressed as a coroutine reads like sequential code but compiles to a state machine that yields control without blocking the underlying thread. On an MCU, that maps cleanly onto event-driven firmware. The challenge is that the standard library coroutine support assumes a heap, which is forbidden in most embedded builds. A senior engineer can work around it.

### How C++20 Coroutines Work

A coroutine is a function that can suspend and resume. The C++ compiler transforms a function with `co_await`, `co_yield`, or `co_return` into a state machine. The state machine and its captured variables live in a "coroutine frame," which is allocated on first call. Standard semantics: the frame is heap-allocated via `operator new`.

```cpp
#include <coroutine>

struct Task {
    struct promise_type {
        Task get_return_object() { return {}; }
        std::suspend_never initial_suspend() { return {}; }
        std::suspend_never final_suspend() noexcept { return {}; }
        void return_void() {}
        void unhandled_exception() {}
    };
};

struct DelayAwaiter {
    std::uint32_t ms;
    bool await_ready() { return false; }
    void await_suspend(std::coroutine_handle<> h) {
        schedule_resume(h, ms);
    }
    void await_resume() {}
};

DelayAwaiter delay(std::uint32_t ms) { return {ms}; }

Task blink_task() {
    while (true) {
        led.toggle();
        co_await delay(500);
    }
}
```

Reading top-down, `blink_task` looks like a periodic loop. The compiler turns it into a state machine where each `co_await` saves the resumption point, returns to the scheduler, and resumes at the saved point when the awaiter signals readiness.

### The Heap Problem

By default, the coroutine frame for `blink_task` is allocated with `operator new`. In an embedded build with `-fno-exceptions` and a locked heap, this is a runtime crash on the first call.

The standard provides three escape hatches.

**Custom `operator new` per promise type.** The compiler looks up `operator new` first as a member of the promise type, falling back to global. Override it to allocate from a static pool.

```cpp
struct promise_type {
    static constexpr std::size_t kPoolSize = 8 * 1024;
    static std::array<std::byte, kPoolSize> pool;
    static std::size_t offset;

    void* operator new(std::size_t n) {
        std::size_t aligned = (offset + 7) & ~std::size_t{7};
        if (aligned + n > kPoolSize) return nullptr;
        offset = aligned + n;
        return pool.data() + aligned;
    }
    void operator delete(void*, std::size_t) noexcept {
        // Pool, no individual free
    }
    // ... rest of promise
};

std::array<std::byte, promise_type::kPoolSize> promise_type::pool;
std::size_t promise_type::offset = 0;
```

This works for never-ending tasks where the frame lives forever. It does not work for finite tasks that should free their frames.

**`get_return_object_on_allocation_failure`.** If this static member exists on the promise type, the compiler uses `nothrow new` and calls this on failure. Useful when the heap exists but may be full.

**`-fno-coroutine-allocation` (compiler-specific).** Some compilers can elide the heap allocation when the coroutine's lifetime is bounded by its caller. The frame goes on the caller's stack. This is the "Halo Optimization" referred to in the Lewis Baker articles. As of 2026, Clang implements it more reliably than GCC.

### A Custom Promise for FreeRTOS

The most useful pattern in embedded is a promise type that integrates with the RTOS scheduler. A coroutine yields control by suspending, the awaiter registers a wakeup with the RTOS, the RTOS resumes the coroutine when ready.

```cpp
struct RtosTask {
    struct promise_type {
        TaskHandle_t pending_resume_ = nullptr;

        // Static-pool allocation
        static constexpr std::size_t kFrameSize = 256;
        alignas(8) static std::array<std::byte, 4 * kFrameSize> pool;
        static std::uint32_t pool_used;

        void* operator new(std::size_t n) {
            if (pool_used + n > pool.size()) return nullptr;
            void* p = pool.data() + pool_used;
            pool_used += (n + 7) & ~std::size_t{7};
            return p;
        }
        void operator delete(void*, std::size_t) noexcept {}

        RtosTask get_return_object() {
            return RtosTask{std::coroutine_handle<promise_type>::from_promise(*this)};
        }
        std::suspend_always initial_suspend() noexcept { return {}; }
        std::suspend_always final_suspend() noexcept { return {}; }
        void return_void() {}
        void unhandled_exception() { std::terminate(); }
    };

    std::coroutine_handle<promise_type> handle;
    void resume() { if (!handle.done()) handle.resume(); }
    ~RtosTask() { if (handle) handle.destroy(); }
};

alignas(8) std::array<std::byte, 4 * RtosTask::promise_type::kFrameSize>
    RtosTask::promise_type::pool;
std::uint32_t RtosTask::promise_type::pool_used = 0;
```

A queue-receive awaiter:

```cpp
template <typename T>
struct QueueAwaiter {
    QueueHandle_t q;
    T value;

    bool await_ready() {
        return xQueueReceive(q, &value, 0) == pdTRUE;
    }
    void await_suspend(std::coroutine_handle<> h) {
        // Register a callback that resumes h when queue has data.
        register_queue_waiter(q, [h]() mutable { h.resume(); });
    }
    T await_resume() { return value; }
};

RtosTask consumer_coroutine(QueueHandle_t q) {
    while (true) {
        SensorReading r = co_await QueueAwaiter<SensorReading>{q};
        process(r);
    }
}
```

The `consumer_coroutine` reads sequentially even though it yields the CPU on every queue receive. The compiler generates a state machine that reduces to roughly the same machine code as a hand-written FreeRTOS task with `xQueueReceive(q, &r, portMAX_DELAY)`, with the addition of an indirect call through the resume function pointer.

### Saving Stack on Context Switch

A traditional FreeRTOS task with a 2 KB stack consumes 2 KB of SRAM whether the task is active or not. A coroutine, by contrast, consumes only the size of its frame, which is typically 64 to 256 bytes. A firmware with 50 logical "tasks" expressed as coroutines all running on a single FreeRTOS task can fit in 16 KB of frame storage instead of 100 KB of stack storage.

The savings are real on small parts. A Nordic nRF52810 with 24 KB of SRAM cannot afford 50 FreeRTOS tasks. It can afford 50 coroutines.

The cost is that all coroutines share one stack at runtime. A single coroutine that recurses deeply, or that calls a library function with a large local array, blows the shared stack. Standard practice is to use coroutines for the bookkeeping logic and reserve the shared stack for the leaf functions.

### Coroutines for State Machines

A common embedded pattern is the state machine: a USB device negotiating enumeration, a Bluetooth controller pairing, a TCP connection going through SYN/SYN-ACK/ACK. The traditional implementation is a giant switch statement on the current state. Coroutines turn the same logic into linear code.

```cpp
RtosTask usb_enumeration() {
    co_await usb_reset_complete();
    set_address(my_address);
    co_await ack_received();
    co_await get_device_descriptor();
    co_await set_configuration();
    log_info("USB enumeration complete");
}
```

The same logic with a switch statement is roughly 80 lines and notoriously hard to extend without breaking. The coroutine version is 6 lines that read like the protocol spec.

### Caveats

Coroutines are not a free lunch. The state machine the compiler generates is correct but not always optimal. The size of a coroutine frame depends on the compiler's analysis of which locals must persist across suspension points. A poorly written coroutine with many large locals can have a 1 KB frame, defeating the savings.

Compiler debugging support for coroutines is still maturing. GDB and LLDB can step through coroutines in 2026, but the experience is rougher than for ordinary functions. A misbehaving coroutine often surfaces as a wild jump to a destroyed frame, with no clue where it went wrong.

Static analyzers also struggle. Polyspace and LDRA have basic coroutine support but cannot reason about coroutine lifetime as well as they can about ordinary functions.

For these reasons, coroutines in embedded C++ are still an emerging pattern in 2026 rather than a default choice. Some shops use them aggressively (modern Nordic SDK examples, some Espressif IDF code, some research codebases). Most production firmware still uses traditional task-and-queue designs. If you adopt coroutines, do it deliberately, measure the frame sizes, and review the generated state machines on the parts that matter.

---
