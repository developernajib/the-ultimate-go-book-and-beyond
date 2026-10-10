## Summary

Real-time audio and DSP in C++ requires rigorous discipline across low-latency threading, hardware callbacks, and DSP mathematics. The material spans the audio thread real-time discipline, lock-free C++ patterns, the platform callback APIs (CoreAudio, ASIO, WASAPI, JACK, AAudio, PipeWire), JUCE in depth, the four shipping plugin formats (VST3, AU, AAX, CLAP), DSP fundamentals (biquads, FIR/IIR, denormals), FFT and partitioned convolution, oversampling, pitch and time stretching, reverb algorithms, synthesis techniques, MIDI 1.0 and 2.0, Dolby Atmos and HRTF, voice codecs (Opus, AAC, xHE-AAC), the WebRTC voice chain, audio drivers and the latency budget, OS-level low-latency tuning, profiling without syscalls, bit-exact regression testing, game audio middleware (Wwise, FMOD, MetaSound), and the active research and product directions in ML-based audio.

### What to Take Away

Three points carry the chapter:

**The audio thread is sacred.** The deadline is wall-clock time and missing it is audible. Every line of code that runs on it must complete in bounded time. No allocation, no locks that can block, no syscalls, no logging, no exceptions. RTSan and the realtime-safe C++ idioms (SPSC ring buffers, atomic parameters, pre-allocation, denormal flags) are not optional. They are how shipped audio code stays shippable.

**The DSP is decades old, the systems engineering is current.** The biquad math has not changed since RBJ wrote the cookbook. The FFT has not changed since Cooley-Tukey. What has changed and continues to change is the platforms: low-latency Windows (WASAPI exclusive), Apple silicon's audio accelerator, Android AAudio's gradual maturation, PipeWire replacing the Linux audio split, Atmos reaching consumers, MIDI 2.0 ratification, CLAP gaining ground, ML-based denoisers running on the Neural Engine. The senior engineer is fluent in both layers.

**The product is the user's experience.** A plugin that adds 3 ms of latency in monitoring is unusable for tracking even if it sounds perfect on playback. A reverb that consumes 30% CPU is unusable in a 50-track session even if its tone is gorgeous. A voice product with 500 ms mouth-to-ear latency loses to a competitor at 150 ms regardless of codec quality. Every engineering decision flows from the user's actual experience.

### Where to Take This

Senior-track careers from this chapter:

- **Plugin development** at FabFilter, iZotope, Native Instruments, Eventide, Soundtoys, Universal Audio, Waves, Plugin Alliance, Acustica.
- **DAW development** at Apple (Logic, Final Cut), Avid (Pro Tools), Steinberg (Cubase, Nuendo), Ableton (Live), Image-Line (FL Studio), PreSonus (Studio One), Bitwig, Cockos (Reaper), Tracktion (Waveform).
- **Game audio middleware** at Audiokinetic (Wwise), Firelight (FMOD), Epic (MetaSound), Unity (native audio).
- **Voice and conferencing audio** at Zoom, Microsoft (Teams), Google (Meet), Apple (FaceTime, Phone), Discord, Cisco (Webex), 8x8.
- **Hardware audio products** at Apple (AirPods), Bose, Sonos, Sony, Roland, Yamaha, Roli, Sensel, Universal Audio.
- **Spatial audio** at Apple, Dolby, Sony, Audeze, plus the audio teams at every VR headset manufacturer.
- **Embedded audio** at Tesla, Apple (CarPlay), Google (Auto), automotive Tier 1s (Harman, Bose Auto).
- **Streaming audio infrastructure** at Spotify, Apple Music, Tidal, Deezer, Amazon Music.

The role titles are typically Senior Audio Engineer, Staff Audio Engineer, Principal DSP Engineer, Audio Software Architect. Compensation tracks general senior C++ engineering at the same companies, with a premium at the specialist plugin shops because the talent pool is small.

### What This Chapter Did Not Cover

A few specialist topics did not fit:

- **Linear-phase EQ design** (Parks-McClellan FIR design, complementary filter design for crossovers).
- **Adaptive filtering theory** (LMS, RLS, Kalman) beyond the AEC summary.
- **Psychoacoustic models** in detail (the bark scale, masking curves used in lossy codecs).
- **Loudspeaker DSP** (room correction, multiband processing for speakers).
- **Hearing aid signal processing** (a separate world with its own vendor codebases and ISO standards).
- **Audio over IP** beyond a brief WebRTC mention (Dante, AES67, Ravenna).

If your career path takes you into one of these, the foundations in this chapter map directly onto each.

### How to Continue

Read the JUCE source. Read the libwebrtc source. Read the Faust standard library. Build the six exercises. Ship a plugin. Listen, critically, to the work of the engineers you respect.

Audio is one of the few domains in C++ where the work is judged by something outside the code. Either it sounds right or it does not. The discipline that produces audio that sounds right is the discipline this chapter has attempted to teach.

---

| [◀ Chapter 161: Modern Graphics APIs in C++](../chapter-161-graphics-apis/00-introduction.md) | [Chapter 162: Real-Time Audio and DSP in C++](00-introduction.md) | [Chapter 163: Embedded C++ and RTOS Programming](../chapter-163-embedded-rtos/00-introduction.md) ▶ |
