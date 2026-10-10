## Audio Callback Architectures

Every operating system exposes audio I/O through a callback model. The driver owns the timer, the driver owns the buffer ownership transitions, and the driver calls into your code when the next buffer is needed. The callback contract differs per platform in subtle but consequential ways. The senior engineer learns the differences once and writes a thin C++ adapter layer that hides them.

### CoreAudio (macOS, iOS)

Apple's CoreAudio is the oldest and arguably most carefully designed of the modern audio stacks. The `AudioUnit` render callback is the canonical entry point.

```cpp
#include <AudioUnit/AudioUnit.h>

OSStatus renderCallback(void* userData,
                        AudioUnitRenderActionFlags* flags,
                        const AudioTimeStamp* timestamp,
                        UInt32 busNumber,
                        UInt32 numFrames,
                        AudioBufferList* ioData) {
    auto* self = static_cast<MyEngine*>(userData);
    // ioData->mBuffers[0].mData is the output, interleaved float by default.
    self->process(static_cast<float*>(ioData->mBuffers[0].mData), numFrames);
    return noErr;
}

// Setup
AudioUnit unit;
AURenderCallbackStruct cb = { renderCallback, this };
AudioUnitSetProperty(unit, kAudioUnitProperty_SetRenderCallback,
                     kAudioUnitScope_Input, 0, &cb, sizeof(cb));
```

CoreAudio runs the callback on a dedicated real-time thread with `THREAD_TIME_CONSTRAINT_POLICY` priority. The thread is created and managed by the OS. The buffer size is negotiated at setup time via `kAudioDevicePropertyBufferFrameSize`. Apple recommends 64 to 256 frames for low-latency music applications.

For modern macOS and iOS apps, `AVAudioEngine` wraps AudioUnit with a Swift/Objective-C node graph but still calls into a C++ render block when you install one with `AVAudioSourceNode` or an `AVAudioUnitEffect` subclass. The tap installed via `installTapOnBus` is not realtime-safe, the source-node block is.

For AUv3 plugins, the entry point is `internalRenderBlock` which returns an `AUInternalRenderBlock` (a `^` block). Inside that block, the same realtime rules apply. The block is called from the host's render thread.

### ASIO (Windows)

ASIO (Audio Stream Input/Output, Steinberg) is the de facto Windows pro audio API. It bypasses the Windows audio stack and talks directly to a vendor-supplied driver. Latency at 64 samples and 48kHz is achievable on consumer interfaces (Focusrite, RME, MOTU, Universal Audio, PreSonus all ship ASIO drivers).

The ASIO callback is `bufferSwitch`:

```cpp
#include <iasiodrv.h> // From Steinberg ASIO SDK

void bufferSwitch(long doubleBufferIndex, ASIOBool directProcess) {
    // doubleBufferIndex is 0 or 1, ping-pong buffers
    for (int ch = 0; ch < numChannels; ++ch) {
        auto* out = static_cast<float*>(bufferInfos[ch].buffers[doubleBufferIndex]);
        // fill out[0..bufferSize-1]
    }
    asioDriver->outputReady(); // hint that output is ready
}
```

ASIO uses double buffering. While the driver is playing buffer 0, you fill buffer 1, and vice versa. The buffer size is set at driver level (the user picks it in the ASIO control panel). Sample format varies per driver and is queried via `ASIOGetChannelInfo`. Some drivers deliver 32-bit float, others 32-bit int (`ASIOSTInt32LSB`), some 24-bit packed (`ASIOSTInt24LSB`). The senior engineer writes a per-format conversion helper at startup.

Crucial gotcha: `bufferSwitchTimeInfo` is the preferred entry point, not `bufferSwitch`, because it provides an `ASIOTime` with sample-accurate timing for plugin chains that need it.

### WASAPI (Windows)

WASAPI (Windows Audio Session API) is the modern non-pro Windows audio API. It supports two modes:

**Shared mode.** Goes through the Windows audio engine, which mixes all running applications. Latency is dominated by the engine's mixer buffer (typically 10ms or more on older Windows, around 3ms on Windows 11).

**Exclusive mode.** Bypasses the mixer. Lower latency (down to about 3ms). Only one application can hold the device at a time.

WASAPI is event-driven. You create an event handle, the OS signals it when a buffer slot is available, and your dedicated thread does the work:

```cpp
#include <Audioclient.h>
#include <mmdeviceapi.h>

void wasapiThread(IAudioClient* client, IAudioRenderClient* renderClient, HANDLE event) {
    // Set thread to MMCSS Pro Audio profile for real-time priority
    DWORD taskIndex = 0;
    AvSetMmThreadCharacteristics(L"Pro Audio", &taskIndex);

    UINT32 bufferFrames;
    client->GetBufferSize(&bufferFrames);

    while (running.load(std::memory_order_acquire)) {
        DWORD wr = WaitForSingleObject(event, 2000);
        if (wr != WAIT_OBJECT_0) break;

        UINT32 padding;
        client->GetCurrentPadding(&padding);
        UINT32 framesAvailable = bufferFrames - padding;

        BYTE* data;
        renderClient->GetBuffer(framesAvailable, &data);
        // Fill data with framesAvailable frames
        renderClient->ReleaseBuffer(framesAvailable, 0);
    }
}
```

`AvSetMmThreadCharacteristics` with the "Pro Audio" task is essential. Without it, the thread runs at normal priority and Windows will preempt it for system work. With it, the thread runs at the highest user-mode priority Windows offers.

### JACK (Linux, macOS for pro audio)

JACK is a userspace audio server with a process callback per client. It is the standard for pro audio on Linux and a parallel option on macOS for users running Bitwig or Ardour.

```cpp
#include <jack/jack.h>

int processCallback(jack_nframes_t nframes, void* arg) {
    auto* self = static_cast<MyEngine*>(arg);
    auto* in  = static_cast<float*>(jack_port_get_buffer(self->inputPort,  nframes));
    auto* out = static_cast<float*>(jack_port_get_buffer(self->outputPort, nframes));
    self->process(in, out, nframes);
    return 0;
}

jack_client_t* client = jack_client_open("MyApp", JackNullOption, &status);
jack_set_process_callback(client, processCallback, this);
jack_port_t* outPort = jack_port_register(client, "out",
                                          JACK_DEFAULT_AUDIO_TYPE,
                                          JackPortIsOutput, 0);
jack_activate(client);
```

JACK ports are explicitly named and connected by the user (or programmatically) into a graph. The buffer size is set globally at JACK server startup. Sample rate is set globally. JACK's promise is that all clients see the same rate and block size and that the graph runs in dependency order.

### AAudio and Oboe (Android)

AAudio is the low-latency native audio API on Android, introduced in 8.0. It supports two performance modes:

- `AAUDIO_PERFORMANCE_MODE_LOW_LATENCY` for music and games.
- `AAUDIO_PERFORMANCE_MODE_POWER_SAVING` for streaming playback.

The data callback runs on a dedicated thread:

```cpp
#include <aaudio/AAudio.h>

aaudio_data_callback_result_t dataCallback(AAudioStream* stream,
                                           void* userData,
                                           void* audioData,
                                           int32_t numFrames) {
    auto* self = static_cast<MyEngine*>(userData);
    self->process(static_cast<float*>(audioData), numFrames);
    return AAUDIO_CALLBACK_RESULT_CONTINUE;
}
```

In production, do not target AAudio directly. Use Oboe, the Google-maintained C++ wrapper that picks AAudio on Android 8.1+ and falls back to OpenSL ES on older devices, and that has heuristics for the optimal buffer size on a given device:

```cpp
#include <oboe/Oboe.h>

class MyEngine : public oboe::AudioStreamCallback {
public:
    oboe::DataCallbackResult onAudioReady(oboe::AudioStream* s,
                                          void* audioData,
                                          int32_t numFrames) override {
        process(static_cast<float*>(audioData), numFrames);
        return oboe::DataCallbackResult::Continue;
    }
};

oboe::AudioStreamBuilder builder;
builder.setDirection(oboe::Direction::Output)
       .setPerformanceMode(oboe::PerformanceMode::LowLatency)
       .setSharingMode(oboe::SharingMode::Exclusive)
       .setFormat(oboe::AudioFormat::Float)
       .setChannelCount(oboe::ChannelCount::Stereo)
       .setSampleRate(48000)
       .setCallback(&engine);

std::shared_ptr<oboe::AudioStream> stream;
builder.openStream(stream);
stream->requestStart();
```

Android's audio HAL has historically been the worst of the major platforms for latency. Even with AAudio and exclusive mode, you should expect 10 to 30ms output latency on most devices, with a long tail of devices that do worse. The Oboe team maintains a database of per-device characteristics.

### PipeWire (Linux, modern)

PipeWire replaces both PulseAudio and (optionally) JACK on modern Linux distributions. It speaks JACK's protocol on the JACK port and PulseAudio's protocol on the Pulse port, so existing clients work unchanged. New clients can use the native PipeWire API for the lowest latency.

The native API exposes a process callback similar to JACK:

```cpp
#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>

static void onProcess(void* userdata) {
    auto* self = static_cast<MyEngine*>(userdata);
    pw_buffer* b = pw_stream_dequeue_buffer(self->stream);
    if (!b) return;
    spa_buffer* spa = b->buffer;
    auto* out = static_cast<float*>(spa->datas[0].data);
    int frames = spa->datas[0].maxsize / sizeof(float) / channels;
    self->process(out, frames);
    spa->datas[0].chunk->size = frames * channels * sizeof(float);
    pw_stream_queue_buffer(self->stream, b);
}
```

PipeWire's design promises uniform latency across all client types. As of 2026 it is the default on Fedora, Ubuntu, and most other major distributions.

### A Unified C++ Adapter

Every shipped cross-platform audio app writes a thin adapter layer that hides this. JUCE's `AudioIODeviceType` is one approach. RtAudio (Gary Scavone) is another, simpler one. miniaudio is a header-only C library with C++ bindings that is gaining ground for game and embedded use. Pick one, do not write your own unless you ship for a single platform.

The adapter pattern in C++ looks like:

```cpp
class IAudioCallback {
public:
    virtual ~IAudioCallback() = default;
    virtual void onAudio(float** inputs, float** outputs,
                         int numInputs, int numOutputs,
                         int numFrames, double sampleRate) noexcept = 0;
    virtual void onPrepare(double sampleRate, int maxBlockSize) = 0;
    virtual void onRelease() = 0;
};

class IAudioDevice {
public:
    virtual ~IAudioDevice() = default;
    virtual bool open(int sampleRate, int blockSize) = 0;
    virtual void close() = 0;
    virtual void setCallback(IAudioCallback*) = 0;
};
```

Each platform gets a concrete `IAudioDevice` subclass. The plugin or app code talks only to `IAudioCallback`, which is identical on every platform.

### RAII for Callback Registration

A subtle bug class in audio code is the lifetime mismatch between the callback registration and the C++ object the callback dispatches to. If the device tears down before the callback unregisters, you get a use-after-free on the audio thread, and that crashes the process. RAII solves this:

```cpp
class ScopedCallback {
    AudioUnit unit_;
public:
    ScopedCallback(AudioUnit u, AURenderCallbackStruct cb) : unit_(u) {
        AudioUnitSetProperty(unit_, kAudioUnitProperty_SetRenderCallback,
                             kAudioUnitScope_Input, 0, &cb, sizeof(cb));
    }
    ~ScopedCallback() {
        AURenderCallbackStruct empty = { nullptr, nullptr };
        AudioUnitSetProperty(unit_, kAudioUnitProperty_SetRenderCallback,
                             kAudioUnitScope_Input, 0, &empty, sizeof(empty));
    }
};
```

The destructor runs before the engine destructor, so the audio thread sees a null callback and the engine memory is safe to free.

---
