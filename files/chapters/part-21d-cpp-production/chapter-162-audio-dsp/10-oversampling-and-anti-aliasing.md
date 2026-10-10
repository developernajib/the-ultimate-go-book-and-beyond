## Oversampling and Anti-Aliasing

Any non-linear processor (saturator, distortion, compressor with smooth gain reduction, waveshaper, tape emulation) generates harmonics above the input's frequency content. If those harmonics exceed the Nyquist frequency they alias back into the audible band as inharmonic, dissonant tones. The mitigation is oversampling: temporarily run the non-linear stage at 2x, 4x, or 8x the host's sample rate, then filter and downsample back.

Every saturator, every drive-style compressor, every console emulation, and every guitar amp model in the modern plugin market uses oversampling internally. The senior engineer knows the math, the cost, and the tradeoffs.

### Why Oversampling Helps

A waveshaper `y = tanh(g*x)` driven by a 5kHz sine at gain 4 produces strong harmonics at 5, 15, 25, 35 kHz. At 48kHz sample rate (Nyquist 24kHz), the 25kHz harmonic aliases to 23kHz and the 35kHz harmonic aliases to 13kHz. Those aliased components are inharmonic relative to the input frequency and are perceived as a metallic, harsh artifact.

At 4x oversampling (192kHz internal Nyquist 96kHz), the harmonics up to about 90kHz can exist without aliasing. After processing, a steep low-pass filter removes everything above the original 24kHz before downsampling, so the audible output contains only the in-band harmonics that were going to alias anyway.

### The Two Filters

Oversampling needs two anti-alias / anti-image filters:

1. **Upsampling.** Insert zeros between input samples (zero-stuffing), then low-pass to remove the spectral images that the zero-stuffing creates. Cutoff at the original Nyquist (e.g., 24kHz).
2. **Downsampling.** Low-pass the high-rate output to remove energy above the target Nyquist, then keep every Nth sample.

Both filters need to be steep (transition band as small as possible to preserve high-frequency content), low-passband-ripple, and have controlled phase.

### Half-Band Filters

For 2x oversampling, half-band filters are the workhorse. A half-band FIR has every other coefficient equal to zero (except the center tap), which halves the multiplications. A half-band IIR (allpass-based) has half the operations of a generic IIR. Tony Fisher and Olli Niemitalo's polyphase IIR halfband designs are the standard reference.

```cpp
// Polyphase 2x upsampler using two allpass cascades.
// Reference: Olli Niemitalo, "Polyphase IIR Halfband Filters".
class PolyphaseUpsampler2x {
    // Two allpass filter chains, one for even output samples, one for odd.
    struct Allpass1 {
        float c, x1 = 0.0f, y1 = 0.0f;
        Allpass1(float coeff) : c(coeff) {}
        float process(float x) noexcept {
            float y = c * (x - y1) + x1;
            x1 = x; y1 = y;
            return y;
        }
    };
    Allpass1 a0_, a1_;     // even path
    Allpass1 b0_, b1_;     // odd path

public:
    PolyphaseUpsampler2x()
        : a0_(0.07471823853680822f), a1_(0.5238224384088594f),
          b0_(0.2956462841135282f),  b1_(0.7993618706772144f) {}

    void process(float x, float& y0, float& y1) noexcept {
        // Even and odd outputs from the two allpass paths.
        y0 = a1_.process(a0_.process(x));
        y1 = b1_.process(b0_.process(x));
    }
};
```

Each input sample produces two output samples. Cost is 4 multiplies and 4 adds per input sample, an order of magnitude less than a comparable FIR.

A 2x downsampler is the same structure run in reverse: take pairs of input samples, run them through the two allpass paths, average the result, output one sample.

### 4x and 8x

For 4x, cascade two 2x stages. Each stage has its own halfband filter, its own latency, and its own CPU cost. Cumulatively about 4x the work of a single 2x stage.

For 8x, three cascaded 2x stages. Some plugins (Soundtoys Decapitator, Plugin Alliance bx_console) offer 16x oversampling for the most aggressive saturation algorithms. The diminishing returns kick in fast.

JUCE provides `juce::dsp::Oversampling<float>` with configurable ratio and filter type:

```cpp
juce::dsp::Oversampling<float> oversampler(
    /*numChannels=*/ 2,
    /*factor=*/ 2,                // 2x oversampling
    juce::dsp::Oversampling<float>::filterHalfBandPolyphaseIIR,
    /*isMaximumQuality=*/ true);

void prepareToPlay(double sr, int blockSize) {
    oversampler.initProcessing(static_cast<size_t>(blockSize));
}

void processBlock(juce::AudioBuffer<float>& buf, juce::MidiBuffer&) override {
    juce::dsp::AudioBlock<float> block(buf);
    auto upBlock = oversampler.processSamplesUp(block);
    // Run non-linear processing on upBlock at 2x rate.
    for (int ch = 0; ch < upBlock.getNumChannels(); ++ch) {
        auto* d = upBlock.getChannelPointer(ch);
        for (size_t i = 0; i < upBlock.getNumSamples(); ++i)
            d[i] = std::tanh(d[i] * drive_);
    }
    oversampler.processSamplesDown(block);
}
```

### IIR vs FIR Tradeoff

Both filter families work for halfband:

- **IIR (allpass-based polyphase):** Lowest CPU. Non-linear phase. The phase distortion is small at the cutoff but real, and a chain of IIR oversamplers adds phase distortion at high frequencies. Acceptable for distortion and saturation where harmonic content is the focus.
- **FIR (linear phase, symmetric coefficients):** Higher CPU (latency proportional to filter length). Zero phase distortion. The choice for mastering and EQ-style applications where phase coherence matters across a stereo image.

Most plugins offer both as a quality setting, with IIR as "fast" or "low-CPU" and FIR as "high quality" or "linear phase."

### Latency

FIR halfband filters are linear-phase, so they have a constant group delay equal to half the filter length. A 31-tap halfband has 15-sample latency at the high rate, equivalent to 7.5 samples at the host rate. At 4x with two cascaded stages this becomes about 15 samples of total latency for the host. Plugins must report this as latency to the host so automatic delay compensation works.

IIR halfband has very low latency (a few samples) because the allpass chains are short.

### Real-World Cost

A 2x oversampled stereo saturator at 48kHz with IIR halfband, written carefully, costs around 0.5% to 1% CPU on a modern Mac per instance. 4x roughly triples that. 8x roughly doubles 4x. Vintage emulations that run at 16x or use FIR halfband with 256-tap filters can hit 5-10% CPU per instance, which is why they offer "render quality" modes that engage maximum oversampling only when bouncing.

### When Not To Oversample

Oversampling is not free. If your processor is linear (EQ, gain, delay, reverb), there is no aliasing to remove because no new frequency content is generated. Oversampling these is pure CPU waste.

Oversample exactly the non-linear stage. Run the linear-phase EQ before the saturator at 1x, run the saturator at 4x with up/down filters around it, run the post-saturator EQ at 1x again. This minimizes the CPU spent in the high-rate domain.

```cpp
void processBlock(juce::AudioBuffer<float>& buf, juce::MidiBuffer&) override {
    preEq_.process(buf);            // 1x

    juce::dsp::AudioBlock<float> block(buf);
    auto up = oversampler_.processSamplesUp(block);
    saturator_.process(up);         // 4x
    oversampler_.processSamplesDown(block);

    postEq_.process(buf);           // 1x
}
```

### DSP-Side Anti-Aliasing Without Oversampling

For some non-linear shapes, anti-aliased function tables (ADAA, Antiderivative Anti-Aliasing, Bilbao and Parker 2016) avoid oversampling entirely. The trick is to integrate the non-linear function once analytically and then differentiate at the sample rate, which acts as a lowpass on the new harmonics.

For a saw oscillator, BLEP (band-limited step) and BLAMP (band-limited ramp) corrections from Eli Brandt's "Hard Sync Without Aliasing" (2001) are standard.

These techniques can replace oversampling for specific function shapes (oscillators, simple waveshapers) and give better CPU at equivalent quality. They require analytical derivation per shape, which is why oversampling remains the general-purpose solution.

---
