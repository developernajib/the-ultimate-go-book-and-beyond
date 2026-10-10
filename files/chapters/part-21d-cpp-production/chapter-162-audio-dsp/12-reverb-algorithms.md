## Reverb Algorithms

Reverb is the single largest category of audio plugin sales by unit and dollar volume. Every mix has at least one. Every DAW ships at least one. Every game audio middleware includes one. The senior engineer should know the algorithm families from Schroeder through FDN through convolution, and be able to choose the right one for a product.

### Schroeder Reverb (1962)

Manfred Schroeder's original algorithm, published at Bell Labs, is the foundational structure: parallel comb filters in series with allpass filters. The combs build up density, the allpasses smear the time response without coloring the magnitude.

```cpp
class CombFilter {
    std::vector<float> buffer_;
    int writeIndex_ = 0;
    float feedback_ = 0.7f;
    float damping_ = 0.2f;
    float lpState_ = 0.0f;
public:
    void resize(int delaySamples) { buffer_.assign(delaySamples, 0.0f); }
    float process(float x) noexcept {
        float y = buffer_[writeIndex_];
        lpState_ = y * (1.0f - damping_) + lpState_ * damping_;
        buffer_[writeIndex_] = x + lpState_ * feedback_;
        if (++writeIndex_ >= static_cast<int>(buffer_.size())) writeIndex_ = 0;
        return y;
    }
};

class AllpassFilter {
    std::vector<float> buffer_;
    int writeIndex_ = 0;
    float feedback_ = 0.5f;
public:
    void resize(int delaySamples) { buffer_.assign(delaySamples, 0.0f); }
    float process(float x) noexcept {
        float bufout = buffer_[writeIndex_];
        float y = -x + bufout;
        buffer_[writeIndex_] = x + bufout * feedback_;
        if (++writeIndex_ >= static_cast<int>(buffer_.size())) writeIndex_ = 0;
        return y;
    }
};

class SchroederReverb {
    std::array<CombFilter, 4> combs_;
    std::array<AllpassFilter, 2> allpasses_;
public:
    void prepare(double sampleRate) {
        // Magic delay lengths in samples, mutually prime to avoid resonance.
        constexpr int combDelays[4] = { 1557, 1617, 1491, 1422 };
        constexpr int apDelays[2]   = { 225, 556 };
        for (int i = 0; i < 4; ++i) combs_[i].resize(combDelays[i]);
        for (int i = 0; i < 2; ++i) allpasses_[i].resize(apDelays[i]);
    }
    float process(float x) noexcept {
        float y = 0.0f;
        for (auto& c : combs_) y += c.process(x);
        y *= 0.25f;
        for (auto& a : allpasses_) y = a.process(y);
        return y;
    }
};
```

Schroeder is the simplest algorithm that still sounds like a reverb. It works but it has audible "metallic" coloration because four parallel combs are not enough to decorrelate the response. Modern implementations use 8 to 12 combs and chained allpasses.

### Freeverb (Jezar 2000)

Freeverb (Jezar at Dreampoint, public domain code from 2000) is the single most-copied reverb algorithm in history. It is in nearly every open-source audio project, embedded in JUCE as `juce::Reverb`, ported to LV2, VST, and MaxMSP. The core is 8 parallel lowpass-feedback combs into 4 series allpasses, with stereo decorrelation via slightly different delay lengths between channels.

Freeverb sounds OK at small sizes (small room, plate). At long decays it betrays the comb structure with audible flutter. As a building block, it is everywhere because the source is free, the algorithm is simple, and the CPU is low.

### Feedback Delay Network (FDN)

The FDN, developed by Jot and Chaigne in the 1990s, replaced parallel combs with a matrix-mixed network of delays. N delay lines with different lengths, their outputs multiplied by an N x N feedback matrix, summed back into the inputs:

```
x[n] -> [delay_1, delay_2, ..., delay_N]
output  =  delays out
feedback = Q * (delays out)   where Q is N x N orthogonal
new input = x[n] + damping * feedback
```

The matrix Q must be lossless (norm-preserving) for stable yet high-density output. Hadamard and Householder matrices are the standard choices because they have +/-1 entries (cheap multiplications) and they are orthogonal.

```cpp
template <int N>
class FdnReverb {
    static_assert((N & (N - 1)) == 0, "N must be power of 2 for Hadamard");
    std::array<std::vector<float>, N> delays_;
    std::array<int, N> writeIdx_{};
    std::array<int, N> delayLengths_;
    std::array<float, N> dampStates_{};
    float damping_ = 0.3f;
    float feedbackGain_ = 0.85f;

    void hadamard(std::array<float, N>& v) noexcept {
        // In-place Hadamard transform (Sylvester construction).
        for (int len = 1; len < N; len *= 2) {
            for (int i = 0; i < N; i += 2 * len) {
                for (int j = 0; j < len; ++j) {
                    float a = v[i + j];
                    float b = v[i + j + len];
                    v[i + j]       = a + b;
                    v[i + j + len] = a - b;
                }
            }
        }
        const float norm = 1.0f / std::sqrt(static_cast<float>(N));
        for (auto& x : v) x *= norm;
    }

public:
    void prepare(double sampleRate) {
        // Mutually prime delay lengths in samples, around 30-150ms range.
        const int seed[] = { 1487, 1801, 2089, 2297, 2503, 2741, 3001, 3217 };
        for (int i = 0; i < N; ++i) {
            delayLengths_[i] = seed[i % 8];
            delays_[i].assign(delayLengths_[i], 0.0f);
        }
    }

    float process(float x) noexcept {
        std::array<float, N> tap;
        for (int i = 0; i < N; ++i) tap[i] = delays_[i][writeIdx_[i]];

        // Damping: one-pole lowpass per channel.
        for (int i = 0; i < N; ++i) {
            dampStates_[i] += damping_ * (tap[i] - dampStates_[i]);
            tap[i] = dampStates_[i];
        }

        std::array<float, N> mixed = tap;
        hadamard(mixed);

        for (int i = 0; i < N; ++i) {
            delays_[i][writeIdx_[i]] = x + feedbackGain_ * mixed[i];
            writeIdx_[i] = (writeIdx_[i] + 1) % delayLengths_[i];
        }

        float out = 0.0f;
        for (int i = 0; i < N; ++i) out += tap[i];
        return out / static_cast<float>(N);
    }
};
```

An 8x or 16x FDN with mutually prime delay lengths produces a dense, smooth reverb tail with much less coloration than parallel combs. This is the foundation of most modern algorithmic reverbs (Valhalla VintageVerb, Lexicon's classic algorithms, Eventide UltraReverb, Native Instruments Raum).

### Convolution Reverb

A convolution reverb plays back an actual impulse response from a real space (church, hall, plate echo) or from a synthetic source. The signal path is the partitioned convolution from the FFT chapter.

Tradeoffs versus FDN:

- **Convolution:** Sounds like the actual space. No tweakable parameters beyond size scale, predelay, and EQ. Large CPU and memory.
- **FDN:** Sounds like a parametric model. Time and frequency response controllable in real time. Low CPU.

Modern hybrid plugins (Liquidsonics Cinematic Rooms, Fabfilter Pro-R 2) use a small convolution for the early reflections (the "fingerprint" of the space) and an FDN for the late tail (smooth and tweakable).

### Plate and Spring Reverbs

A physical plate reverb (the EMT 140) uses a steel plate suspended on springs with transducers at multiple positions. The metallic, dense sound is unique. Algorithmic emulations use:

- An FDN tuned for dense, fast buildup.
- A specific frequency response with a midrange bump and high-frequency rolloff.
- Modulation of the delay lengths to produce the characteristic shimmer.

UAD's EMT 140 plugin and Valhalla Plate are reference plate emulations.

A spring reverb (Fender Twin, Hammond Leslie cabinets) has a dispersive transmission line, modeled as an allpass chain with frequency-dependent delay (chirp). UAD's AKG BX 20 and IK Multimedia Spring Box are reference spring emulations.

### Modal Reverb

Modal synthesis decomposes a space into a sum of decaying sinusoidal modes. Each mode is a 2nd-order resonator. For small spaces (tight rooms, small instruments) modal models are accurate and lightweight. For large halls the mode count needed is too high to be efficient.

Used in physical modeling synthesis (string and drum bodies) more than in standalone reverb plugins.

### Reverb Quality Markers

When evaluating a reverb in code review:

1. **No metallic ringing.** Sustained sine inputs should not produce audible flutter.
2. **Smooth decay.** The energy envelope should be exponential, not stepped.
3. **Dense buildup.** The transition from early reflections to late tail should not have audible holes.
4. **Stable at extreme settings.** Decay times of 10s+ should not produce instability.
5. **No DC drift.** Long pads should not develop a DC offset that pumps the meters.
6. **Stereo width without phase issues.** Mono compatibility check (sum L+R, listen for cancellations).

### Production Reverbs to Study

Open-source reverbs with readable C++ source:

- **Freeverb** (the original Jezar). Public domain.
- **JUCE `juce::Reverb`** which is a Freeverb derivative.
- **Faust DSP examples** (the Grame project), which include several FDN designs.
- **Mverb** by Martin Eastwood, MIT-licensed FDN with damping.

Commercial reverbs to listen to and reverse-engineer mentally:

- **Valhalla VintageVerb** (Sean Costello). Pure-algorithm, FDN-based, stunningly good.
- **Liquidsonics Cinematic Rooms.** Hybrid convolution and algorithmic.
- **Universal Audio Lexicon 224.** Convolution + algorithmic reproduction of the original 1978 hardware.
- **Eventide UltraReverb.** Combines all reverb families behind one UI.

---
