## The Real-Time Audio Rules

The audio thread is sacred. This is not a metaphor. The OS scheduler runs your audio callback at the highest real-time priority on the system, ahead of the kernel's own house-keeping in some cases, with a hard deadline measured in microseconds. Anything you do on this thread that can take an unbounded amount of time is a bug, and the bug manifests as an audible glitch that the user will hear and never unhear.

The canonical reference is Ross Bencina's 2009 essay "Time Waits for Nothing", which is required reading for every audio C++ engineer. Pete Goodliffe's `Audio Developer Conference` talks codify the same rules. This chapter is the working summary that every senior audio engineer carries in their head.

### The Deadline

At sample rate `Fs` and buffer size `B`, you have `B / Fs` seconds of wall-clock time per callback. Some examples to anchor this:

- 48kHz, 64 samples = 1.333ms
- 48kHz, 128 samples = 2.667ms
- 48kHz, 256 samples = 5.333ms
- 48kHz, 512 samples = 10.667ms
- 96kHz, 64 samples = 0.667ms

A modern Pro Tools session on macOS routinely runs at 64-sample buffers. Live performance with monitoring through plugins runs at 32 or even 16 samples (0.333ms at 48kHz). Inside that window, you must produce output. You also share that window with the OS, the driver, every other audio plugin in the session, and any system interrupt that fires.

The practical CPU budget per plugin in a 50-track mix at 256 samples and 48kHz is on the order of tens of microseconds. Not milliseconds. Microseconds.

### The Forbidden List

The following operations are forbidden on the audio thread because their latency is unbounded:

#### 1. Memory Allocation

`malloc`, `new`, `free`, `delete`, anything that touches the heap. The general-purpose allocator can take milliseconds when it has to grow the heap, page in memory, or contend on a global lock. This includes:

- `std::vector::push_back` past capacity
- `std::string` mutation that grows
- `std::function` constructed from a lambda that captures by value beyond the small-object buffer
- `std::shared_ptr` construction (allocates the control block)
- `std::make_unique`
- `std::map::insert`, `std::unordered_map::insert`
- Any container resize or rehash

```cpp
// WRONG. Heap allocation in the audio thread.
void processBlock(juce::AudioBuffer<float>& buf) {
    std::vector<float> temp(buf.getNumSamples()); // bad
    // ...
}

// RIGHT. Pre-allocated in prepareToPlay, sized to maxBlockSize.
class MyProcessor {
    std::vector<float> temp;
public:
    void prepareToPlay(double sr, int maxBlockSize) {
        temp.resize(maxBlockSize); // sized once
    }
    void processBlock(juce::AudioBuffer<float>& buf) {
        std::fill(temp.begin(), temp.begin() + buf.getNumSamples(), 0.0f);
        // ...
    }
};
```

#### 2. Locks That Can Block

`std::mutex::lock`, `std::shared_mutex::lock`, `std::condition_variable::wait`, `std::lock_guard` over a contended mutex. If the GUI thread holds the lock and gets preempted, the audio thread blocks behind it indefinitely. This is called priority inversion, and on systems without priority inheritance (most user-space mutex implementations) it is unbounded.

`std::mutex::try_lock` is acceptable because it returns immediately. But you have to handle the failure case correctly (skip the operation, fall back to a stale value, do not retry).

```cpp
// WRONG.
std::mutex parameterMutex;
float currentGain = 1.0f;
void processBlock(juce::AudioBuffer<float>& buf) {
    std::lock_guard<std::mutex> lock(parameterMutex); // can block
    buf.applyGain(currentGain);
}

// RIGHT. Atomic float, no lock at all.
std::atomic<float> currentGain{1.0f};
void processBlock(juce::AudioBuffer<float>& buf) {
    float g = currentGain.load(std::memory_order_relaxed);
    buf.applyGain(g);
}
```

#### 3. Syscalls

Anything that crosses the user-kernel boundary has unpredictable latency. This includes:

- File I/O (`std::fstream`, `read`, `write`, `fopen`)
- Network I/O (`send`, `recv`, `connect`)
- Logging that writes to a file or socket (`std::cout`, `printf`, `fprintf`, most `spdlog` sinks)
- `std::this_thread::sleep_for`
- Any console output
- Memory mapping changes (`mmap`, `munmap`, `VirtualAlloc`, `VirtualFree`)
- Time queries are usually fine but `clock_gettime(CLOCK_MONOTONIC)` is `vDSO`-fast on Linux. `std::chrono::system_clock::now()` may or may not be a syscall depending on platform.

If you need to log from the audio thread, use a lock-free SPSC ring buffer to push log records to a non-realtime thread that does the actual write.

#### 4. Unbounded Loops

Every loop in the audio callback must have a known upper bound at compile time or set in `prepareToPlay`. A `while (queue.has_more())` that processes an unknown number of items is a deadline miss waiting to happen.

```cpp
// WRONG. Unbounded.
void processBlock() {
    while (eventQueue.try_dequeue(event)) {
        processEvent(event);
    }
}

// RIGHT. Bounded to a sane maximum per block.
constexpr int kMaxEventsPerBlock = 64;
void processBlock() {
    int processed = 0;
    Event event;
    while (processed < kMaxEventsPerBlock && eventQueue.try_dequeue(event)) {
        processEvent(event);
        ++processed;
    }
    // If more events remain, they will be picked up next block.
}
```

#### 5. Exceptions

`throw` walks the stack and unwinds destructors. The unwind path is not bounded in time. C++ exception handling is implemented with table-driven unwinding that can touch cold pages and trigger faults. The audio thread should be `noexcept` from the callback entry down. Wrap any third-party code that might throw in a `try / catch` at the audio-thread boundary.

```cpp
extern "C" void audio_render_callback(/* ... */) noexcept {
    try {
        instance->process();
    } catch (...) {
        // Swallow. Output silence rather than propagate.
        // Optionally signal the GUI thread via an atomic flag.
    }
}
```

#### 6. Virtual Dispatch in Hot Inner Loops

Virtual functions are not forbidden, but a virtual call inside a per-sample loop costs a load through the vtable and inhibits inlining. Lift the dispatch out of the loop:

```cpp
// SLOW. Virtual call per sample.
for (int i = 0; i < n; ++i) {
    out[i] = filter->process(in[i]);
}

// FASTER. Dispatch once, process the block.
filter->processBlock(in, out, n);

// FASTEST. Templates or CRTP.
template<typename Filter>
void processWithFilter(Filter& f, const float* in, float* out, int n) {
    for (int i = 0; i < n; ++i) out[i] = f.process(in[i]);
}
```

#### 7. Denormal Floats

When filter state decays toward zero, IEEE denormal numbers appear. On most x86 CPUs, denormal arithmetic is two orders of magnitude slower than normal arithmetic and will spike the audio thread's CPU. Set DAZ (denormals are zero) and FTZ (flush to zero) in the MXCSR register at the start of every audio callback on x86, and the FZ bit on ARM.

```cpp
#if defined(__SSE2__)
#include <xmmintrin.h>
#include <pmmintrin.h>
struct ScopedNoDenormals {
    unsigned int saved;
    ScopedNoDenormals() noexcept {
        saved = _mm_getcsr();
        _mm_setcsr(saved | 0x8040); // FTZ + DAZ
    }
    ~ScopedNoDenormals() noexcept { _mm_setcsr(saved); }
};
#endif
```

JUCE provides `juce::ScopedNoDenormals` which does this portably.

### What You Can Do

The audio thread is allowed to:

- Read from atomic variables.
- Write to atomic variables.
- Call functions that the compiler inlines and that contain no forbidden operations.
- Use `std::atomic::compare_exchange_weak` in a bounded retry loop.
- Use `try_lock` and skip the work on failure.
- Use SIMD intrinsics, fused multiply-add, branch-free arithmetic.
- Call into pre-loaded shared libraries (loading them is forbidden, calling them after the linker has bound the symbols is fine).

### Pre-Allocate, Pre-Touch, Pre-Bind

Three operations lift work off the audio thread:

**Pre-allocate.** All memory needed for the worst-case block is allocated in the constructor or in `prepareToPlay`. The host tells you the maximum block size when it calls `prepareToPlay`. Use it.

**Pre-touch.** Allocated memory is not necessarily resident in physical RAM. The first write to a freshly allocated page faults the OS to map a physical page, which can cost milliseconds. Touch every page (write a zero to every 4KB) at construction time so the audio thread never page-faults.

```cpp
inline void prefault_pages(void* ptr, size_t bytes) noexcept {
    constexpr size_t kPageSize = 4096;
    char* p = static_cast<char*>(ptr);
    for (size_t i = 0; i < bytes; i += kPageSize) {
        p[i] = 0;
    }
}
```

**Pre-bind.** If you `dlopen` a library, the first call to a symbol in it may trigger lazy binding through the PLT. Either bind eagerly (`RTLD_NOW`) or call every symbol once on a non-realtime thread before the audio callback ever runs.

### Real-Time Auditing Tools

**Apple's libcompiler-rt has a Realtime Sanitizer (RTSan).** Released in 2024, RTSan is a compile-time and runtime tool that detects calls to non-realtime-safe functions inside functions you mark `[[clang::nonblocking]]`. Mark your audio callback with that attribute and RTSan will trap on `malloc`, `mutex` lock, syscalls, etc. This is the modern equivalent of `RTAudit`.

**Real-Time Audio Watchdog** (Andrew Wang) and **realtime-audio-tracking** are older tools that achieve similar goals via LD_PRELOAD interception of forbidden functions.

In production, run your test suite under RTSan and treat any trap as a P0 bug.

### The Sacred Rule, Restated

Every line of code in the audio callback either runs in bounded time or it is a bug. Hold this in your head while you read every other section of this chapter.

---
