## Audio Fundamentals

Before any DSP code, the senior engineer needs the physical and numerical model in their head. Sound is a continuous pressure wave. Digital audio is a sequence of discrete samples of that wave. Every choice in an audio system flows from sample rate, bit depth, channel layout, and level conventions.

### Sampling and the Nyquist Limit

A continuous-time signal `x(t)` is sampled at rate `Fs` to produce `x[n] = x(n / Fs)`. The Nyquist-Shannon theorem says that a signal containing only frequencies below `Fs / 2` can be reconstructed exactly from its samples. Any frequency above `Fs / 2` aliases back into the audible band as a different frequency. This is why every ADC has an analog anti-alias filter before the sampler, and why every internal sample rate change in a DSP graph needs an anti-alias filter.

The audible range for healthy young ears is roughly 20Hz to 20kHz. The standard rates trace to this:

- **44.1 kHz**, the CD rate, chosen historically because it fit on adapted Sony U-matic video tapes and gives Nyquist at 22.05kHz with room for a realizable analog reconstruction filter.
- **48 kHz**, the broadcast and film rate, also the Apple AVAudioEngine and most game engines' default. This is the rate you should default to in 2026 unless you have a reason not to.
- **88.2 / 96 kHz**, used in tracking and mixing because oversampling reduces aliasing in non-linear processors (saturation, compression, distortion) and pushes any imperfect anti-alias filtering above the audible band.
- **176.4 / 192 kHz**, used in mastering and archival. The audible benefit is debated, the practical benefit is headroom for non-linear processing without internal oversampling.
- **384 kHz** and above, used in some DSD-derived workflows. Rare.

The 44.1 versus 48 split matters because integer sample-rate conversion (44100 to 48000 is a ratio of 147:160) is non-trivial and any DAW supporting both must do it right.

### Bit Depth and Dynamic Range

Each sample is stored at a finite bit depth. The dynamic range in dB of a uniformly quantized PCM signal is approximately `6.02 * N + 1.76` dB where N is the bit depth.

- **16-bit signed integer.** Range -32768 to 32767. Dynamic range about 96dB. This is the CD format and the consumer delivery format. Adequate for delivery, marginal for mixing.
- **24-bit signed integer.** Stored as 3 bytes or padded into a 32-bit container. Dynamic range about 144dB. The professional tracking and mixing format. Plenty of headroom.
- **32-bit float (IEEE 754 single).** Range exceeds any analog domain. The plugin internal format. Effectively unlimited dynamic range so long as you keep clipping under control. Float audio between -1.0 and +1.0 is the convention, but values outside that range are perfectly valid inside a DSP chain so long as the final output is brought back into range.
- **64-bit float (double).** Used for time accumulators (sample position, phase) and for very long FIR filters where coefficient precision matters. Rarely used for sample storage because the memory bandwidth doubles for inaudible benefit.

Inside any modern DSP graph, work in 32-bit float. Convert to and from 24-bit or 16-bit only at the I/O boundary.

```cpp
// Convert 16-bit signed PCM to float in [-1.0, 1.0]
inline float pcm16_to_float(int16_t sample) noexcept {
    return static_cast<float>(sample) / 32768.0f;
}

// Convert float [-1.0, 1.0] to 16-bit PCM with saturation
inline int16_t float_to_pcm16(float sample) noexcept {
    float scaled = sample * 32767.0f;
    if (scaled > 32767.0f) return 32767;
    if (scaled < -32768.0f) return -32768;
    return static_cast<int16_t>(scaled);
}

// 24-bit packed in 32-bit container, little-endian
inline float pcm24_to_float(int32_t sample_in_32bit_container) noexcept {
    // Sign-extend the 24-bit value sitting in the low 24 bits
    int32_t sign_extended = (sample_in_32bit_container << 8) >> 8;
    return static_cast<float>(sign_extended) / 8388608.0f; // 2^23
}
```

### Channel Layouts

The number and meaning of channels:

- **Mono** is one channel. Voice, single-mic capture, mid signals.
- **Stereo** is two channels, conventionally left then right interleaved or as separate planar buffers.
- **5.1** is six channels in the order L, R, C, LFE, Ls, Rs (the SMPTE order, used by Dolby and the broadcast world). Game engines and some Windows systems use a different order (L, R, C, LFE, BL, BR), and getting this wrong will reverse your surrounds.
- **7.1** adds rear surrounds (Lb, Rb).
- **Atmos bed and objects.** A Dolby Atmos master is a 7.1.2 or 7.1.4 bed plus up to 118 audio objects, each with positional metadata. The renderer at playback time turns objects into speaker feeds based on the actual speaker layout. For headphones, the renderer convolves with HRTFs.
- **Ambisonic.** B-format (4 channels: W, X, Y, Z) for first order, growing to 9, 16, 25 channels for higher orders. Used in VR and 360 video.

### Interleaved Versus Planar

Two memory layouts:

```cpp
// Interleaved stereo: L0 R0 L1 R1 L2 R2 ...
struct InterleavedFrame { float l; float r; };
InterleavedFrame buffer[bufferSize];

// Planar stereo: two separate arrays, L0 L1 L2 ... and R0 R1 R2 ...
float left[bufferSize];
float right[bufferSize];
float* planar[2] = { left, right };
```

Most plugin formats (VST3, AU, AAX, CLAP, JUCE's `AudioBuffer`) use planar internally because per-channel SIMD is faster on planar layouts. Most OS callbacks (CoreAudio's standard format, ASIO, AAudio) deliver interleaved. The deinterleave and reinterleave operations live at the I/O boundary.

```cpp
inline void deinterleave_stereo(const float* interleaved,
                                float* left, float* right,
                                int numFrames) noexcept {
    for (int i = 0; i < numFrames; ++i) {
        left[i]  = interleaved[2 * i];
        right[i] = interleaved[2 * i + 1];
    }
}
```

A vectorized version using SSE shuffles or NEON `vld2q_f32` is 4 to 8 times faster, and the JUCE source has examples for both architectures.

### The Decibel Scale

Audio engineers talk in decibels, not in linear amplitude. The conversion for amplitude:

```cpp
inline float linear_to_db(float linear) noexcept {
    return 20.0f * std::log10(std::max(linear, 1e-9f));
}

inline float db_to_linear(float db) noexcept {
    return std::pow(10.0f, db / 20.0f);
}
```

Two reference points to know cold:

- **0 dBFS** (decibels Full Scale) is the digital ceiling, linear amplitude 1.0. Going above 0 dBFS in an integer format clips. In float you can go above without clipping until the final output stage.
- **-18 dBFS** is the typical broadcast target reference level (linear amplitude about 0.126), giving 18dB of headroom above the average for transients.

LUFS (Loudness Units Full Scale, ITU-R BS.1770) is the modern integrated loudness measurement, used by streaming services for normalization (Spotify normalizes to -14 LUFS, Apple Music to -16 LUFS, broadcast to -23 LUFS in EBU R128 territories or -24 LUFS in ATSC A/85).

### Headroom, Crest Factor, Dynamic Range

**Headroom** is the dB margin between your operating level and the clipping ceiling. Mixing engineers leave 6 to 18dB of headroom on the master bus to give the mastering engineer room to work.

**Crest factor** is the ratio between peak and RMS of a signal. A sine wave has a crest factor of 3dB. Heavy metal mixed for loudness has a crest factor near 6dB. Classical music has a crest factor exceeding 20dB.

**Dynamic range** of the program is the difference between the loudest and quietest passages. Modern pop has perhaps 6dB. A symphony has 60dB or more. The medium imposes its own limit (about 96dB for 16-bit PCM, more for 24-bit).

### Sample Time Math

The single most useful formula in audio code:

```cpp
// Convert milliseconds to samples at a given rate
inline int ms_to_samples(double ms, double sampleRate) noexcept {
    return static_cast<int>(std::round(ms * sampleRate / 1000.0));
}

// Convert samples to milliseconds
inline double samples_to_ms(int samples, double sampleRate) noexcept {
    return static_cast<double>(samples) * 1000.0 / sampleRate;
}

// Convert frequency to angular frequency in radians per sample
inline double hz_to_rad_per_sample(double hz, double sampleRate) noexcept {
    return 2.0 * 3.14159265358979323846 * hz / sampleRate;
}
```

Internally, a sample position counter should be `int64_t` or `double`. A 32-bit int wraps after about 13.5 hours at 44.1kHz, and that bug has shipped in real products. A `float` loses sample-accurate precision after a few minutes. Use `double` or `int64_t` for time, `float` for samples.

### What This Means for Code

Three rules emerge:

1. **Internal float, edge integer.** All processing in 32-bit float. Conversion to and from 16/24-bit at the device boundary only.
2. **Planar internal, interleaved at the edge.** Plugin and DSP code in planar buffers. Deinterleave from the OS callback at the entrance, reinterleave at the exit.
3. **dB for UI, linear for math.** Display gain, volume, threshold, ratio, all in dB to the user. Convert to linear once when the parameter changes, cache the linear value, multiply with that.

These three patterns underlie every codebase from JUCE to libwebrtc.

---
