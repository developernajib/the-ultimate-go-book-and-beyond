## Pitch Shifting and Time Stretching

Changing pitch without changing duration, or duration without changing pitch, is one of the harder problems in audio DSP. The product everyone benchmarks against is Antares Auto-Tune for vocal pitch, Celemony Melodyne for surgical edits, and zplane Elastique for time stretch in DAWs. These represent decades of incremental engineering. The senior engineer needs to understand the family of algorithms, their tradeoffs, and where each lands on the latency-versus-quality curve.

### The Three Algorithm Families

Three families dominate:

1. **Time-domain (PSOLA, OLA, WSOLA)** for monophonic voice and speech.
2. **Frequency-domain (phase vocoder)** for polyphonic music.
3. **Granular** for creative effects and texture.

Each has variants and hybrids. Production-grade systems typically combine multiple approaches.

### OLA and SOLA

Overlap-add (OLA) cuts the input into windowed grains, repositions them at a new spacing (longer gap = stretch, shorter = compress), and crossfades. Naive OLA produces audible discontinuities because grain phases do not align.

Synchronous Overlap-Add (SOLA) and Waveform Similarity OLA (WSOLA) fix this by searching for the best alignment offset between successive grains using cross-correlation:

```cpp
class WsolaStretcher {
    int frameSize_;       // e.g. 1024
    int hopSize_;         // input hop
    int outHopSize_;      // output hop, larger for stretch
    int searchRange_;     // e.g. 64

    std::vector<float> hannWindow_;
    std::vector<float> outBuffer_;

public:
    void process(const float* in, int inLen, float* out, int& outLen) noexcept {
        int readPos = 0, writePos = 0;
        float prevTail[frameSize_]; // last frame for similarity search
        while (readPos + frameSize_ + searchRange_ < inLen) {
            // Search [-searchRange_, +searchRange_] around readPos for the
            // offset that maximizes cross-correlation with prevTail.
            int bestOffset = findBestOffset(prevTail, in + readPos, searchRange_);
            // Apply window, overlap-add into outBuffer_ at writePos.
            for (int i = 0; i < frameSize_; ++i) {
                outBuffer_[writePos + i] += hannWindow_[i] * in[readPos + bestOffset + i];
            }
            // Save tail for next search.
            std::copy(in + readPos + bestOffset + outHopSize_,
                      in + readPos + bestOffset + outHopSize_ + frameSize_,
                      prevTail);
            readPos  += hopSize_;
            writePos += outHopSize_;
        }
        outLen = writePos + frameSize_;
    }
};
```

WSOLA is the algorithm in many free time-stretchers (SoundTouch by Olli Parviainen) and is competitive for monophonic material. On polyphonic music it produces phasing artifacts that betray the cut points.

### PSOLA

Pitch-Synchronous Overlap-Add (Eric Moulines, 1990) is the canonical algorithm for vocal pitch shifting. It detects pitch periods, places one grain centered on each pitch period (the "epoch"), and overlap-adds them at a new spacing for time-stretch or with a new period length for pitch shift.

PSOLA needs accurate pitch detection. The pitch detector is the hard part. For a monophonic vocal it works extremely well, which is why Auto-Tune (a very heavily engineered PSOLA variant) is the industry standard for vocal correction.

For polyphonic music, PSOLA fails because there is no single pitch period.

### The Phase Vocoder

The phase vocoder (Flanagan 1966, Portnoff 1976, Laroche-Dolson 1999) operates in the frequency domain. The pipeline:

1. STFT the input with overlapping windowed FFT frames.
2. For each FFT bin, track the instantaneous frequency by computing the phase derivative across frames.
3. To stretch by ratio R, output frames at output hop H_out = R * H_in. For each output frame, advance the bin phases by `instantaneousFrequency * H_out`.
4. ISTFT and overlap-add.

```cpp
class PhaseVocoder {
    int fftSize_, hopIn_, hopOut_;
    std::vector<float> window_, inBuf_, outBuf_;
    std::vector<std::complex<float>> spectrum_;
    std::vector<float> lastPhase_;
    std::vector<float> sumPhase_;

public:
    void process(const float* in, float* out, int n) noexcept {
        // Windowed FFT into spectrum_.
        // For each bin k:
        //   float mag = std::abs(spectrum_[k]);
        //   float phase = std::arg(spectrum_[k]);
        //   float deltaPhase = phase - lastPhase_[k];
        //   lastPhase_[k] = phase;
        //   // Wrap to [-pi, pi] and convert to instantaneous frequency.
        //   float trueFreq = ...;
        //   sumPhase_[k] += trueFreq * hopOut_;
        //   spectrum_[k] = std::polar(mag, sumPhase_[k]);
        // IFFT, window, overlap-add into outBuf_.
    }
};
```

The vanilla phase vocoder produces phasiness ("the phase vocoder sound") because each bin's phase is advanced independently and harmonically related bins lose their phase relationships. **Phase locking** (Laroche-Dolson 1999) groups bins around spectral peaks and rotates them as a unit, dramatically improving transient preservation and naturalness.

Phase-locked phase vocoders are what Elastique, Rubber Band, and the time-stretch in Logic, Pro Tools, Ableton (Complex and Complex Pro modes) all use as their base. The differences are in transient detection, peak grouping, and the secondary processing for percussive material.

### Pitch Shift via Time Stretch + Resample

A time stretcher trivially becomes a pitch shifter: stretch by ratio R, then resample by ratio 1/R. The duration stays the same, the pitch changes by R. This is how almost all "pitch shift" effects in DAWs work.

For real-time use, the resampler must be fast and high-quality. SRC (Erik de Castro Lopo) and `libsamplerate` are the standard libraries. Apple's `AudioConverter` and the resampler in `AVAudioFormat` are also available on Apple platforms.

### Granular Synthesis

Granular methods operate on grains of arbitrary length (5 to 200ms typical), with arbitrary scattering, pitch, amplitude, and density. Used for textural effects more than transparent shifting:

- **Trash 2 / Quanta / Granulator II** are commercial granular synths.
- **PaulStretch** is the extreme time-stretch algorithm based on randomized phase per FFT bin (the opposite of phase locking), used for ambient and sound design.

Granular is creative more than corrective.

### Rubber Band Library

Rubber Band (Chris Cannam, 2008+, GPL with commercial license) is the open-source production-quality time and pitch processor. It implements phase-locked phase vocoder with adaptive transient handling. Commercial licenses are widely held by plugin developers for offline pitch and time work.

```cpp
#include <rubberband/RubberBandStretcher.h>

RubberBand::RubberBandStretcher stretcher(
    sampleRate, channels,
    RubberBand::RubberBandStretcher::OptionProcessRealTime
    | RubberBand::RubberBandStretcher::OptionEngineFiner);
stretcher.setTimeRatio(0.8);   // 0.8x duration (faster)
stretcher.setPitchScale(1.2);  // 1.2x pitch (higher)

float* inputBuffers[2] = { l, r };
stretcher.process(inputBuffers, framesIn, false);
int avail = stretcher.available();
float* outBuffers[2] = { ol, or };
stretcher.retrieve(outBuffers, framesOut);
```

Rubber Band's "R3" engine added in 2022 uses a different phase-locking scheme and is competitive with commercial Elastique for many materials.

### Elastique and Commercial Choices

zplane's Elastique is the de facto commercial time/pitch engine, licensed by Cubase, Studio One, FL Studio, and many smaller DAWs. Modes:

- **Elastique Pro v3** for music.
- **Elastique efficient** for low-CPU stems.
- **Elastique soloist** for monophonic with formant control.

Acon Digital's library and Dirac (formerly Stephan Bernsee) are alternatives with their own tradeoffs. None are open.

### Latency vs Quality

Real-time pitch shifters add latency proportional to the FFT frame size. A 4096-point FFT at 48kHz is 85ms latency, audible as a delay between input and output. For a vocal monitor in tracking, 85ms is unusable. For a printed bounce, no problem.

Real-time options:

- **Antares Auto-Tune Real-Time** uses ~2-5ms latency by aggressive frame sizes and PSOLA-like methods on monophonic vocals.
- **Waves Tune Real-Time** and **Melodyne Real-Time Direct Note Access** are similar.
- **Eventide H3000-style** harmonizers use OLA-based methods at very short windows for low latency at the cost of artifacts.

Offline / printed options can use 4096+ FFT with phase-locked phase vocoder for cleaner results.

### Choosing the Algorithm

For a senior code review:

- **Monophonic voice or instrument, transparent correction:** PSOLA. Auto-Tune lineage.
- **Polyphonic mix, transparent stretch up to ~2x:** Phase-locked phase vocoder. Rubber Band, Elastique.
- **Transient-rich material (drums):** Phase vocoder with explicit transient detection plus passthrough on transient frames. Most modern engines do this.
- **Creative and textural:** Granular.
- **Extreme stretches (10x+):** PaulStretch-style randomized-phase methods.

If you need transparent pitch shift with low latency in a real-time plugin, plan to license Elastique or use Rubber Band's R3 engine.

---
