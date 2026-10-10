## MIDI and Event Handling

MIDI (Musical Instrument Digital Interface) is the dominant control protocol for electronic music. MIDI 1.0 dates from 1983 and is still in use everywhere. MIDI 2.0 was ratified by the MIDI Manufacturers Association in 2020 and shipped first-party support on macOS and iOS in 2021. As of 2026 most professional gear supports MIDI 1.0, growing equipment supports MIDI 2.0, and DAWs are progressively adopting the new protocol.

### MIDI 1.0 Wire Format

MIDI 1.0 messages are 1 to 3 bytes. A status byte has the high bit set (0x80-0xFF), data bytes have the high bit clear (0x00-0x7F).

The channel voice messages:

```
0x80 nn vv   Note Off,    note nn,  velocity vv
0x90 nn vv   Note On,     note nn,  velocity vv (vv=0 means Note Off)
0xA0 nn pp   Polyphonic Aftertouch
0xB0 cc vv   Control Change, controller cc, value vv
0xC0 pp      Program Change, program pp
0xD0 pp      Channel Aftertouch
0xE0 ll mm   Pitch Bend, 14-bit value (mm << 7) | ll
```

The lower 4 bits of the status byte are the channel (1-16, encoded 0-15). System common and real-time messages (0xF0 and above) include SysEx, MTC, MMC, Song Position Pointer, and Active Sensing.

```cpp
struct Midi1Message {
    uint8_t status;
    uint8_t data1;
    uint8_t data2;

    bool isNoteOn()  const { return (status & 0xF0) == 0x90 && data2 != 0; }
    bool isNoteOff() const { return (status & 0xF0) == 0x80
                                || ((status & 0xF0) == 0x90 && data2 == 0); }
    int  channel()   const { return status & 0x0F; }
    int  noteNumber()const { return data1; }
    int  velocity()  const { return data2; }
};
```

JUCE's `juce::MidiMessage` wraps this with helpers (`isNoteOn`, `getNoteNumber`, etc.) and handles SysEx growing buffers.

### Sample-Accurate Event Scheduling

A MIDI event arrives at a moment in wall-clock time. The audio block being processed covers a span of samples corresponding to a span of wall-clock time. To play a note "on time," the event must be applied at the correct sample offset within the block, not at the block boundary.

The host delivers events with sample offsets:

```cpp
// JUCE
void processBlock(juce::AudioBuffer<float>& buf, juce::MidiBuffer& midi) override {
    int blockStart = 0;
    for (const auto meta : midi) {
        const int eventTime = meta.samplePosition;
        const auto& msg = meta.getMessage();
        renderRange(buf, blockStart, eventTime - blockStart);
        applyMidi(msg);
        blockStart = eventTime;
    }
    renderRange(buf, blockStart, buf.getNumSamples() - blockStart);
}
```

This sub-block iteration is what gives a software synthesizer the same timing tightness as hardware. A synth that applies events only at block boundaries will sound sloppy at large blocks.

### MIDI 2.0 Universal MIDI Packets

MIDI 2.0 uses 32-bit Universal MIDI Packets (UMP) with up to four 32-bit words per message. Major improvements over MIDI 1.0:

- **16-bit velocity** (was 7-bit).
- **32-bit controller values** (was 7-bit).
- **Per-note controllers** (independent expression per note in a chord).
- **Per-note pitch bend.**
- **More channels** (256 groups of 16 channels).
- **MIDI Capability Inquiry (MIDI-CI)** for negotiating profiles, property exchange, and process inquiry.
- **Profiles** (e.g., a piano profile defines a standard set of controllers and behaviors).

```cpp
struct Ump64 {
    uint32_t word0;
    uint32_t word1;
};

// Channel Voice 2.0 Note On (Message Type 4)
//   word0: 0x4 group(4) status(8) channel(4) note(8) attribute_type(8)
//   word1: velocity(16) attribute_data(16)
inline bool isNoteOn2(Ump64 ump) {
    uint8_t mt = (ump.word0 >> 28) & 0xF;
    uint8_t status = (ump.word0 >> 16) & 0xF0;
    return mt == 0x4 && status == 0x90;
}

inline uint16_t velocity2(Ump64 ump) {
    return (ump.word1 >> 16) & 0xFFFF;
}
```

Apple's CoreMIDI on macOS 11+ and iOS 14+ supports UMP natively. JUCE 7+ has `juce::UniversalMidiPacket` and translates between MIDI 1.0 and 2.0 transparently when the host and plugin negotiate.

VST3 added MIDI 2.0 support via `Vst::IMidiMapping2`. CLAP supports it natively through its event model. AAX has not (as of 2026).

### MPE (MIDI Polyphonic Expression)

MPE is a MIDI 1.0 convention (ratified 2018) that uses one MIDI channel per note, allowing per-note pitch bend, pressure, and a third dimension (often controller 74, slide). MPE was the bridge to MIDI 2.0's per-note expression and remains widely used because most existing synths and DAWs already understood MIDI 1.0.

Roli Seaboard, LinnStrument, Haken Continuum, Sensel Morph, and ROLI Lightpad are the canonical MPE controllers. Most modern synths (Equator, Arturia Pigments, Cherry Audio synths) support MPE natively.

### Sysex and Property Exchange

System Exclusive (SysEx) messages carry vendor-specific data with a manufacturer ID. Every synth's "send all parameters" dump is SysEx. MIDI 2.0 Property Exchange replaces SysEx with structured JSON-over-MIDI for capability negotiation, preset transfer, and live parameter mapping.

### Time Synchronization

For DAW sync and external hardware sync:

- **MTC (MIDI Time Code).** The MIDI equivalent of SMPTE timecode. Used for audio-to-video sync.
- **MMC (MIDI Machine Control).** Transport control: play, stop, locate, record. Sent as SysEx.
- **MIDI Clock.** 24 ticks per quarter note. Used for tempo sync between hardware sequencers, drum machines, and DAWs.
- **Song Position Pointer.** Used with MIDI Clock for absolute song position.

In a plugin, the host gives you transport state through `juce::AudioPlayHead::PositionInfo` (timeline position, BPM, time signature, playback state). A delay plugin synced to BPM reads this.

### Virtual MIDI Ports

OS-level virtual MIDI lets two apps exchange MIDI without hardware:

- **macOS:** IAC bus (built into Audio MIDI Setup), CoreMIDI virtual sources and destinations.
- **Windows:** loopMIDI (third party) or LoopBe1, since Windows has no built-in virtual MIDI driver.
- **Linux:** ALSA sequencer.
- **iOS:** MIDI Network sessions (RTP-MIDI over WiFi) and CoreMIDI virtual ports.

Network MIDI (RTP-MIDI, AES standard) and BLE-MIDI (Apple's contribution, BLE GATT-based) extend MIDI over wireless. BLE-MIDI is what your wireless MPE controllers use.

### A Lock-Free MIDI Queue

MIDI input arrives on a non-realtime thread. The audio thread needs to consume events sample-accurately. A lock-free SPSC queue is the standard channel:

```cpp
struct TimedMidi { uint64_t hostSampleTime; Midi1Message msg; };

class MidiInputQueue {
    SpscRingBuffer<TimedMidi, 1024> queue_;
public:
    // From MIDI input thread
    void push(uint64_t time, const Midi1Message& m) noexcept {
        TimedMidi t{ time, m };
        queue_.try_push(t);
    }
    // From audio thread
    void drainInto(juce::MidiBuffer& dest, uint64_t blockStartSample,
                   int blockNumSamples) noexcept {
        TimedMidi t;
        while (queue_.try_pop(t)) {
            int offset = static_cast<int>(t.hostSampleTime - blockStartSample);
            offset = std::clamp(offset, 0, blockNumSamples - 1);
            dest.addEvent(juce::MidiMessage(t.msg.status, t.msg.data1, t.msg.data2),
                          offset);
        }
    }
};
```

The audio thread drains the queue at the start of each block and merges with any host-provided MIDI events. The result is a single sample-accurate event list for the block.

### MIDI Files

A Standard MIDI File (SMF, .mid) stores a multi-track sequence with delta-time-tagged events. Format 0 is one merged track, format 1 is multiple tracks (the common case for DAW exports), format 2 is independent patterns (rare).

```cpp
// Reading: variable-length quantity (VLQ) for delta times.
inline uint32_t readVlq(const uint8_t*& p, const uint8_t* end) {
    uint32_t v = 0;
    while (p < end) {
        uint8_t b = *p++;
        v = (v << 7) | (b & 0x7F);
        if ((b & 0x80) == 0) return v;
    }
    return v;
}
```

JUCE's `juce::MidiFile` and `juce::MidiMessageSequence` read and write SMFs.

### Modern Status

The state of MIDI in production audio code as of 2026:

- **MIDI 1.0** is the lingua franca, every plugin must accept it.
- **MIDI 2.0** is supported on Apple platforms, by some new hardware, and by JUCE-based plugins. The transition is happening but slowly.
- **MPE** remains the dominant per-note expression model in shipped plugins.
- **OSC (Open Sound Control)** is used in art installations and Max patches but never replaced MIDI for music production.

The senior engineer ships MIDI 1.0 first and adds MIDI 2.0 when the host platform requests it.

---
