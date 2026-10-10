# Chapter 162: Real-Time Audio and DSP in C++

> "If your audio thread misses its deadline, the user hears it. There is no retry.", Ross Bencina

Audio is the hardest soft real-time domain that consumer software has to solve. A web request that takes 200ms is fine. A video frame dropped once an hour is invisible. An audio buffer that arrives 1ms late produces an audible click that every musician, gamer, and call participant in the room will notice and complain about. The deadline is not a target. It is the product.

C++ owns this domain and is not giving it up. Every digital audio workstation shipped to a working studio in 2026 is written in C++. Every VST3, AU, AAX, and CLAP plugin used on a hit record is C++. Every game audio engine running in a AAA title is C++. Every voice codec in your phone, every echo canceller in your conferencing client, every spatial audio renderer pushing Atmos objects to your headphones runs C++ on the hot path. The reason is not nostalgia. It is determinism.

## Why C++ Owns Audio

The audio thread runs at hard real-time priority on every modern OS. CoreAudio gives you a callback. So does ASIO, JACK, AAudio, WASAPI, and Pulse. The contract is identical across platforms: when the hardware needs the next buffer, you have N samples worth of wall-clock time to fill it, and N is small. At 48kHz with a 64-sample buffer, that is 1.33ms. Miss the deadline and the driver fills the buffer with zeros or repeats the last buffer, and the user hears a glitch.

A garbage-collected language cannot meet this deadline. Java, C#, Go, Swift with ARC, JavaScript, Python, all of them can stop the world for tens of milliseconds at unpredictable intervals. Rust can in principle, but the realtime audio ecosystem and tooling sits in C++. Even Apple, which prefers Swift everywhere else, ships AudioUnit v3 with a C++ render block because the Swift runtime is not safe to call from the render thread.

C++ wins because it gives you three things at once that no other production language gives you together:

1. **Deterministic destruction.** No GC pause. RAII releases resources at known points.
2. **Manual memory.** You can pre-allocate every buffer at construction and never touch the allocator again on the audio thread.
3. **Zero-cost abstractions over SIMD.** SSE, AVX, NEON, and Apple's AMX extensions are reachable through intrinsics or compiler-vectorized loops without runtime overhead.

The fourth advantage is the ecosystem. Forty years of DSP research has been written in C and C++. FFTW, KISS-FFT, Apple's vDSP, Intel IPP, libsamplerate, librubberband, soundtouch, libopus, libvorbis, all C or C++ libraries with stable ABIs. Every plugin host on every platform expects a C-callable entry point and a C++-friendly SDK.

## The Industry Codebases

When senior audio engineers talk shop, they are talking about a small set of codebases. You should know them.

**JUCE** is the dominant cross-platform plugin and application framework. Owned by Sound Radix as of 2024 (after Raw Material Software, then PACE), used by the majority of commercial plugin developers including FabFilter, Native Instruments hosts, iZotope (parts), and thousands of independent developers. JUCE 8 modernized the GUI stack with Direct2D on Windows, hardware-accelerated rendering, and a new WebView-based UI option. The `AudioProcessor` base class is the canonical lifecycle model that every plugin developer learns.

**iPlug2** is the open-source competitor to JUCE, used by Cockos (Reaper) and many indie devs who want more control and a smaller runtime than JUCE provides. The Tracktion Engine, also based on JUCE, powers Waveform, BBC R&D tooling, and several embedded music products.

**Tracktion Engine** is the C++ DAW engine licensed for embedded music products and custom DAWs. It handles tracks, edits, automation, and rendering and is what you license when you want to build a DAW without writing the timeline engine yourself.

**Ableton Max/MSP** (the Cycling '74 codebase, owned by Ableton since 2017) is a C++ visual programming environment for audio. Its underlying scheduler and DSP graph implementation is one of the more sophisticated commercial audio C++ systems.

**Apple AudioUnit and AVAudioEngine** are Apple's first-party audio frameworks, both C++ at the core with Objective-C and Swift wrappers. AUv3 plugins shipped on iOS and macOS are required to use this stack.

**Android AAudio and Oboe.** AAudio is the low-latency native audio API introduced in Android 8. Oboe is the C++ wrapper from Google that abstracts AAudio (preferred on newer devices) and OpenSL ES (legacy fallback). Every serious Android audio app uses Oboe.

**Wwise (Audiokinetic) and FMOD** dominate game audio middleware. Both ship C++ SDKs that integrate into Unity, Unreal, and proprietary game engines. Wwise's lower-level API (`AK::SoundEngine::PostEvent`) is the model most engine programmers learn.

**Unreal MetaSound and Unity Native Audio Plugin SDK** are the engine-native DSP graph systems for Unreal and Unity. Both expect C++ for the actual DSP code.

**WebRTC** (libwebrtc, primarily Google but with significant Apple and Mozilla contributions) is the de facto reference for realtime voice. Its audio chain (AEC3, AGC2, NS, NetEQ) is what every VoIP engineer has either shipped or competed with.

**Dolby Atmos Renderer and Apple Spatial Audio** are the production object-based audio renderers. Both are C++ and both are licensed, not open. The math (HRTF convolution, ambisonic decoding) is public, the implementations are not.

## What This Chapter Covers

This chapter is the deep technical guide for the senior C++ engineer working on or interviewing for audio roles at Apple (CoreAudio, AVAudioEngine, Logic), Avid (Pro Tools), Native Instruments, FabFilter, iZotope, Universal Audio, Audiokinetic, Firelight (FMOD), Dolby, Sonos, Bose, Roland, Yamaha, Spotify (audio pipeline), Discord (voice), Zoom, Microsoft Teams, Google Meet, or any of the hundreds of plugin shops.

We start with the rules. The audio thread is a religious context. No `malloc`, no `std::mutex` lock that can block, no `std::cout`, no syscalls, no exceptions in the hot path. We then build up: lock-free SPSC ring buffers, the platform callback APIs (CoreAudio, ASIO, AAudio, WASAPI, JACK, PipeWire), JUCE in depth, the plugin formats (VST3, AU, AAX, CLAP), DSP fundamentals (biquads, FIR/IIR, denormal handling), FFT and partitioned convolution, oversampling, pitch shifting, reverb (Schroeder through FDN through convolution), synthesis (subtractive through physical modeling), MIDI 1.0 and 2.0, Dolby Atmos and HRTF, voice codecs (Opus, AAC, xHE-AAC), the WebRTC voice chain, audio drivers and the latency budget, low-latency tuning (`SCHED_FIFO`, Apple QoS, PREEMPT_RT), profiling without syscalls, bit-exact regression testing, game audio middleware, and the open question of ML-based audio in a real-time context.

This is a senior to staff level chapter. If you are interviewing for an audio role at Apple, Avid, Dolby, Native Instruments, Audiokinetic, Roli, or any plugin shop, this is the material on the table.

## How to Read

Read sections 03 through 06 in order. The audio thread rules, the realtime-safe idioms, the callback architectures, and the JUCE deep dive are the foundation that the rest of the chapter builds on. After that, jump to whichever DSP or platform topic matches your interview or your project. The plugin format chapter (07) and the WebRTC voice chapter (17) are the two that hiring managers most often draw their interview questions from.

The interview questions in section 24 and the exercises in section 25 are at the level Apple's CoreAudio team and Avid's Pro Tools team use in onsite loops. If you can answer all 15 questions and complete the 6 labs, you are ready for any audio C++ interview in the industry.

---
