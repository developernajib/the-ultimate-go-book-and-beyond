## JUCE Framework Deep Dive

JUCE is the dominant cross-platform audio framework. Sound Radix acquired it from PACE (which had bought it from Raw Material Software) in 2024, and the framework has been on a steady release cadence with JUCE 8 (late 2024) introducing Direct2D rendering on Windows, modern WebView UIs, and cleanups across the audio classes. The vast majority of commercially sold audio plugins released on Windows and macOS in the last decade ship JUCE in their binary.

This section is the working knowledge a senior audio engineer needs to be productive in any JUCE codebase.

### The AudioProcessor Lifecycle

`juce::AudioProcessor` is the base class for every JUCE plugin. The host (DAW or standalone wrapper) calls a small set of methods in a fixed order. Get this contract wrong and your plugin will crash, glitch, or fail validation.

```cpp
class MyPlugin : public juce::AudioProcessor {
public:
    MyPlugin();
    ~MyPlugin() override;

    // Called once after construction, and again whenever sample rate
    // or block size changes. Allocate everything here.
    void prepareToPlay(double sampleRate, int maximumExpectedSamplesPerBlock) override;

    // Called when playback stops. Free or reset state here.
    void releaseResources() override;

    // The hot path. Called from the audio thread.
    void processBlock(juce::AudioBuffer<float>& buffer,
                      juce::MidiBuffer& midiMessages) override;

    // Called by the host to ask if a given channel layout is supported.
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;

    // Editor lifecycle.
    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    // State save and restore. Called on the message thread.
    void getStateInformation(juce::MemoryBlock& destData) override;
    void setStateInformation(const void* data, int sizeInBytes) override;

    // Plugin metadata.
    const juce::String getName() const override { return "MyPlugin"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    // Programs (presets exposed to the host).
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
};
```

The lifecycle in order:

1. Constructor on the message thread.
2. `setBusesLayout` queries on the message thread.
3. `prepareToPlay(sr, blockSize)` on the message thread, before any audio.
4. `processBlock` on the audio thread, repeated until playback stops.
5. `releaseResources` on the message thread.
6. `prepareToPlay` again if the user changes sample rate or block size.
7. Eventually `~MyPlugin()` on the message thread.

Hosts may call `prepareToPlay` and `releaseResources` multiple times in a session (every transport stop in some DAWs). All allocation lives in `prepareToPlay`. `processBlock` allocates nothing.

### AudioBuffer Layout

`juce::AudioBuffer<float>` is JUCE's planar buffer type. Each channel is a contiguous `float*`. Access:

```cpp
void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override {
    juce::ScopedNoDenormals noDenormals;
    const int numChannels = buffer.getNumChannels();
    const int numSamples  = buffer.getNumSamples();

    for (int ch = 0; ch < numChannels; ++ch) {
        float* data = buffer.getWritePointer(ch);
        for (int i = 0; i < numSamples; ++i) {
            data[i] = std::tanh(data[i] * drive_);
        }
    }
}
```

`buffer.getReadPointer(ch)` returns a `const float*`, used when you have separate input and output buffers. In-place processing (input and output buffer alias) is the default in plugin formats, so you usually use `getWritePointer` and overwrite.

`buffer.applyGain(channel, startSample, numSamples, gain)` and `buffer.addFrom(...)` provide vectorized helpers. `juce::dsp::AudioBlock<float>` wraps the buffer and supports the JUCE DSP module (`juce::dsp::IIR::Filter`, `juce::dsp::FFT`, etc.).

### Plugin Parameters with AudioProcessorValueTreeState

`AudioProcessorValueTreeState` (often abbreviated APVTS) is JUCE's parameter management system. It owns the parameters, exposes them to the host, supports automation, handles state save and restore, and provides atomic float pointers for the audio thread.

```cpp
class MyPlugin : public juce::AudioProcessor {
public:
    MyPlugin()
        : juce::AudioProcessor(BusesProperties()
              .withInput("Input", juce::AudioChannelSet::stereo(), true)
              .withOutput("Output", juce::AudioChannelSet::stereo(), true)),
          parameters(*this, nullptr, "Parameters", createParameterLayout())
    {
        gainParam = parameters.getRawParameterValue("gain");
        cutoffParam = parameters.getRawParameterValue("cutoff");
    }

    static juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout() {
        std::vector<std::unique_ptr<juce::RangedAudioParameter>> params;
        params.push_back(std::make_unique<juce::AudioParameterFloat>(
            "gain", "Gain",
            juce::NormalizableRange<float>(-60.0f, 12.0f, 0.1f), 0.0f));
        params.push_back(std::make_unique<juce::AudioParameterFloat>(
            "cutoff", "Cutoff",
            juce::NormalizableRange<float>(20.0f, 20000.0f, 0.0f, 0.3f), 1000.0f));
        return { params.begin(), params.end() };
    }

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override {
        juce::ScopedNoDenormals noDenormals;
        const float gainDb = gainParam->load();
        const float cutoff = cutoffParam->load();
        // ...
    }

private:
    juce::AudioProcessorValueTreeState parameters;
    std::atomic<float>* gainParam   = nullptr;
    std::atomic<float>* cutoffParam = nullptr;
};
```

`getRawParameterValue` returns a `std::atomic<float>*` that the audio thread can `load()` with no locks. The host writes to it through APVTS when automation moves, and the GUI also writes through APVTS bindings (`SliderAttachment`, `ComboBoxAttachment`, `ButtonAttachment`).

The `NormalizableRange` constructor with a skew factor (the `0.3f` in the cutoff example) creates a logarithmic taper, which is what you want for frequency, time, and most musical parameters.

### State Save and Restore

The host calls `getStateInformation` to ask for an opaque blob to persist with the project. It calls `setStateInformation` when the project reopens. APVTS gives this almost for free:

```cpp
void getStateInformation(juce::MemoryBlock& destData) override {
    auto state = parameters.copyState();
    std::unique_ptr<juce::XmlElement> xml(state.createXml());
    copyXmlToBinary(*xml, destData);
}

void setStateInformation(const void* data, int sizeInBytes) override {
    std::unique_ptr<juce::XmlElement> xml(getXmlFromBinary(data, sizeInBytes));
    if (xml && xml->hasTagName(parameters.state.getType())) {
        parameters.replaceState(juce::ValueTree::fromXml(*xml));
    }
}
```

For backward compatibility across plugin versions, version your state and migrate old shapes to the current shape inside `setStateInformation`. Pro Tools is particularly unforgiving here, a state restore that rejects an old session is a customer support ticket.

### ValueTree

`juce::ValueTree` is JUCE's hierarchical, copy-on-write, observable property tree. It is the model layer for almost any non-trivial JUCE app. Properties are `juce::var`, children are nested `ValueTree`s, listeners are notified on change.

```cpp
juce::ValueTree state("Synth");
state.setProperty("master_volume", 0.8f, nullptr);
auto voice = state.getOrCreateChildWithName("Voice", nullptr);
voice.setProperty("attack", 0.01f, nullptr);

class StateListener : public juce::ValueTree::Listener {
    void valueTreePropertyChanged(juce::ValueTree& vt, const juce::Identifier& id) override {
        // Called on the message thread. Not safe for audio-thread state directly.
    }
};
```

ValueTree changes are dispatched on the message thread, never on the audio thread. The pattern is: GUI mutates the ValueTree, a listener marshals the change into atomic parameter values that the audio thread reads.

### MessageManager and Threading

JUCE has a single message thread (the equivalent of the OS UI thread). All GUI work happens there. `juce::MessageManager::callAsync` posts a lambda from any thread to the message thread:

```cpp
juce::MessageManager::callAsync([this]() {
    statusLabel.setText("Done", juce::dontSendNotification);
});
```

Never call GUI methods from the audio thread. Never call `processBlock`-affecting setters from the GUI thread (atomic parameters and APVTS handle this).

### MIDI Buffer Iteration

`juce::MidiBuffer` is the per-block MIDI event container, sample-accurately ordered. Iterate:

```cpp
void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override {
    int blockStart = 0;
    for (const auto meta : midi) {
        const int eventTime = meta.samplePosition;
        const auto& msg = meta.getMessage();
        // Process audio up to eventTime
        renderRange(buffer, blockStart, eventTime - blockStart);
        // Apply event
        if (msg.isNoteOn())  noteOn(msg.getNoteNumber(), msg.getVelocity());
        if (msg.isNoteOff()) noteOff(msg.getNoteNumber());
        blockStart = eventTime;
    }
    // Render remainder
    renderRange(buffer, blockStart, buffer.getNumSamples() - blockStart);
}
```

This is the sample-accurate event handling pattern that every synth and MIDI-driven plugin uses.

### Editors and OpenGL

`AudioProcessorEditor` is the GUI base class. JUCE 8 brought Direct2D rendering on Windows for software rendering, with hardware acceleration available through `juce::OpenGLContext` attached to a top-level component. For plugins with heavy GUI work (oscilloscopes, spectrum analyzers, level meters), OpenGL is essential because the host's main thread runs at lower priority than the audio thread, and the host's compositor may throttle the plugin window.

```cpp
class MyEditor : public juce::AudioProcessorEditor, public juce::OpenGLAppComponent {
public:
    MyEditor(MyPlugin& p) : juce::AudioProcessorEditor(&p) {
        setOpaque(true);
        openGLContext.attachTo(*this);
        setSize(800, 480);
    }
    void initialize() override { /* compile shaders, build VBOs */ }
    void shutdown() override { /* free GL resources */ }
    void render() override { /* per-frame draw */ }
private:
    juce::OpenGLContext openGLContext;
};
```

JUCE 8 also added a WebView-based UI option (`juce::WebBrowserComponent`) so you can build the GUI in HTML/JS/CSS and bridge to the C++ processor. FabFilter, iZotope, and many newer plugins ship with this approach.

### JUCE 8 Audio Changes

JUCE 8 (late 2024) made several audio-relevant changes that any senior engineer should know:

- `juce::dsp::FFT` switched to a faster default backend on Apple Silicon by deferring to `vDSP`.
- `AudioProcessor::processBlockBypassed` is now strictly enforced for AAX, the legacy "ramp-then-pass" behavior is gone.
- `AudioProcessorValueTreeState` parameter listeners now run on the message thread without surprises.
- The Projucer can now generate CMake projects natively, alongside the legacy IDE projects.
- The `juce_dsp` module gained a refreshed convolution engine with partitioned uniform-block convolution by default.

### What to Read in JUCE Source

Three header reads will save you time:

1. `juce_AudioProcessor.h` for the full plugin lifecycle.
2. `juce_AudioProcessorValueTreeState.h` for parameter handling.
3. `juce_dsp/processors/juce_Convolution.h` for the partitioned convolution engine.

The JUCE codebase is well-commented and the project files include extensive demos under `examples/Audio/`.

---
