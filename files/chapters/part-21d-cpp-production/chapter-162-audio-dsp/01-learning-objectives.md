## Learning Objectives

By the end of this chapter, you will be able to:

### Foundational

- Explain the audio sample rate, bit depth, and channel layout choices used across consumer, prosumer, and broadcast workflows, and pick the right format for a given product (44.1k for CD-derived material, 48k for broadcast and game, 96k for tracking, 192k for mastering, 16-bit for delivery, 24-bit for tracking, 32-bit float for plugin internals).
- State the audio thread real-time rules from memory and identify violations in code review (no `malloc`, no `mutex` lock that can block, no syscalls, no logging, no unbounded loops, no exceptions in the hot path).
- Compute the wall-clock deadline for an audio callback given sample rate and buffer size, and explain what happens when a callback misses its deadline on CoreAudio, ASIO, WASAPI, AAudio, and PipeWire.

### Realtime-Safe C++

- Implement a single-producer single-consumer lock-free ring buffer using `std::atomic` with explicit memory ordering, correct by inspection.
- Use `std::atomic<float>` for plugin parameter passing between the GUI thread and the audio thread without locks, and explain why a `std::mutex::try_lock` is acceptable on the audio thread but `lock` is not.
- Pre-allocate all memory at plugin construction or in `prepareToPlay`, sized to the worst-case buffer the host can request.
- Identify and disable denormal arithmetic on x86 (DAZ + FTZ via MXCSR) and ARM (FZ bit in FPCR) to protect the audio thread from CPU spikes when filter state decays toward zero.

### Platform Audio APIs

- Register a CoreAudio render callback, a JACK process callback, an ASIO buffer switch, a WASAPI event-driven render thread, and an AAudio data callback, and explain what each platform guarantees about thread priority, buffer size, and reentrancy.
- Use Oboe to write a single Android audio source file that targets AAudio on Android 8+ and falls back to OpenSL ES on older devices.
- Wrap each platform's callback in a RAII C++ class so the callback is unregistered deterministically on destruction.

### JUCE and Plugin Formats

- Implement a `juce::AudioProcessor` subclass with `prepareToPlay`, `processBlock`, `releaseResources`, and `getStateInformation` correctly handling sample rate changes, bypass, and host automation.
- Bind plugin parameters using `AudioProcessorValueTreeState` with atomic float backing for sample-accurate automation.
- Build the same DSP core into VST3, AU (v2 and v3), AAX, and CLAP packages from a single C++ codebase using JUCE or iPlug2 build configurations.
- Explain the parameter automation model in each format and the sample-accurate event delivery contract for VST3 and CLAP.

### DSP Fundamentals

- Design and implement a biquad filter in transposed direct form II, including coefficient calculation for lowpass, highpass, bandpass, peak, and shelving responses (RBJ cookbook formulas).
- Choose between FIR and IIR for a given filter requirement based on phase linearity, transient response, computational cost, and stability constraints.
- Implement a partitioned convolution reverb with frequency-domain block processing and explain the latency-versus-CPU tradeoff for partition size selection.
- Implement 2x and 4x oversampling using polyphase half-band IIR filters for non-linear processors (saturators, distortion, compressors with smooth gain reduction).

### Advanced DSP

- Choose between PSOLA, phase vocoder, and granular pitch shifting based on signal type (monophonic voice versus polyphonic music versus percussive material) and latency budget.
- Implement a Schroeder reverb (4 parallel combs into 2 series allpasses), a Freeverb-style reverb, and a feedback delay network (Hadamard or Householder mixing matrix), and explain when each is the right choice.
- Implement subtractive, FM, wavetable, and Karplus-Strong synthesis using a clean class hierarchy with polyphony, voice stealing, and per-voice parameter modulation.

### MIDI and Spatial Audio

- Parse MIDI 1.0 status bytes and channel messages, and parse MIDI 2.0 Universal MIDI Packets including per-note controllers and high-resolution velocity.
- Implement HRTF convolution for binaural rendering using a SOFA-format HRIR database and partitioned convolution per ear.
- Decode first-order and higher-order ambisonic signals to a binaural or speaker output using a known decoder matrix.

### Voice and Codecs

- Integrate libopus for low-latency voice with appropriate frame size (10ms or 20ms), DTX, and PLC settings.
- Wire up a WebRTC-style voice chain (AEC3, AGC2, NS, comfort noise, NetEQ jitter buffer) and explain the role of each block.
- Choose between AAC-LC, HE-AACv2, xHE-AAC, and Opus for a given application based on bitrate, latency, codec licensing, and platform support.

### Driver, Latency, and Performance

- Compute the end-to-end latency of an audio path from microphone to speaker, accounting for ADC, USB packetization, kernel buffer, application buffer, plugin lookahead, and DAC.
- Configure `SCHED_FIFO` on Linux, `THREAD_TIME_CONSTRAINT_POLICY` on Apple, and AAudio performance mode on Android for a real-time audio thread.
- Profile audio callback CPU usage without making syscalls inside the callback, using hardware timestamp counters and a lock-free reporting ring buffer.
- Detect and diagnose xruns (buffer underruns or overruns) in production code.

### Testing and Future

- Write bit-exact regression tests for a DSP module using golden output files, and explain the cross-platform numerical determinism caveats (denormal flags, FMA contraction, compiler math library differences).
- Articulate the current state of ML inference on the audio thread (it is not realtime-safe today for general models, but RNNoise and small specialized models can run with care), and design an architecture that runs ML inference off the audio thread with a sample-accurate handoff.

### Career Outcomes

After this chapter you can interview for senior and staff audio C++ roles at Apple (CoreAudio, AVAudioEngine, Logic Pro, Final Cut Pro audio), Avid (Pro Tools), Native Instruments, FabFilter, iZotope, Universal Audio, Splice, Soundcloud audio infrastructure, Spotify, Audiokinetic (Wwise), Firelight Technologies (FMOD), Dolby, Sonos, Bose, Discord, Zoom, Microsoft Teams audio, and the audio teams at every major game studio. You can also bootstrap your own plugin company.

---
