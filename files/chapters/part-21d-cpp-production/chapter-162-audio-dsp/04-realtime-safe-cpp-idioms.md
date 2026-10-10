## Realtime-Safe C++ Idioms

Given the rules in the previous section, the C++ patterns that meet them form a small, well-defined toolkit. Every senior audio codebase uses essentially the same set of idioms. Learn them once and they apply across JUCE, iPlug2, libwebrtc, Wwise, FMOD, and every plugin you will ever write.

### The Lock-Free SPSC Ring Buffer

Single-producer, single-consumer ring buffers are the most-used realtime communication primitive in audio. The GUI thread pushes parameter changes, the audio thread pops them. The audio thread pushes log records, a non-realtime thread pops and writes them. The MIDI input thread pushes events, the audio thread pops them.

A correct SPSC ring buffer using only `std::atomic` and a fixed-size array:

```cpp
#include <atomic>
#include <cstddef>
#include <type_traits>

template <typename T, size_t Capacity>
class SpscRingBuffer {
    static_assert((Capacity & (Capacity - 1)) == 0,
                  "Capacity must be a power of 2");
    static_assert(std::is_trivially_copyable_v<T>,
                  "T must be trivially copyable for safe SPSC use");

    alignas(64) std::atomic<size_t> head_{0}; // producer writes
    alignas(64) std::atomic<size_t> tail_{0}; // consumer writes
    T data_[Capacity];

    static constexpr size_t mask_ = Capacity - 1;

public:
    // Producer side. Returns false if buffer is full.
    bool try_push(const T& item) noexcept {
        const size_t head = head_.load(std::memory_order_relaxed);
        const size_t next = (head + 1) & mask_;
        if (next == tail_.load(std::memory_order_acquire)) {
            return false; // full
        }
        data_[head] = item;
        head_.store(next, std::memory_order_release);
        return true;
    }

    // Consumer side. Returns false if buffer is empty.
    bool try_pop(T& out) noexcept {
        const size_t tail = tail_.load(std::memory_order_relaxed);
        if (tail == head_.load(std::memory_order_acquire)) {
            return false; // empty
        }
        out = data_[tail];
        tail_.store((tail + 1) & mask_, std::memory_order_release);
        return true;
    }

    bool empty() const noexcept {
        return head_.load(std::memory_order_acquire)
            == tail_.load(std::memory_order_acquire);
    }
};
```

Notes for code review:

- The `alignas(64)` separates `head_` and `tail_` onto different cache lines so the producer and consumer do not bounce a single cache line between cores.
- The `Capacity` must be a power of 2 so the wrap is a bitmask, not a modulo.
- The acquire on the read of the other index pairs with the release on the write. This is the classic acquire-release pattern, and it is sufficient for SPSC.
- `T` must be trivially copyable because the consumer reads `data_[tail]` while the producer might already be writing `data_[next]`. Anything with a destructor or non-trivial copy constructor needs a different design (typically an MPSC queue with a slot occupancy flag per element).
- The producer and consumer must each be a single thread. Two producers will corrupt the head index. Use `boost::lockfree::queue` or `moodycamel::ConcurrentQueue` for MPSC or MPMC.

### Atomic Parameters

Plugin parameters change from the GUI thread (or from the host's automation lane) and are read by the audio thread. The transport across thread boundaries is `std::atomic<float>`:

```cpp
struct Parameter {
    std::atomic<float> value{0.0f};
    std::atomic<float> target{0.0f};

    // Called from GUI or host automation thread.
    void set(float newValue) noexcept {
        target.store(newValue, std::memory_order_relaxed);
    }

    // Called from audio thread.
    float read() noexcept {
        return target.load(std::memory_order_relaxed);
    }
};
```

`std::memory_order_relaxed` is sufficient when the parameter is independent of other state. If a parameter change must be observed atomically with another (for example, filter coefficients computed together), wrap them in a single struct and use a sequence-counter pattern (a published atomic index that the audio thread reads, where each value of the index points at a separately-stored, immutable coefficient set computed by the GUI thread).

### Parameter Smoothing

A parameter that jumps from one value to another in one block produces a click. Smooth it with a one-pole filter or a linear ramp over the block:

```cpp
class SmoothedValue {
    float current_ = 0.0f;
    float target_ = 0.0f;
    int rampSamples_ = 0;
    int rampRemaining_ = 0;
    float increment_ = 0.0f;

public:
    void reset(double sampleRate, double rampMs) noexcept {
        rampSamples_ = static_cast<int>(rampMs * sampleRate / 1000.0);
    }
    void setTarget(float v) noexcept {
        target_ = v;
        increment_ = (target_ - current_) / static_cast<float>(rampSamples_);
        rampRemaining_ = rampSamples_;
    }
    float getNextValue() noexcept {
        if (rampRemaining_ <= 0) return target_;
        current_ += increment_;
        --rampRemaining_;
        return current_;
    }
};
```

JUCE provides `juce::SmoothedValue<float, ValueSmoothingTypes::Linear>` and `Multiplicative` (the latter for gain values where dB-linear smoothing sounds better).

### Lazy Init Outside the Audio Thread

Anything that needs to be initialized lazily (FFT plans, look-up tables, large coefficient sets) must be built on a non-realtime thread before the audio thread first touches it. A typical pattern:

```cpp
class FFTBackedReverb {
    std::unique_ptr<FFTPlan> plan_;
    std::atomic<bool> ready_{false};

public:
    // Called from a worker thread, possibly during plugin load.
    void prepareAsync(int blockSize) {
        plan_ = std::make_unique<FFTPlan>(blockSize);
        ready_.store(true, std::memory_order_release);
    }

    // Called from audio thread. Bypasses if not ready.
    void process(juce::AudioBuffer<float>& buf) noexcept {
        if (!ready_.load(std::memory_order_acquire)) return;
        plan_->execute(buf);
    }
};
```

JUCE's `prepareToPlay` is called on the message thread, not the audio thread, so it is the right place for any non-realtime init. AAX requires that you not allocate during `RenderAudio`, but `Initialize` is fair game.

### Memory Pools

When you need many small objects of the same type and you cannot allocate on the audio thread, a fixed-size pool sized at construction works:

```cpp
template <typename T, size_t N>
class FixedPool {
    alignas(T) std::byte storage_[N * sizeof(T)];
    std::array<bool, N> used_{};
public:
    template <typename... Args>
    T* allocate(Args&&... args) noexcept {
        for (size_t i = 0; i < N; ++i) {
            if (!used_[i]) {
                used_[i] = true;
                return new (storage_ + i * sizeof(T)) T(std::forward<Args>(args)...);
            }
        }
        return nullptr; // pool exhausted
    }
    void deallocate(T* ptr) noexcept {
        ptr->~T();
        size_t i = (reinterpret_cast<std::byte*>(ptr) - storage_) / sizeof(T);
        used_[i] = false;
    }
};
```

For voice allocation in a synth, this pattern allocates `MAX_VOICES` voice objects upfront and never touches the heap during `noteOn`. The linear scan over `used_` is fine for `N <= 64` or so. Larger pools use a free-list head index.

### Branch-Free Code in Inner Loops

Branch mispredictions cost cycles. In a per-sample loop running at 48000 iterations per second per channel, you cannot afford the wrong branch decisions. Replace branches with `std::min`, `std::max`, `std::clamp`, or `std::copysign`:

```cpp
// Hard-clip at +/- 1.0
inline float hardClip(float x) noexcept {
    return std::clamp(x, -1.0f, 1.0f);
}

// Soft saturation, branch-free
inline float softClip(float x) noexcept {
    float ax = std::fabs(x);
    return std::copysign(ax / (1.0f + ax), x);
}
```

Modern compilers will turn `std::clamp` into a pair of `minss` and `maxss` instructions on x86 with no branch.

### SIMD Where It Counts

Audio inner loops are the place where SIMD pays off most. Mix-down, gain stages, biquad chains, FIR filters, and FFT bins are all naturally vectorizable. Three approaches:

**Compiler auto-vectorization.** Write straightforward loops over `float*` with `restrict` (the compiler-specific keyword `__restrict__` on GCC/Clang, `__restrict` on MSVC) and let the compiler vectorize. Verify by examining the generated assembly with `-S` or `objdump -d`.

**Intrinsics.** SSE (`__m128`), AVX (`__m256`), AVX-512 (`__m512`), NEON (`float32x4_t`), or wrapper libraries like `xsimd`, `Highway`, or JUCE's `juce::dsp::SIMDRegister<float>`. Intrinsics give you exact control. They also lock you to an instruction set.

**Apple Accelerate / Intel IPP / vDSP.** Apple's `vDSP_vadd`, `vDSP_vmul`, `vDSP_dotpr`, and the FFT routines in `vDSP_fft_zrip` are all hand-tuned for the M-series chips. On Apple platforms, prefer Accelerate over hand-rolled intrinsics for any operation it covers.

```cpp
// Mix add: out += in * gain, AVX
#if defined(__AVX__)
#include <immintrin.h>
inline void mixAdd_avx(float* __restrict out,
                       const float* __restrict in,
                       float gain, int n) noexcept {
    __m256 g = _mm256_set1_ps(gain);
    int i = 0;
    for (; i + 8 <= n; i += 8) {
        __m256 o = _mm256_loadu_ps(out + i);
        __m256 a = _mm256_loadu_ps(in + i);
        o = _mm256_fmadd_ps(a, g, o);
        _mm256_storeu_ps(out + i, o);
    }
    for (; i < n; ++i) out[i] += in[i] * gain;
}
#endif
```

### The Idiom Summary

The realtime-safe C++ toolkit is small:

1. SPSC ring buffer for cross-thread messaging.
2. `std::atomic` for parameter passing.
3. Smoothed values to avoid clicks on parameter changes.
4. Pre-allocate everything in `prepareToPlay`.
5. Pre-touch pages so first-write does not fault.
6. Fixed-size pools for object allocation patterns.
7. Branch-free inner loops.
8. SIMD where the inner loop is hot enough to matter.
9. `try_lock` instead of `lock` if a lock must be involved.
10. Mark every audio-thread function `noexcept` and use `[[clang::nonblocking]]` so RTSan can audit it.

These ten patterns underpin every shipped audio C++ codebase. The rest is DSP.

---
