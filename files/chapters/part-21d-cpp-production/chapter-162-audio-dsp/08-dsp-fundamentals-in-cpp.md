## DSP Fundamentals in C++

This is where the audio actually changes. Everything before was about meeting deadlines and routing samples. This section is about modifying samples in mathematically meaningful ways. The senior audio engineer can implement these from memory.

### Sample-by-Sample Versus Block Processing

Two processing styles, both common, often combined:

**Sample-by-sample.** A function takes one input sample, returns one output. Filters with feedback (IIR), envelopes, and any state machine that depends on the previous sample's output naturally fit this style.

```cpp
class OnePoleLowpass {
    float state_ = 0.0f;
    float a_ = 0.0f; // smoothing coefficient
public:
    void setCutoff(float fc, float fs) noexcept {
        // One-pole IIR: y[n] = a*x[n] + (1-a)*y[n-1]
        float omega = 2.0f * 3.14159265f * fc / fs;
        a_ = 1.0f - std::exp(-omega);
    }
    float process(float x) noexcept {
        state_ += a_ * (x - state_);
        return state_;
    }
};
```

**Block processing.** A function takes an input pointer and length, writes to an output pointer. Convolution, FFT, vectorized gain, and anything that benefits from SIMD belong here.

```cpp
inline void applyGain(float* buffer, int n, float gain) noexcept {
    for (int i = 0; i < n; ++i) buffer[i] *= gain;
}
```

Combine the two styles: the outer loop iterates samples, hot inner work is vectorized over the block, state-bearing filters are sample-by-sample.

### FIR Filters

A finite impulse response filter convolves the input with a fixed coefficient set:

`y[n] = sum over k of h[k] * x[n - k]`

Properties:

- Always stable (no feedback path).
- Linear phase achievable (symmetric coefficients).
- Computational cost grows with filter length.

Implementation with a circular buffer for state:

```cpp
template <int Length>
class FirFilter {
    std::array<float, Length> coeffs_{};
    std::array<float, Length> state_{};
    int writeIndex_ = 0;

public:
    void setCoefficients(const float* h) noexcept {
        std::copy(h, h + Length, coeffs_.begin());
    }
    float process(float x) noexcept {
        state_[writeIndex_] = x;
        float y = 0.0f;
        int idx = writeIndex_;
        for (int k = 0; k < Length; ++k) {
            y += coeffs_[k] * state_[idx];
            idx = (idx == 0) ? Length - 1 : idx - 1;
        }
        writeIndex_ = (writeIndex_ + 1) % Length;
        return y;
    }
};
```

For long FIRs (> 64 taps) the per-sample loop becomes the bottleneck, and partitioned FFT convolution becomes faster (covered in the FFT chapter).

### IIR Filters

Infinite impulse response filters use feedback. Order-2 IIRs (biquads) are the workhorse of audio:

`y[n] = b0*x[n] + b1*x[n-1] + b2*x[n-2] - a1*y[n-1] - a2*y[n-2]`

Properties:

- Compact (only 2 multiply-accumulates of state plus 3 of input per sample for biquad).
- Can be unstable if poles fall outside the unit circle.
- Phase is non-linear.

The biquad has multiple equivalent topologies, each with different numerical properties:

#### Direct Form I

The textbook form. Two state variables for input history, two for output history. Easiest to derive, worst numerically (sensitive to coefficient quantization).

#### Direct Form II

Combines the two state pairs into one. Less memory. Slightly worse numerical behavior at low frequencies.

#### Transposed Direct Form II

The recommended form for audio. Best numerical behavior, especially at low frequencies and with single-precision float.

```cpp
class Biquad {
    float b0_ = 1.0f, b1_ = 0.0f, b2_ = 0.0f;
    float a1_ = 0.0f, a2_ = 0.0f;
    float z1_ = 0.0f, z2_ = 0.0f; // state

public:
    void setCoefficients(float b0, float b1, float b2, float a1, float a2) noexcept {
        b0_ = b0; b1_ = b1; b2_ = b2; a1_ = a1; a2_ = a2;
    }

    void reset() noexcept { z1_ = z2_ = 0.0f; }

    // Transposed Direct Form II
    float process(float x) noexcept {
        float y = b0_ * x + z1_;
        z1_ = b1_ * x - a1_ * y + z2_;
        z2_ = b2_ * x - a2_ * y;
        return y;
    }
};
```

### RBJ Cookbook Coefficients

Robert Bristow-Johnson's "Audio EQ Cookbook" gives the canonical biquad coefficient formulas for every standard filter type. Senior engineers can derive these in their sleep.

```cpp
struct BiquadCoeffs { float b0, b1, b2, a1, a2; };

inline BiquadCoeffs lowpass(float fc, float Q, float fs) noexcept {
    float omega = 2.0f * 3.14159265f * fc / fs;
    float sn = std::sin(omega), cs = std::cos(omega);
    float alpha = sn / (2.0f * Q);
    float a0 = 1.0f + alpha;
    BiquadCoeffs c;
    c.b0 = (1.0f - cs) * 0.5f / a0;
    c.b1 = (1.0f - cs)        / a0;
    c.b2 = (1.0f - cs) * 0.5f / a0;
    c.a1 = -2.0f * cs / a0;
    c.a2 = (1.0f - alpha) / a0;
    return c;
}

inline BiquadCoeffs highpass(float fc, float Q, float fs) noexcept {
    float omega = 2.0f * 3.14159265f * fc / fs;
    float sn = std::sin(omega), cs = std::cos(omega);
    float alpha = sn / (2.0f * Q);
    float a0 = 1.0f + alpha;
    BiquadCoeffs c;
    c.b0 =  (1.0f + cs) * 0.5f / a0;
    c.b1 = -(1.0f + cs)        / a0;
    c.b2 =  (1.0f + cs) * 0.5f / a0;
    c.a1 = -2.0f * cs / a0;
    c.a2 = (1.0f - alpha) / a0;
    return c;
}

inline BiquadCoeffs peaking(float fc, float Q, float gainDb, float fs) noexcept {
    float A = std::pow(10.0f, gainDb / 40.0f);
    float omega = 2.0f * 3.14159265f * fc / fs;
    float sn = std::sin(omega), cs = std::cos(omega);
    float alpha = sn / (2.0f * Q);
    float a0 = 1.0f + alpha / A;
    BiquadCoeffs c;
    c.b0 = (1.0f + alpha * A) / a0;
    c.b1 = -2.0f * cs         / a0;
    c.b2 = (1.0f - alpha * A) / a0;
    c.a1 = -2.0f * cs         / a0;
    c.a2 = (1.0f - alpha / A) / a0;
    return c;
}
```

A 5-band parametric EQ is five biquads in series, each configured with one of these formulas. A high-pass crossover for a speaker is a chain of two highpass biquads (Linkwitz-Riley 4th order, two cascaded Butterworth Q=0.707).

### Cascading Biquads for Higher-Order Filters

A 4th-order filter is two biquads in series. An 8th-order filter is four. The senior choice is to never write a single 8th-order direct-form filter (numerical disaster) but always cascade biquads:

```cpp
template <int NumStages>
class BiquadCascade {
    std::array<Biquad, NumStages> stages_;
public:
    float process(float x) noexcept {
        for (auto& s : stages_) x = s.process(x);
        return x;
    }
    void reset() noexcept { for (auto& s : stages_) s.reset(); }
    Biquad& operator[](int i) noexcept { return stages_[i]; }
};
```

### State-Variable Filters

The Chamberlin SVF and the Andrew Simper "Trapezoidal SVF" are alternative topologies that produce LP, BP, HP, and notch from the same state, useful for synth filters with morphing response.

```cpp
class Svf {
    float ic1eq_ = 0.0f, ic2eq_ = 0.0f;
    float g_ = 0.0f, k_ = 0.0f, a1_ = 0.0f, a2_ = 0.0f, a3_ = 0.0f;
public:
    void set(float fc, float Q, float fs) noexcept {
        g_ = std::tan(3.14159265f * fc / fs);
        k_ = 1.0f / Q;
        a1_ = 1.0f / (1.0f + g_ * (g_ + k_));
        a2_ = g_ * a1_;
        a3_ = g_ * a2_;
    }
    struct Out { float lp, bp, hp; };
    Out process(float x) noexcept {
        float v3 = x - ic2eq_;
        float v1 = a1_ * ic1eq_ + a2_ * v3;
        float v2 = ic2eq_ + a2_ * ic1eq_ + a3_ * v3;
        ic1eq_ = 2.0f * v1 - ic1eq_;
        ic2eq_ = 2.0f * v2 - ic2eq_;
        return { v2, v1, x - k_ * v1 - v2 };
    }
};
```

The Simper SVF is the canonical synth filter for any virtual analog, and is what most modern softsynths use for their resonant low-pass filter.

### Denormal Handling

When a filter's input goes silent, its state decays exponentially. Single-precision floats become denormal when the magnitude drops below `2^-126 ~= 1.18e-38`. On x86 without DAZ/FTZ, denormal arithmetic is 100x slower than normal arithmetic, and a stuck denormal in a busy mix kills the audio thread.

The fixes:

1. **Set DAZ and FTZ** in `MXCSR` at the start of every audio callback (covered in section 3).
2. **Inject DC offset** below the audible threshold so state never reaches denormal range. A common trick is adding `1e-25f` to one input sample per block.
3. **Flush small states explicitly:**

```cpp
inline float flushDenormal(float x) noexcept {
    return std::fabs(x) < 1e-25f ? 0.0f : x;
}
```

For a senior engineer in a code review, "the filter goes denormal" is one of the first things you check when a plugin causes CPU spikes after a section of silence in a track.

### Block-Wise Processing of Biquads

A biquad has only state from one sample to the next, so per-sample processing is unavoidable for the recursion. But the per-sample function should inline so the compiler can vectorize parallel biquads (e.g., one biquad per channel processed in parallel via SIMD over the channel dimension).

For longer chains, JUCE's `juce::dsp::IIR::Filter<float>` plus `juce::dsp::ProcessorChain` lets you compose filters and let the compiler vectorize where possible.

---
