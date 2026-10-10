## Exercises

These six labs are graduated in difficulty from "all senior audio engineers should be able to do this in an afternoon" to "this is a multi-day project at the level of an interview onsite take-home." Solutions go in your own GitHub. Test against Plugin Doctor and PluginVal as you build.

### Lab 1: Realtime-Safe SPSC Ring Buffer with Tests

Implement a single-producer single-consumer ring buffer for `float` samples, capacity 4096, using only `std::atomic`. Write a test that:

1. Starts a producer thread and a consumer thread.
2. Producer pushes a 1 MHz monotonically increasing counter for 60 seconds.
3. Consumer pops and verifies the counter is monotonic (each value is greater than the previous).
4. Run under ThreadSanitizer with no warnings.
5. Measure throughput. Should exceed 100 million samples per second on a modern desktop.

Stretch goal: extend to MPSC (multi-producer, single-consumer) using either Vyukov's algorithm or Cameron's `moodycamel::ConcurrentQueue` for reference. Compare contention behavior.

Deliverable: `spsc_ring_buffer.h`, `test_spsc.cpp`, README with measured throughput.

### Lab 2: Real-Time-Safe Biquad Cascade EQ Plugin

Build a 5-band parametric EQ as a JUCE plugin. Each band has bypass, gain (-24 to +24 dB), frequency (20 to 20000 Hz with logarithmic taper), and Q (0.1 to 10). Implement biquads in transposed direct form II using the RBJ cookbook coefficients for peaking, lowshelf, highshelf, lowpass, and highpass.

Requirements:

1. Sample-accurate parameter automation (read parameter values once per block, smooth with a one-pole filter to avoid clicks).
2. Pass `juce::ScopedNoDenormals` at the start of `processBlock`.
3. State save and restore round-trips perfectly.
4. Latency reported correctly (zero, since biquads are zero-latency).
5. Build VST3, AU, and standalone targets via Projucer or CMake.
6. Pass `pluginval --strictness 10`.
7. Run the plugin through Plugin Doctor and verify the frequency response matches the design.

Deliverable: full JUCE project, PluginDoctor screenshot, pluginval log.

### Lab 3: Partitioned Convolution Reverb

Implement a uniform partitioned convolution reverb in C++. Use any FFT library (KISS-FFT, PFFFT, or JUCE's `juce::dsp::FFT`).

Requirements:

1. Load an impulse response from a WAV file.
2. Partition into uniform blocks of size `N` (host block size).
3. FFT each partition once at startup.
4. Per block, FFT the input, accumulate frequency-domain products across partitions, IFFT.
5. Stereo I/O with separate left and right impulse responses (mono IR fanned out is acceptable for the first pass).
6. Latency equal to `N` (verify with impulse test).
7. CPU usage measured and reported (per-block cycles converted to percentage).

Acceptance: load a real hall impulse (you can record one with phone and clap, or download a public IR), process a piano recording, listen, and confirm it sounds like a hall (not metallic, not phasey, smooth decay).

Stretch goal: implement non-uniform partitioning per Garcia 2002. Compare CPU between uniform and non-uniform with a 5-second IR.

Deliverable: C++ code, sample input and output WAVs, CPU measurements, impulse response files.

### Lab 4: WebRTC-Style Voice Chain

Build a voice chain that captures from a microphone, runs AEC + NS + AGC, encodes with Opus, decodes the same packets back, and plays to the speaker.

Requirements:

1. Use AAudio/Oboe on Android, CoreAudio on macOS/iOS, or PortAudio for cross-platform development.
2. AEC: integrate `libwebrtc`'s AEC3 (or use Apple's `AUVoiceProcessing` on macOS as a shortcut).
3. Opus encode at 24 kbps with FEC and DTX enabled.
4. Decode and play back in the same process (loopback).
5. Run for 60 seconds with the speaker playing your own voice. Verify that the captured-and-replayed signal does not echo your earlier playback.
6. Measure end-to-end latency by clapping near the mic and watching for the replayed clap.

Acceptance: ERLE > 25 dB during single-talk, no audible echo, mouth-to-ear latency under 200 ms.

Deliverable: project, latency measurement video, ERLE measurement script.

### Lab 5: Synthesizer with MIDI Input

Build a polyphonic subtractive synthesizer JUCE plugin with the following:

1. 8 voices, voice stealing on note overflow.
2. Anti-aliased oscillators (PolyBLEP for saw, square, triangle).
3. Resonant low-pass filter per voice (Trapezoidal SVF).
4. ADSR envelope for amplitude.
5. ADSR envelope for filter cutoff with adjustable amount.
6. LFO modulating cutoff or pitch (selectable).
7. MPE support (per-note pitch bend, channel pressure, CC74 slide).
8. Preset save and recall.

Requirements:

1. Sample-accurate MIDI handling (split blocks at event boundaries).
2. Pass MIDI 1.0 and accept MIDI 2.0 input through JUCE's converter.
3. CPU under 5% on a modern Mac for 8-voice playback.

Deliverable: JUCE project, demo of plugin played through an MPE controller (Roli, Linnstrument, or virtual via a MIDI app).

### Lab 6: HRTF-Based Binaural Renderer

Build a real-time HRTF binaural renderer. Input: a mono source plus a 3D position. Output: stereo binaural.

Requirements:

1. Load a SOFA-format HRIR database (`libmysofa` or hand-parsed).
2. Pick the nearest HRIR set for the requested direction (or use 4-point trilinear interpolation between neighboring measurements).
3. Convolve the input separately for left and right ears using partitioned convolution (lab 3 component reused).
4. Smoothly cross-fade between HRIRs as the source position changes (avoiding clicks).
5. Render at 64-sample blocks, 48 kHz, with under 2% CPU per source on a modern Mac.

Acceptance: a moving mono source (a plane flying past) is perceived as moving in a real spatial arc. A test pattern that sweeps azimuth from -180 to +180 degrees should be perceived as a smooth rotation around the head when listened to with headphones.

Stretch goal: support multiple sources and head tracking input from an AirPods-compatible API (`CMHeadphoneMotionManager` on iOS), updating positions in real time.

Deliverable: project, demo audio file with multi-source binaural render, video of head-tracking demo if you tackle the stretch goal.

---

These six labs together cover the full vertical of the chapter: real-time C++ idioms, plugin formats, DSP algorithms, FFT-based processing, voice chain integration, synthesis, and spatial audio. A candidate who completes all six is interview-ready for any senior audio role at any plugin shop, DAW vendor, or game audio middleware company.

---
