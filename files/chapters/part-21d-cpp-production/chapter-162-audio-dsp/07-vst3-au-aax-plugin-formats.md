## VST3, AU, AAX, CLAP Plugin Formats

A commercial plugin ships in four formats today: VST3 (Steinberg, the industry default), AU (Apple's AudioUnit, required for Logic and GarageBand and most macOS hosts), AAX (Avid, required for Pro Tools), and CLAP (the open-standard newcomer, supported by Bitwig, Reaper, Studio One, FL Studio, and growing). Each has its own SDK, its own threading rules, its own parameter model, and its own validator.

The professional approach is one C++ DSP core, one set of format-specific glue layers. JUCE and iPlug2 both implement this fan-out for you. Understanding what each format expects from below the framework layer is what separates a plugin developer from a senior plugin engineer.

### VST3

VST3 (Steinberg, current SDK 3.7.x as of 2026) replaced VST2 (which Steinberg discontinued for new products in 2018). The model is fully component-based:

- `IAudioProcessor` is the audio component.
- `IEditController` is the GUI and parameter controller.
- They communicate through `IConnectionPoint` messages.
- Parameters are `Vst::ParamID` (a uint32) with normalized values in `[0.0, 1.0]`.

```cpp
#include <public.sdk/source/vst/vstaudioeffect.h>

class MyVST3Processor : public Steinberg::Vst::AudioEffect {
public:
    MyVST3Processor() {
        setControllerClass(kMyControllerUID);
    }

    Steinberg::tresult PLUGIN_API initialize(Steinberg::FUnknown* context) override {
        auto result = AudioEffect::initialize(context);
        if (result != Steinberg::kResultOk) return result;
        addAudioInput(STR16("Stereo In"), Steinberg::Vst::SpeakerArr::kStereo);
        addAudioOutput(STR16("Stereo Out"), Steinberg::Vst::SpeakerArr::kStereo);
        return Steinberg::kResultOk;
    }

    Steinberg::tresult PLUGIN_API setupProcessing(Steinberg::Vst::ProcessSetup& setup) override {
        return AudioEffect::setupProcessing(setup);
    }

    Steinberg::tresult PLUGIN_API process(Steinberg::Vst::ProcessData& data) override {
        // Read parameter changes, sample-accurate.
        if (auto* paramChanges = data.inputParameterChanges) {
            int32 numParams = paramChanges->getParameterCount();
            for (int32 i = 0; i < numParams; ++i) {
                auto* queue = paramChanges->getParameterData(i);
                Steinberg::Vst::ParamID id = queue->getParameterId();
                // Iterate sample-accurate points and apply.
            }
        }
        // Audio buffers in data.inputs[0].channelBuffers32 / outputs[0].channelBuffers32
        return Steinberg::kResultOk;
    }
};
```

VST3's strength is sample-accurate parameter automation. The host delivers a list of `(sampleOffset, value)` points per parameter per block, and the plugin can apply each point at the exact sample index. JUCE's APVTS hides this and gives you a smoothed value.

The VST3 SDK is available under a dual GPL3 / commercial license from Steinberg's GitHub.

### AU (AudioUnit)

Apple's AudioUnit comes in two generations: AUv2 (the original, plain C API) and AUv3 (introduced in macOS 10.11 / iOS 9, App Extension based, sandboxed).

**AUv2** is a `ComponentDescription` registered with the system, identified by `manufacturer / type / subtype` four-CCs. The render block is a `AURenderCallback`. AUv2 plugins live in `~/Library/Audio/Plug-Ins/Components/` as `.component` bundles.

**AUv3** plugins are App Extensions. They ship inside a host app, are sandboxed, and can run on iOS as well as macOS. The bundle is a `.appex` and the plugin class subclasses `AUAudioUnit`:

```cpp
@interface MyAU : AUAudioUnit
@end

@implementation MyAU {
    std::unique_ptr<MyDspCore> dsp;
}

- (AUInternalRenderBlock)internalRenderBlock {
    __block auto* core = dsp.get();
    return ^AUAudioUnitStatus(AudioUnitRenderActionFlags* flags,
                              const AudioTimeStamp* ts,
                              AVAudioFrameCount frames,
                              NSInteger output,
                              AudioBufferList* outBufList,
                              const AURenderEvent* events,
                              AURenderPullInputBlock pull) {
        // pull input if needed, run DSP
        AudioBufferList inBufList;
        pull(flags, ts, frames, 0, &inBufList);
        core->process(&inBufList, outBufList, frames);
        return noErr;
    };
}
@end
```

Parameters are `AUParameter` instances grouped under an `AUParameterTree`. Sample-accurate event delivery uses `AURenderEvent` linked lists embedded in the render block.

AUv3 plugins also support MIDI input and output through `AUAudioUnit.MIDIOutputEventBlock` and the `MIDIOutputNames` property, which is how iOS music apps plumb MIDI between AUs.

### AAX (Avid Audio eXtension)

AAX is required for Pro Tools, the dominant DAW in professional film and music post-production. The SDK (`AAX_SDK_2.x`) is licensed by Avid, you sign an NDA and a developer agreement to access it. Pro Tools also requires that plugins be code-signed with a PACE iLok certificate, which adds a per-plugin license check at runtime.

The core AAX class is `AAX_CEffectParameters` for the algorithm and `AAX_CEffectGUI` for the UI. The render entry point is:

```cpp
void RenderAudio(AAX_SInstrumentRenderInfo* info) noexcept {
    const int32_t numSamples = *info->mNumSamples;
    const float* in  = info->mAudioInputs[0];
    float* out       = info->mAudioOutputs[0];
    // Process. AAX requires absolute realtime safety in this method.
}
```

AAX is the strictest format on real-time safety. Pro Tools runs on a "DAE" (Digital Audio Engine) that pre-empts plugins on a per-sample-block basis, and any deadline miss can take down the host. The Avid plugin validator (`PT_PrePackager`) instruments your binary and traps `malloc`, file I/O, and other forbidden calls.

AAX plugins also have to handle automatic delay compensation (ADC) precisely, the host queries `AAX_eProperty_LatencyContribution` and expects every output sample to lag the input by exactly that many samples. Mismatches manifest as comb filtering when parallel buses are summed.

### CLAP

CLAP (CLever Audio Plug-in) is the open-standard plugin format, jointly developed by Bitwig and u-he (Urs Heckmann), released in 2022 and adopted rapidly. As of 2026, CLAP is supported by Bitwig, Reaper, Studio One 6.5+, FL Studio (announced), Renoise, MultitrackStudio, and is gaining ground in Linux DAWs (Ardour). Steinberg has not adopted it. Apple has not adopted it. But it is the default secondary format for new plugin developers because the SDK is permissively licensed (MIT) and the design is modern.

The CLAP API is C, designed to be wrappable in any language:

```cpp
#include <clap/clap.h>

static const clap_plugin_descriptor_t my_descriptor = {
    .clap_version = CLAP_VERSION_INIT,
    .id = "com.example.myplugin",
    .name = "My Plugin",
    .vendor = "Example",
    .url = "https://example.com",
    .features = (const char*[]){ CLAP_PLUGIN_FEATURE_AUDIO_EFFECT, nullptr },
};

static clap_process_status process(const clap_plugin_t* plugin,
                                   const clap_process_t* p) {
    auto* self = static_cast<MyPlugin*>(plugin->plugin_data);
    // p->in_events is a sample-accurate event list.
    // p->audio_inputs[0].data32[ch] is each channel.
    self->process(p);
    return CLAP_PROCESS_CONTINUE;
}
```

CLAP's design improvements over VST3:

- **Per-note expression** baked into the event model from day one (per-note pitch bend, brightness, pressure, vibrato), making CLAP a natural target for MPE and MIDI 2.0 controllers.
- **Polyphonic modulation** as a first-class concept, voices can have independent parameter values.
- **Thread pool extension** lets the host offer worker threads to the plugin for parallel processing of independent voices.
- **Note ports** distinct from parameter ports.
- **No-allocation contract** for the audio thread, explicit in the spec.

JUCE 8 added experimental CLAP support. iPlug2 has had CLAP for longer. clap-juce-extensions is the de facto bridge that wraps a JUCE plugin as a CLAP without a code rewrite.

### A Shared C++ Core

The professional codebase structure:

```
my_plugin/
  core/                    # Format-agnostic C++ DSP
    Engine.h
    Engine.cpp             // The DSP. Knows nothing about hosts.
    Parameters.h           // ParamId enum + ranges.
  formats/
    vst3/                  // VST3 wrapper
    au/                    // AUv2 + AUv3 wrappers
    aax/                   // AAX wrapper
    clap/                  // CLAP wrapper
    standalone/            // CLI test harness
```

`Engine` exposes a small interface:

```cpp
class Engine {
public:
    void prepare(double sampleRate, int maxBlockSize);
    void release();
    void setParameter(ParamId id, float normalizedValue);
    float getParameter(ParamId id) const;
    void process(const float* const* inputs,
                 float* const* outputs,
                 int numChannels, int numFrames,
                 const NoteEvent* events, int numEvents) noexcept;
};
```

Each format wrapper translates from the host's parameter model and event model into `Engine` calls. The DSP code has no `#include <vst3/...>` and no `#include <AAX_...>`. This is the only structure that scales to maintaining a plugin across all four formats.

### Parameter Automation Models

A subtle topic that catches engineers out:

- **VST3:** Sample-accurate, `IParameterChanges` queues with `(sampleOffset, value)` pairs.
- **AUv3:** Sample-accurate, `AURenderEvent` linked list embedded in the render block.
- **AAX:** Per-block, with optional sub-block resolution via `AAX_eProperty_RealTimePost`. Automation is delivered as a chunk per render call, not as inline events.
- **CLAP:** Sample-accurate, event list with per-event sample offsets.

A plugin that supports sample-accurate automation in all four formats has to either ramp internally to the next event in VST3/CLAP/AUv3 (and just use the block-level value in AAX), or ignore sample accuracy and use block-rate parameters everywhere. JUCE's APVTS picks the latter for portability.

### Validation

Every format has a validator. Run all of them in CI:

- VST3: Steinberg's `validator` binary in the SDK, plus PluginDoctor (free third-party).
- AUv3: Apple's `auval -v aufx Mefn Manu` (where `aufx`, `Mefn`, `Manu` are your codes).
- AAX: Avid's `PT_PrePackager` and the standalone `AAXValidator`.
- CLAP: `clap-validator` (open-source).

A plugin that fails validation is a plugin that will not pass certification. Treat validator output as compile errors.

---
