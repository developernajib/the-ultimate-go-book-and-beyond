## Synthesis Techniques

A synthesizer generates sound from algorithms rather than playing back recorded samples. The categories below cover almost every commercial softsynth on the market. Senior audio engineers can implement at least the first three from scratch.

### Subtractive Synthesis

The Moog model. Start with a harmonically rich source (saw, square, pulse, noise), filter it, shape it with an envelope. Subtractive is the dominant synthesis paradigm in popular music.

```cpp
class SubtractiveVoice {
    Oscillator osc_;          // saw, square, pulse, etc.
    Svf filter_;              // resonant low-pass
    AdsrEnvelope ampEnv_;
    AdsrEnvelope filterEnv_;
    float currentNote_ = -1.0f;

public:
    void noteOn(int note, float velocity, double sampleRate) noexcept {
        currentNote_ = static_cast<float>(note);
        osc_.setFrequency(midiToHz(note), sampleRate);
        ampEnv_.gate(true);
        filterEnv_.gate(true);
    }
    void noteOff() noexcept {
        ampEnv_.gate(false);
        filterEnv_.gate(false);
    }
    float process(float cutoffMod, float resonance, double sampleRate) noexcept {
        float raw = osc_.tick();
        float fEnv = filterEnv_.tick();
        float cutoff = std::clamp(cutoffMod * fEnv, 20.0f, 20000.0f);
        filter_.set(cutoff, resonance, sampleRate);
        float filtered = filter_.process(raw).lp;
        return filtered * ampEnv_.tick();
    }
    bool isActive() const noexcept { return ampEnv_.isActive(); }
};
```

Antialiased oscillators are essential. A naive saw wave has infinite harmonics and aliases catastrophically. The standard solutions:

- **BLEP** (Band-Limited Step) corrections. Fast, sounds clean.
- **PolyBLEP** (a polynomial approximation of BLEP). Good balance.
- **Wavetable** with prepared band-limited tables per octave. Most flexible.

```cpp
inline float polyBlep(float t, float dt) noexcept {
    if (t < dt) {
        t = t / dt;
        return t + t - t * t - 1.0f;
    } else if (t > 1.0f - dt) {
        t = (t - 1.0f) / dt;
        return t * t + t + t + 1.0f;
    }
    return 0.0f;
}

class PolyBlepSaw {
    float phase_ = 0.0f, dt_ = 0.0f;
public:
    void setFrequency(float hz, float sr) noexcept { dt_ = hz / sr; }
    float tick() noexcept {
        float v = 2.0f * phase_ - 1.0f;
        v -= polyBlep(phase_, dt_);
        phase_ += dt_;
        if (phase_ >= 1.0f) phase_ -= 1.0f;
        return v;
    }
};
```

Reference implementations: Yamaha Reface CS, Arturia synths, Native Instruments Massive X.

### FM Synthesis

Frequency modulation, popularized by John Chowning and shipped to the world in the Yamaha DX7 (1983). One oscillator's frequency modulates another's. With multiple operators arranged in a graph (the DX7 algorithms), you can produce metallic bells, electric pianos, basses, and bright leads with very few parameters.

```cpp
class FmOperator {
    float phase_ = 0.0f;
    float increment_ = 0.0f;
public:
    void setFrequency(float hz, float sr) noexcept { increment_ = hz / sr; }
    float tick(float modulationInput) noexcept {
        float v = std::sin(2.0f * 3.14159265f * (phase_ + modulationInput));
        phase_ += increment_;
        if (phase_ >= 1.0f) phase_ -= 1.0f;
        return v;
    }
};

class FmAlgorithm6Op {
    std::array<FmOperator, 6> ops_;
    std::array<float, 6> levels_{};
    std::array<float, 6> ratios_{};
public:
    // DX7 algorithm 1: op6 -> op5 -> op4 -> op3 -> op2 -> op1, op1 is output.
    float process() noexcept {
        float m6 = ops_[5].tick(0.0f) * levels_[5];
        float m5 = ops_[4].tick(m6) * levels_[4];
        float m4 = ops_[3].tick(m5) * levels_[3];
        float m3 = ops_[2].tick(m4) * levels_[2];
        float m2 = ops_[1].tick(m3) * levels_[1];
        return ops_[0].tick(m2) * levels_[0];
    }
};
```

The DX7 used 6 operators with 32 hardwired algorithms (graph topologies). Each operator has its own envelope. Sounds are described by frequency ratios (carrier 1:1, modulator 1.41:1 for a bell, etc.) and envelope shapes.

Modern FM synths (Native Instruments FM8, Arturia DX7 V, Korg opsix) extend the DX7 with more operators, additional algorithms, and operator waveform variations.

### Wavetable Synthesis

Wavetable stores a table of single-cycle waveforms and interpolates between them. A "wavetable" in product terminology is a sequence of waveforms that morph from one to the next. Serum (Xfer Records) is the dominant commercial wavetable synth as of 2026.

```cpp
class Wavetable {
    std::vector<std::vector<float>> tables_; // one table per octave for antialiasing
    int tableLength_ = 2048;
public:
    float tick(float phase, float frequencyHz, float sampleRate) noexcept {
        // Pick the table that does not alias for this frequency.
        int tableIdx = pickBandLimitedTable(frequencyHz, sampleRate);
        const auto& t = tables_[tableIdx];
        float p = phase * tableLength_;
        int   i0 = static_cast<int>(p);
        float frac = p - i0;
        int   i1 = (i0 + 1) % tableLength_;
        return t[i0] + frac * (t[i1] - t[i0]);
    }
};
```

For wavetable morphing, store a 2D table (frame, sample) and interpolate in both dimensions:

```cpp
float morphTick(float phase, float morphPos, float freqHz, float sr) noexcept {
    int frame0 = static_cast<int>(morphPos * (numFrames_ - 1));
    float frac = morphPos * (numFrames_ - 1) - frame0;
    int frame1 = std::min(frame0 + 1, numFrames_ - 1);
    float a = sampleAt(frame0, phase, freqHz, sr);
    float b = sampleAt(frame1, phase, freqHz, sr);
    return a + frac * (b - a);
}
```

Antialiasing requires a band-limited version of each frame at each octave. Vital (the open-source competitor to Serum) is a good reference codebase.

### Granular Synthesis

Granular synthesizes long sounds from short grains (5-200ms) of recorded or generated audio, with control over grain rate, position, pitch, density, and panning.

```cpp
struct Grain {
    int startSample, lengthSamples, currentSample;
    float pitchRatio, gain, pan;
    bool active;
};

class GranularEngine {
    std::vector<float> source_;
    std::array<Grain, 64> grains_;
    int nextGrainIdx_ = 0;
    float density_ = 50.0f; // grains per second

public:
    void process(float* outL, float* outR, int n, float sr) noexcept {
        for (int i = 0; i < n; ++i) {
            // Trigger new grains based on density.
            // Sum active grains into output, with windowing.
        }
    }
};
```

Used as a creative effect (Ableton's Granulator, Output Portal, Quanta) and in Cycling '74 Max patches. Less common as a primary synthesis paradigm in pop music.

### Additive Synthesis

Sum many sine partials with independent amplitudes and frequencies. Theoretically can produce any sound. In practice the parameter count is enormous (one envelope per partial) and most additive synths use spectral analysis to extract partial trajectories from sample input.

Camel Audio Alchemy (now Apple Alchemy in Logic), Image-Line Harmor, and Native Instruments Razor are the main commercial additive synths.

For real-time work, additive needs SIMD: process 4 or 8 sines per AVX register, sum at the end. Group partials into frequency bands and use FFT for high partial counts.

### Physical Modeling

Physical models simulate the actual physics of an instrument. The classic and computationally cheap example is Karplus-Strong for plucked string:

```cpp
class KarplusStrong {
    std::vector<float> delay_;
    int writeIdx_ = 0;
    float damping_ = 0.498f; // < 0.5 for stable decay
    float lpState_ = 0.0f;

public:
    void noteOn(float freqHz, float sr) noexcept {
        int len = static_cast<int>(sr / freqHz);
        delay_.assign(len, 0.0f);
        // Excite with white noise burst.
        for (auto& s : delay_) s = (rand() / float(RAND_MAX)) * 2.0f - 1.0f;
    }
    float tick() noexcept {
        float y = delay_[writeIdx_];
        // One-sample lowpass for damping (string loss).
        float filtered = (y + lpState_) * damping_;
        lpState_ = y;
        delay_[writeIdx_] = filtered;
        if (++writeIdx_ >= static_cast<int>(delay_.size())) writeIdx_ = 0;
        return y;
    }
};
```

For richer string models, **digital waveguides** (Julius Smith, CCRMA, 1980s+) split the string into a bidirectional pair of delay lines representing right- and left-traveling waves. Combine with reflection filters at the bridge and nut for realistic plucked, bowed, or struck behavior.

Pianoteq (Modartt) is the most acclaimed commercial physical modeling product. AAS (Applied Acoustics Systems) has a full physical modeling suite. Roli's Equator started as physical modeling for Seaboard.

For wind instruments, **two-mass models** (vocal tract, brass) and **Karplus-Strong with all-pass tuning** (woodwind body) are the standard approaches.

### Voice Allocation

A polyphonic synth needs to handle more notes than it has voices. Voice stealing strategies:

1. **Oldest first.** Steal the voice that has been playing longest.
2. **Quietest first.** Steal the voice with the lowest amplitude envelope value.
3. **Lowest priority.** Each note has a priority (e.g., release-stage notes < held notes), steal the lowest.

```cpp
class VoiceAllocator {
    std::array<SubtractiveVoice, 16> voices_;

public:
    void noteOn(int note, float velocity, double sr) noexcept {
        // First, look for an inactive voice.
        for (auto& v : voices_) {
            if (!v.isActive()) { v.noteOn(note, velocity, sr); return; }
        }
        // No free voice. Steal the quietest.
        float minLevel = 1e9f;
        SubtractiveVoice* victim = nullptr;
        for (auto& v : voices_) {
            float level = v.currentLevel();
            if (level < minLevel) { minLevel = level; victim = &v; }
        }
        if (victim) victim->noteOn(note, velocity, sr);
    }
};
```

JUCE's `juce::Synthesiser` and `juce::SynthesiserVoice` provide a battle-tested voice allocator and a clean polymorphic voice base class.

---
