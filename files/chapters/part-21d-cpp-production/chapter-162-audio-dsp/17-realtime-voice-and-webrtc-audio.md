## Real-Time Voice and WebRTC Audio

The audio chain inside a modern voice product (Zoom, Google Meet, Microsoft Teams, Discord, FaceTime, Apple Phone, WhatsApp Voice) has converged on a similar architecture, largely shaped by Google's `libwebrtc` codebase. WebRTC is the de facto reference even for products that do not use the browser API. The senior engineer building voice products needs to know what each block does and how the blocks fit.

### The Voice Chain

```
mic ADC -> capture buffer -> AEC (echo cancel) -> NS (noise suppression)
        -> AGC (auto gain) -> VAD/CNG (voice activity / comfort noise)
        -> encoder (Opus) -> RTP packetization -> network

network -> RTP depacketization -> jitter buffer (NetEQ)
        -> decoder (Opus) -> PLC (packet loss conceal) -> mixer
        -> playback buffer -> speaker DAC
```

Each block has decades of research behind it. The following sections cover the modern reference implementations.

### Acoustic Echo Cancellation (AEC)

When the speaker plays the far-end's voice and the microphone picks it up, the far end hears their own voice delayed. AEC removes this echo by filtering the captured mic signal with an adaptive estimate of the speaker-to-mic transfer function and subtracting.

WebRTC's AEC3 (2018+, replaced AEC2) is the production standard for software AEC. It uses:

- A frequency-domain block adaptive filter (NLMS or RLS) tracking the room impulse response.
- A non-linear processor for residual echo suppression after the linear filter.
- A delay estimator to align mic and speaker streams (essential because the OS reports timestamps unreliably).

```cpp
// libwebrtc API sketch.
#include <modules/audio_processing/include/audio_processing.h>

webrtc::AudioProcessingBuilder builder;
auto apm = builder.Create();

webrtc::AudioProcessing::Config cfg;
cfg.echo_canceller.enabled = true;
cfg.echo_canceller.mobile_mode = false;
cfg.noise_suppression.enabled = true;
cfg.noise_suppression.level = webrtc::AudioProcessing::Config::NoiseSuppression::kHigh;
cfg.gain_controller2.enabled = true;
apm->ApplyConfig(cfg);

// Per 10ms block:
apm->ProcessReverseStream(speakerBuffer);  // far-end (will play to speaker)
apm->set_stream_delay_ms(estimatedDelayMs);
apm->ProcessStream(micBuffer);             // near-end (captured from mic)
```

Apple's `AVAudioSession` voice-processing mode and `AUVoiceProcessing` AudioUnit provide hardware-assisted AEC on iOS and macOS. They are quieter than libwebrtc on Apple hardware and use less CPU because parts run on dedicated DSPs (Apple silicon includes an audio accelerator block for voice processing).

Headset users typically have very little echo because the speaker is in the ear and the mic is near the mouth. Speakerphone users have severe echo and are where AEC quality is judged.

### Noise Suppression (NS)

NS reduces stationary background noise (HVAC, fan hum, traffic). Classical NS uses spectral subtraction with a noise estimator (minimum-statistics, Martin 2001). Modern NS in WebRTC uses a small recurrent neural network (RNNoise, Mozilla / Xiph, 2017) that classifies each frequency band per frame as voice or noise and applies a gain mask.

NVIDIA's Broadcast and Krisp are commercial versions of ML-based NS that do more aggressive removal of non-stationary noise (typing, dog barks, doorbells). They run a larger model than RNNoise and require GPU or significant CPU.

Apple's voice isolation in iOS 15+ ships a similar ML-based noise suppressor running on the Neural Engine. It is exposed via `AVAudioSession.setMode(.voiceChat)` plus `AVAudioApplication.setVoiceProcessingEnabled(true)`.

### Automatic Gain Control (AGC)

AGC normalizes the captured level so the speaker is consistent regardless of how loud they speak or how close they are to the mic. WebRTC's AGC2 uses a slow-tracking digital gain combined with a fast limiter to prevent overshoots.

Tuning constraints:

- The attack should be slow enough to not pump on transients (50ms+).
- The release should be slow enough to not breath up noise during pauses (1-2s).
- The target should sit a few dB below clipping (typically -18 to -23 LUFS).

### Voice Activity Detection and Comfort Noise

VAD detects whether the current block contains voice. When not, the encoder can transmit a tiny CNG (comfort noise generation) packet describing the noise spectrum, saving bandwidth. The far-end decoder generates white noise shaped to that spectrum so the listener does not hear absolute silence (which is psychoacoustically uncomfortable and feels like a dropped call).

Opus has DTX (Discontinuous Transmission) baked in. With `OPUS_SET_DTX(1)`, the encoder transmits a 1-2 byte CNG packet during silence and the decoder fills in.

### Jitter Buffer (NetEQ)

RTP packets arrive over UDP. They can be late, lost, or out of order. The jitter buffer holds incoming packets and releases them at a steady cadence to the decoder. Too small: packets arrive late and are treated as lost. Too big: end-to-end latency grows.

NetEQ (the WebRTC jitter buffer) is adaptive. It estimates network jitter, sets the buffer depth dynamically, and uses time-stretching to absorb late packets without stretching the audio audibly:

- If a packet is missing, run PLC for that frame.
- If buffer is too low, time-stretch (slightly slow down) the next decoded frame to give more time.
- If buffer is too high, time-compress (slightly speed up) to drain.

NetEQ uses WSOLA for the time stretching, with a sub-1% rate change per frame so listeners do not hear pitch artifacts.

### Packet Loss Concealment (PLC)

When a packet is lost, the decoder generates a plausible audio frame from previous frames. Opus's PLC uses LPC (linear predictive coding) extrapolation for short losses (one frame) and pitch-based extrapolation for longer.

For losses longer than ~60ms, no PLC sounds good, and the decoder typically fades to silence and the listener hears a dropout. The mitigation at that point is FEC (sender-side redundancy) and retransmission (RFC 4588).

### Apple's AudioUnit Voice Processing

On iOS and macOS, the easy path is to instantiate the system voice-processing AudioUnit:

```objc
AudioComponentDescription desc = {
    .componentType = kAudioUnitType_Output,
    .componentSubType = kAudioUnitSubType_VoiceProcessingIO,
    .componentManufacturer = kAudioUnitManufacturer_Apple,
};
AudioComponent comp = AudioComponentFindNext(NULL, &desc);
AudioUnit voiceUnit;
AudioComponentInstanceNew(comp, &voiceUnit);
```

This unit incorporates AEC, AGC, and NS tuned by Apple for the device's mic and speaker geometry, runs partly on dedicated DSPs, and produces noticeably better results than software-only AEC for the same CPU. Almost every voice app on iOS uses it.

### Channel Counts and Sample Rates

WebRTC AEC3 internally runs at 16 kHz mono for voice. Higher rates (32, 48 kHz) are accepted but the AEC processes the lower sub-band. Opus encoder accepts up to 48 kHz stereo. For voice, 16 kHz mono is the conventional sweet spot. For "voice + ambient music" applications (Discord with stereo music sharing), the chain switches to 48 kHz stereo and disables AEC on the music input.

### Spatial Voice (3D Voice Chat)

Game voice chat in spatially-aware games (VRChat, Rec Room, Zoom Spaces) renders other participants' voices at their virtual positions using HRTF or VBAP. The pipeline:

1. Receive monaural voice streams from each remote participant.
2. Get each participant's 3D position from the game state.
3. Per stream, apply HRTF convolution for the relative direction.
4. Sum into stereo output.

Spatial voice has perceptual benefits: listeners can pick out individual speakers by position when several talk at once. This is the audio version of the "cocktail party effect" and works because the brain has stronger spatial attention than single-channel auditory attention.

### Real-Time Constraints in the Voice Chain

The whole chain runs in 10ms or 20ms blocks. Every block budget is sub-millisecond on modern hardware. The audio thread runs the capture-side processing (AEC + NS + AGC + encode) and the playback-side processing (decode + jitter buffer drain + mixer). Network I/O happens on a separate thread, with packets handed off through lock-free queues.

A typical voice app has three threads:

```cpp
// Audio thread: callback every 10-20ms
void audioCallback(...) noexcept {
    apm_->ProcessStream(captureBuffer);
    encoder_.encode(captureBuffer, encodedOut);
    encodedOutQueue_.try_push(encodedOut);

    EncodedPacket received;
    if (decodeInputQueue_.try_pop(received)) {
        decoder_.decode(received, playbackBuffer);
    } else {
        decoder_.decodePLC(playbackBuffer);
    }
}

// Network thread: pumps packets in/out
void networkThread() {
    // Send: drain encodedOutQueue_, pack into RTP, send.
    // Receive: receive RTP, depacketize, push into decodeInputQueue_.
}

// Render thread or message thread: GUI, statistics, control plane.
```

The discipline is the same as any plugin: nothing on the audio thread that can block.

### Tuning Targets

For a working real-time voice product:

- **End-to-end mouth-to-ear latency:** under 200 ms.
- **Echo return loss enhancement (ERLE):** above 30 dB during double-talk, above 60 dB during single-talk.
- **Voice MOS (Mean Opinion Score):** above 4.0 on a healthy connection.
- **CPU on a modern phone:** under 10% of one core total for the whole chain.

These are the targets that Zoom, Meet, and Teams ship to. Any product asking less is a product that will lose users to the alternatives.

---
