## Interview Questions

These are interview questions at the level Apple's CoreAudio team, Avid's Pro Tools team, Native Instruments, FabFilter, iZotope, Audiokinetic, and Dolby would ask a senior or staff candidate. Senior-at-FAANG level. The expected answer in each case requires both DSP knowledge and C++ systems thinking.

### 1. Walk me through what happens, end to end, when an audio callback fires at 48 kHz with a 64-sample buffer on macOS.

The expected answer covers: hardware interrupt from the audio device, kernel ISR, CoreAudio HAL queue, the user-space `coreaudiod` process notification, the IOProc thread waking on a Mach port, your callback running with `THREAD_TIME_CONSTRAINT_POLICY` priority, the deadline of 1.33 ms, what happens if you miss it (the driver fills with silence or repeats the last buffer), and the typical observed RTT of 3-5 ms including ADC and DAC. A senior should also mention HAL plug-ins, the difference between IOProc and the older CFRunLoop notifications, and the role of `audioServerD` versus `coreaudiod`.

### 2. Why is `std::mutex::lock` forbidden on the audio thread but `std::mutex::try_lock` is acceptable?

The expected answer explains priority inversion. If a non-realtime thread holds the mutex and gets preempted by an unrelated higher-priority task, the audio thread waits indefinitely. `try_lock` returns immediately on contention, and the caller can fall back to a stale value or skip the operation. A senior should mention that priority inheritance mutexes (POSIX `PTHREAD_PRIO_INHERIT`) solve this in principle but are not the default on any major OS, and that even with PI mutexes the wait can still be longer than the audio deadline. They should also know that Apple's `os_unfair_lock` does not provide priority inheritance and is not safe.

### 3. Implement an SPSC ring buffer using only `std::atomic`. Walk me through the memory ordering choices.

Expected: a power-of-2 capacity, head and tail on separate cache lines, producer reads head with relaxed and tail with acquire, writes head with release, consumer is symmetric. A staff candidate should be able to explain why relaxed-acquire-release is sufficient (the store-release on head pairs with the load-acquire on head from the consumer, ensuring that the write to `data_[head]` is visible before the consumer reads via the new head), and why `seq_cst` would be unnecessarily expensive.

### 4. What are denormal numbers, why do they hurt audio CPU on x86, and how do you protect against them?

Denormals are sub-normal IEEE 754 floats below `2^-126` for single precision. On most x86 CPUs, denormal operations trap to microcode and run roughly 100x slower than normal operations. In a busy mix with filters whose state decays toward zero during silence, denormals can spike a previously-fine audio thread and cause dropouts. The fix: set DAZ (denormals are zero on input) and FTZ (flush to zero on output) in `MXCSR`, typically with `_mm_setcsr(_mm_getcsr() | 0x8040)`, scoped to the audio callback. ARM has the FZ bit in FPCR. JUCE provides `juce::ScopedNoDenormals`. A senior should also know about deliberate DC injection as a backstop and how to recognize the behavior pattern in a CPU profile (sudden jump after silence).

### 5. Design a plugin parameter system that supports both GUI editing from the message thread and host automation, sample-accurate, with no locks.

Expected: `std::atomic<float>` per parameter as the audio-thread-readable value. Host automation events have sample offsets within the block, the plugin walks them in order, applying each at its sample offset. GUI changes go through APVTS or equivalent, which writes to the same atomic. A senior should mention parameter smoothing (one-pole or linear ramp over the block) to avoid clicks from large jumps, and the caveat that VST3 and CLAP support sample-accurate automation natively, AAX does not.

### 6. Implement a biquad in transposed direct form II. Why TDF II and not direct form I?

Expected: the TDF II implementation from section 8 of the chapter, with two state variables `z1` and `z2`. The numerical advantage: TDF II is less sensitive to coefficient quantization at low frequencies, and accumulates less error in single-precision float. Direct form I has four state variables and worse numerical behavior, especially for filters with closely-spaced poles (sharp resonances near DC).

### 7. You have a 65,000-tap FIR filter you need to apply in a real-time plugin. What is the algorithm?

Expected: Gardner's uniform partitioned convolution. Split the impulse into partitions equal to the host block size, FFT each partition once at startup, and per block accumulate the products in the frequency domain across all partitions and IFFT. Latency equals the host block size, not the impulse length. CPU is roughly proportional to (logBlockSize) * numPartitions. A senior should mention that for very long impulses, non-uniform partitioning (Garcia 2002) trades a small startup cost for lower steady-state CPU.

### 8. Explain the difference between Dolby Atmos as a master and Dolby Atmos as a delivery format.

Expected: As a master, Atmos is a 7.1.2 or 7.1.4 channel-based bed plus up to 128 audio objects with positional metadata, stored in ADM BWF. As a delivery format, it is encoded (Dolby Digital Plus JOC for streaming, MAT 2.0 for HDMI bitstream, AC-4 for some broadcast). The renderer at playback time turns the master into the speaker layout the listener actually has, including binaural for headphones. A senior should mention the licensing model (Dolby licenses encoders, receivers, and the renderer) and the role of the Dolby Atmos Renderer software in production.

### 9. Walk me through the WebRTC voice chain.

Expected: capture, AEC3 with delay estimation and an adaptive linear filter plus residual non-linear processor, NS using RNNoise or similar, AGC2 normalizing level, VAD plus DTX/CNG, Opus encoder, RTP. On receive: jitter buffer (NetEQ) with adaptive depth, Opus decoder, PLC for missing frames, mixer if multiparty, playback. A senior should know that AEC3 runs at 16 kHz internally for the canceller core, why the delay estimator matters (OS timestamps are unreliable), and the role of FEC.

### 10. What does it mean for a plugin to "report latency" to the host, and why is it important?

A plugin that introduces processing latency (lookahead transient detection, oversampling FIR filters, FFT block sizes) must report it via the format API (VST3 `getLatencySamples`, AU `kAudioUnitProperty_Latency`, AAX `eProperty_LatencyContribution`, CLAP `clap_plugin_latency`). The host uses this for automatic delay compensation: parallel signal paths through different plugins are aligned by inserting matching delays in shorter paths. A plugin that lies about latency causes phase issues when summed with parallel paths (comb filtering). A senior should know how to test that their reported latency matches reality (impulse test from chapter 21), and that AAX is particularly strict about this.

### 11. Implement a lock-free mechanism for the GUI thread to send a coefficient table (say, 256 floats representing an EQ curve) to the audio thread.

Expected: double-buffer of coefficient tables with an atomic index. GUI thread writes to the inactive buffer, then atomically swaps the index. Audio thread reads the index with acquire, reads the table. RCU-style with a generation counter handles multiple updates between audio reads. A staff candidate would mention the `seqlock` pattern as an alternative for larger objects and the publish/subscribe pattern via SPSC ring buffer (push the new full table as a unit) for very small objects.

### 12. Why is JUCE the de facto plugin framework, and what are its limitations?

Expected: JUCE provides cross-platform builds for VST3, AU, AAX, CLAP, and standalone, a plugin lifecycle abstraction (`AudioProcessor`), parameter management, GUI components, MIDI, audio I/O, and a small DSP module. Limitations: GUI rendering is software by default (Direct2D in JUCE 8 for Windows, but still not GPU-native by default everywhere), the framework is broad and pulls in dependencies that pure-DSP teams prefer to avoid, and the build system (Projucer) is idiosyncratic compared to plain CMake. iPlug2 is the leading alternative for teams wanting more control.

### 13. What is MIDI 2.0 and why does it matter?

MIDI 2.0 (ratified 2020, shipped natively on macOS 11+ and iOS 14+) uses 32-bit Universal MIDI Packets and provides 16-bit velocity, 32-bit controllers, per-note expression, MIDI Capability Inquiry, and Profiles. It matters because per-note expression in a backward-compatible way addresses the use cases that MPE handled with channel-per-note hacks, and because the 32-bit controllers eliminate the 7-bit step quantization that produced audible "zipper noise" on automation. Adoption is gradual. MIDI 1.0 is still the default in 2026.

### 14. You are profiling a plugin that has a CPU spike on every transient in the input audio. What is the most likely cause, and how do you diagnose it?

The most likely cause is a non-linear processor (saturator, compressor) without oversampling generating aliasing, or an envelope detector that does heavy work during attack. Diagnose with hardware timestamp counters logging per-block cycles to a non-realtime thread, run a transient-rich input, and look at the worst-case cycles. If oversampling is the cause, the worst case is much higher than the mean (the oversampler is engaged during transients but at lower rate during sustained tones if it has a smart bypass). A senior would also mention that an unbounded inner loop iterating over MIDI events or a denormal trap kicking in are alternative culprits, and the role of RTSan in catching realtime violations that correlate with transients.

### 15. Suppose you ship a real-time pitch shifter plugin and a customer says it has audible "phasiness" on dense pop mixes. What is happening and what are your options?

Phase vocoders advance each FFT bin's phase independently, breaking the phase relationships between harmonically related bins, and that produces phasiness. Options: implement phase locking around spectral peaks (Laroche-Dolson 1999), where bins around a peak share a single phase advance, use a pitch-synchronous algorithm if the source is monophonic (PSOLA), switch to a granular approach for textural sources, or license a commercial engine like zplane Elastique or Rubber Band R3 that has phase locking built in. A senior would also note that latency tradeoffs apply: better algorithms typically need larger FFT windows and add latency.

---
