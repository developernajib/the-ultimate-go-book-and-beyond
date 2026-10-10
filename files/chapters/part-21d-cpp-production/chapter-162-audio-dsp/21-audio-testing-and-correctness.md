## Audio Testing and Correctness

A bug in audio software does not crash the application. It just sounds wrong, and the user notices. Unit tests for an FFT or a biquad need to verify mathematical correctness to a numerical tolerance. Integration tests for a plugin need to verify that automation, state save and restore, and bypass all behave precisely. The senior engineer at any commercial plugin shop ships a multi-layer test suite alongside the code.

### Bit-Exact Regression Tests

The strongest form of audio regression test is bit-exact: feed a known input file, save the output, and on every CI build compare to a stored "golden" output. Any change in the floating-point arithmetic produces a different output, and the test fails.

```cpp
TEST(MyPlugin, MatchesGoldenOutput) {
    auto input  = loadWav("testdata/sine_440_2sec.wav");
    auto golden = loadWav("testdata/sine_440_2sec_processed.wav");

    MyPlugin plugin;
    plugin.prepareToPlay(48000.0, 512);
    juce::AudioBuffer<float> buf(2, 512);
    juce::MidiBuffer midi;
    std::vector<float> out;
    int pos = 0;
    while (pos + 512 <= static_cast<int>(input.size())) {
        for (int ch = 0; ch < 2; ++ch)
            std::copy(input.data() + pos, input.data() + pos + 512,
                      buf.getWritePointer(ch));
        plugin.processBlock(buf, midi);
        for (int i = 0; i < 512; ++i) out.push_back(buf.getSample(0, i));
        pos += 512;
    }

    ASSERT_EQ(out.size(), golden.size());
    for (size_t i = 0; i < out.size(); ++i) {
        EXPECT_FLOAT_EQ(out[i], golden[i]) << "at sample " << i;
    }
}
```

Bit-exact testing catches every code change that affects the math. Three caveats:

1. **Determinism across platforms is not free.** Different FFT libraries, different SIMD capabilities, different compiler versions, and FMA contraction can all change the last few bits. Disable FMA contraction (`-ffp-contract=off`), pin the FFT library, fix the compiler version, and pin the optimization flags. Even then, do not expect bit-exact across architectures, have separate goldens for x86 and ARM.

2. **The denormal flag matters.** If your test runs without DAZ/FTZ set and the production code sets them, the test output differs. Set the flag in the test fixture to match production.

3. **Compiler math libraries differ.** `std::sin` from glibc and `std::sin` from Apple libsystem produce different last-bit results. If you need cross-compiler determinism, use a vendored math library (e.g., sleef-math) and pin its version.

### Tolerance-Based Tests

For tests that span platforms, bit-exact is too strict. Use a tolerance:

```cpp
inline bool nearEqual(float a, float b, float tol = 1e-6f) {
    return std::fabs(a - b) <= tol * std::max(1.0f, std::max(std::fabs(a), std::fabs(b)));
}
```

For DSP outputs, `1e-6` is appropriate for single-precision math. For state machines that incrementally update (long IIR chains), drift can accumulate, budget `1e-4` or use double precision for the test reference.

### Null-Test Patterns

A null test compares two signal paths that should produce identical output, looking for any residual:

```cpp
// Bypass a plugin and verify the output is bit-identical to input.
void verifyBypassIsTransparent(MyPlugin& p, const float* input, int n) {
    p.setBypassed(true);
    std::vector<float> output(input, input + n);
    juce::AudioBuffer<float> buf(1, n);
    std::copy(input, input + n, buf.getWritePointer(0));
    juce::MidiBuffer midi;
    p.processBlock(buf, midi);
    for (int i = 0; i < n; ++i) {
        ASSERT_FLOAT_EQ(buf.getSample(0, i), input[i]);
    }
}
```

A bypass that introduces even -120 dB of distortion will fail this test, which is the level of rigor expected for a paid plugin.

For testing latency reporting, push an impulse through and verify the impulse appears at the reported delay:

```cpp
void verifyReportedLatencyIsCorrect(MyPlugin& p) {
    int reported = p.getLatencySamples();
    juce::AudioBuffer<float> buf(1, 4096);
    buf.clear();
    buf.setSample(0, 0, 1.0f);
    juce::MidiBuffer midi;
    p.processBlock(buf, midi);
    int peakIdx = 0;
    float peak = 0.0f;
    for (int i = 0; i < 4096; ++i) {
        if (std::fabs(buf.getSample(0, i)) > peak) {
            peak = std::fabs(buf.getSample(0, i));
            peakIdx = i;
        }
    }
    EXPECT_EQ(peakIdx, reported);
}
```

### Frequency Response Tests

For an EQ or filter, sweep a sine through the plugin and measure the amplitude at each frequency:

```cpp
void measureFrequencyResponse(MyPlugin& p, std::vector<float>& freqs, std::vector<float>& gains) {
    const float fs = 48000.0f;
    for (float f : freqs) {
        juce::AudioBuffer<float> buf(1, 8192);
        for (int i = 0; i < 8192; ++i) {
            buf.setSample(0, i, std::sin(2.0f * 3.14159265f * f * i / fs));
        }
        juce::MidiBuffer midi;
        p.processBlock(buf, midi);
        // Discard first 1024 samples (transient), measure RMS of the rest.
        float sumSq = 0.0f;
        for (int i = 1024; i < 8192; ++i) {
            float v = buf.getSample(0, i);
            sumSq += v * v;
        }
        float rms = std::sqrt(sumSq / (8192 - 1024));
        gains.push_back(20.0f * std::log10(std::max(rms, 1e-12f) / 0.7071f));
    }
}
```

For a filter with a designed cutoff at 1000 Hz, the test asserts that the gain at 1000 Hz is near -3 dB and the rolloff matches the designed slope.

### THD and SNR

For non-linear processors, total harmonic distortion (THD) is the metric. Drive a pure sine through, FFT the output, divide the energy in harmonic bins by the energy in the fundamental:

```cpp
float measureTHD(MyPlugin& p, float f, float fs, float drive) {
    juce::AudioBuffer<float> buf(1, 8192);
    for (int i = 0; i < 8192; ++i) {
        buf.setSample(0, i, drive * std::sin(2.0f * 3.14159265f * f * i / fs));
    }
    juce::MidiBuffer midi;
    p.processBlock(buf, midi);
    // FFT of the latter 4096 samples.
    // Sum |X[k]|^2 for k corresponding to the fundamental, divide by sum of harmonics.
    return /* dB */ 0.0f;
}
```

Plugin Doctor automates this and produces a one-page report including THD, SNR, IMD, frequency response, and latency.

### State Save and Restore Round-Trip

Every plugin must round-trip its state without loss. The test:

```cpp
TEST(MyPlugin, StateRoundTrip) {
    MyPlugin a;
    a.setParameter("gain", -6.0f);
    a.setParameter("cutoff", 1234.5f);
    juce::MemoryBlock mb;
    a.getStateInformation(mb);

    MyPlugin b;
    b.setStateInformation(mb.getData(), static_cast<int>(mb.getSize()));
    EXPECT_FLOAT_EQ(b.getParameter("gain"), -6.0f);
    EXPECT_FLOAT_EQ(b.getParameter("cutoff"), 1234.5f);
}
```

Also test backward compatibility: load the state from an older version of the plugin and verify it still loads correctly. This is what catches the "session opens but my plugin is wrong" bug.

### Property-Based Tests

For numerical algorithms, property-based testing is powerful. Generate random inputs, verify invariants:

```cpp
void testFftIsInverse(int size) {
    std::vector<float> input(size);
    std::generate(input.begin(), input.end(),
                  []() { return rand() / static_cast<float>(RAND_MAX) * 2.0f - 1.0f; });
    auto spectrum = forwardFft(input);
    auto roundTrip = inverseFft(spectrum);
    for (int i = 0; i < size; ++i) {
        EXPECT_NEAR(roundTrip[i], input[i], 1e-5f);
    }
}
```

For a biquad, verify that a unit step settles within the designed time constant. For a reverb, verify that the energy decay rate matches the designed RT60.

### Stress Tests

Stress tests exercise the realtime contract:

- Run the plugin for 10 minutes with random parameter automation. Assert no exceptions, no crashes, no NaN output.
- Pump silent input through. Assert state stays normal (no denormal accumulation, no DC drift).
- Toggle bypass at a random sample boundary every block. Assert no clicks.
- Resize the buffer mid-stream (call `prepareToPlay` again). Assert no leaked state.
- Save and restore state every 10 blocks. Assert audio stays continuous.

PluginVal does most of these automatically with `--strictness 10`.

### Cross-Platform Determinism Test

For a senior team supporting Mac, Windows, and Linux, run identical input through identical code on all three platforms and store the outputs. Diff the outputs. Differences down to the last few bits are expected and acceptable. Differences larger than `1e-4` indicate a bug (denormal flag mismatch, FMA contraction difference, an undisclosed math library swap).

### Sanitizers

Run the test suite under:

- **AddressSanitizer (`-fsanitize=address`).** Catches out-of-bounds, use-after-free.
- **UndefinedBehaviorSanitizer (`-fsanitize=undefined`).** Catches signed overflow, null deref, alignment violations.
- **ThreadSanitizer (`-fsanitize=thread`).** Catches data races. ASAN and TSAN are exclusive.
- **RealtimeSanitizer (`-fsanitize=realtime`).** Catches non-realtime-safe calls in `[[clang::nonblocking]]` functions.

Any sanitizer trap is a P0 bug. Plugin shops with mature CI run all four against every PR.

### Manual Listening

No automated test catches "this reverb sounds boxy." Audio is consumed by ears, and the final QA step is always a human listening through good monitors. The senior engineer makes time for it.

---
