## Dolby Atmos and Spatial Audio

Spatial audio went from a cinema-only technology to a consumer feature on every iPhone in five years. Dolby Atmos masters now ship on Apple Music, Tidal, and Amazon HD. Apple Spatial Audio renders Atmos masters with head-tracking on AirPods. Sony 360 Reality Audio occupies a parallel slot on Tidal and Deezer. The senior engineer in the audio space needs to know how the math works, what the formats are, and where the rendering happens.

### Channel-Based vs Object-Based Audio

Traditional surround formats (5.1, 7.1) are channel-based: each output channel feeds a specific speaker at a specific location. The mixer pans sources to specific channels.

Object-based audio (Atmos, MPEG-H, Sony 360 RA) stores audio sources as objects with positional metadata. The renderer at playback time decides how to drive each speaker based on the listener's actual layout. A 7.1.4 mix delivered as Atmos plays correctly on a 5.1.2 system, on stereo, or on headphones with HRTF rendering.

A Dolby Atmos master consists of:

- A **bed**: typically 7.1.2 or 7.1.4 channel-based audio.
- Up to **128 audio objects**, each a mono audio stream plus per-frame positional metadata (azimuth, elevation, distance, size).
- Optional **dialnorm and trim** metadata for normalized loudness.

The master is delivered as ADM BWF (Broadcast Wave Format with Audio Definition Model XML metadata) or as Dolby's encoded streams (DD+ JOC for streaming, MAT 2.0 for HDMI/PCM transport).

### VBAP and Speaker Panning

Vector Base Amplitude Panning (Pulkki 1997) computes per-speaker gains for a virtual source given a speaker layout. For three speakers forming a triangle around the listener, find the barycentric coordinates of the source direction within the triangle:

```cpp
struct Speaker { float x, y, z; }; // unit vector

inline std::array<float, 3> vbap(const Speaker& s1, const Speaker& s2, const Speaker& s3,
                                 float vx, float vy, float vz) noexcept {
    // Solve [s1, s2, s3]^T * g = v for g, then normalize.
    float det = s1.x * (s2.y * s3.z - s2.z * s3.y)
              - s1.y * (s2.x * s3.z - s2.z * s3.x)
              + s1.z * (s2.x * s3.y - s2.y * s3.x);
    float g1 = (vx * (s2.y * s3.z - s2.z * s3.y)
              + vy * (s2.z * s3.x - s2.x * s3.z)
              + vz * (s2.x * s3.y - s2.y * s3.x)) / det;
    float g2 = (vx * (s3.y * s1.z - s3.z * s1.y)
              + vy * (s3.z * s1.x - s3.x * s1.z)
              + vz * (s3.x * s1.y - s3.y * s1.x)) / det;
    float g3 = (vx * (s1.y * s2.z - s1.z * s2.y)
              + vy * (s1.z * s2.x - s1.x * s2.z)
              + vz * (s1.x * s2.y - s1.y * s2.x)) / det;
    float norm = std::sqrt(g1 * g1 + g2 * g2 + g3 * g3);
    return { g1 / norm, g2 / norm, g3 / norm };
}
```

The Atmos renderer is a more sophisticated panner with frequency-dependent panning, near-field handling, and content-adaptive ducking. The proprietary parts are not public, but the math foundation is VBAP.

### Ambisonics

Ambisonics encodes a 3D sound field as a series of spherical harmonics. First-order ambisonic (FOA, B-format) uses 4 channels: W (pressure), X (front-back), Y (left-right), Z (up-down). Higher-order ambisonic (HOA) adds more harmonics: 9 channels for 2nd order, 16 for 3rd, 25 for 4th.

A point source at azimuth `theta` and elevation `phi` with amplitude `a` encodes to FOA as:

```cpp
struct AmbiB { float w, x, y, z; };

inline AmbiB encodeFoa(float a, float theta, float phi) noexcept {
    float ce = std::cos(phi);
    return {
        .w = a * 0.7071f,                       // 1/sqrt(2), N3D normalization differs
        .x = a * ce * std::cos(theta),
        .y = a * ce * std::sin(theta),
        .z = a * std::sin(phi),
    };
}
```

Decoders convert ambisonic to a specific speaker layout (a fixed matrix for that layout) or to binaural for headphones (HRTF convolution per ambisonic channel).

Ambisonics is the dominant format for VR audio (Oculus, Steam Audio, Resonance Audio) and for 360 video (YouTube uses 2nd-order ambisonics in spatial audio video files).

### HRTF and Binaural Rendering

Head-Related Transfer Functions (HRTFs) encode how a sound from a specific direction filters through the listener's head, ears, and torso before reaching each eardrum. Convolving a source with the appropriate HRIR (the time-domain version, Head-Related Impulse Response) for the left and right ears places the source at that direction in headphones.

```cpp
class HrtfRenderer {
    // Per-direction HRIRs. Typically thousands of measured directions.
    std::vector<std::vector<float>> hrirL_, hrirR_;
    PartitionedConvolver convL_, convR_;

public:
    void setSourceDirection(float azimuth, float elevation) {
        int idx = nearestHrir(azimuth, elevation);
        convL_.setIR(hrirL_[idx]);
        convR_.setIR(hrirR_[idx]);
    }
    void process(const float* in, float* outL, float* outR, int n) noexcept {
        convL_.process(in, outL, n);
        convR_.process(in, outR, n);
    }
};
```

HRIR datasets are distributed in SOFA format (Spatially Oriented Format for Acoustics, AES69 standard). The CIPIC, KEMAR (MIT), ARI, and SADIE datasets are the standard public references. Apple's Personalized Spatial Audio uses iPhone TrueDepth scans of the user's ears to pick a personalized HRTF from a proprietary set.

Real-time HRTF convolution on N ambisonic channels is N times more expensive than a single direct convolver. For first-order (4 channels) and short HRIRs (about 256 to 1024 samples) it fits a modern CPU comfortably. Higher orders need GPU or careful partitioning.

### Apple Spatial Audio

Apple Spatial Audio is the consumer-side rendering of Atmos masters on AirPods, Beats, and HomePod, with optional head tracking. The pipeline:

1. The Atmos master decodes to a bed plus objects on the source device (iPhone, Mac).
2. The audio system queries the connected playback device (AirPods report their model and capabilities).
3. For headphones, the system renders bed and objects through HRTF convolution. With head tracking, the head orientation rotates the source positions before HRTF lookup.
4. For HomePod, the system renders to the discovered speaker layout (single, stereo pair, AirPlay 2 multi-room).

Apple does not expose the renderer directly. Third-party apps requesting Spatial Audio use `AVAudioEnvironmentNode` with HRIR mode and let the OS handle the rest. For Atmos production, Apple's Logic Pro 11 includes the Apple-licensed Atmos renderer (a separate process named `AURenderer`).

### Sony 360 Reality Audio

Sony 360 RA is a parallel object-based format used on Tidal and Deezer. Technically MPEG-H 3D Audio with Sony's authoring extensions. Mixing tools include Sony's Architect (proprietary) and the third-party Spatial Sound Card. Adoption is smaller than Atmos.

### Production Tooling

Working on a spatial audio plugin or DAW integration in 2026 means knowing:

- **Dolby Atmos Renderer** (the licensed reference renderer, runs as a separate process on Mac and Windows, talks to Pro Tools and Nuendo via SEND).
- **Dolby Atmos Production Suite** (a software-only Atmos renderer for smaller studios).
- **Apple's Logic Atmos workflow** (Logic 11+ with built-in Atmos rendering, no external renderer needed).
- **Avid Pro Tools Atmos** (uses the external Dolby Renderer).
- **Steinberg Nuendo** for film/game post (also external Renderer).

For a plugin to participate in an Atmos session, it must accept and produce 7.1.2 or 7.1.4 channel layouts, or it must operate as an object-track plugin (mono in, mono out, with positional automation handled by the host).

### Practical Spatial Plugin Skeleton

```cpp
class SpatialPlugin : public juce::AudioProcessor {
public:
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override {
        // Accept stereo, 5.1, 7.1, 7.1.2, 7.1.4, ambisonic FOA.
        const auto& out = layouts.getMainOutputChannelSet();
        return out == juce::AudioChannelSet::stereo()
            || out == juce::AudioChannelSet::create5point1()
            || out == juce::AudioChannelSet::create7point1()
            || out == juce::AudioChannelSet::create7point1point2()
            || out == juce::AudioChannelSet::create7point1point4()
            || out == juce::AudioChannelSet::ambisonic(1)
            || out == juce::AudioChannelSet::ambisonic(3);
    }
    void processBlock(juce::AudioBuffer<float>& buf, juce::MidiBuffer&) override {
        // Per-channel processing depends on the layout.
        // For Atmos beds, the channel order matters and must match SMPTE.
    }
};
```

The key code review issue in Atmos plugins is channel order. Dolby uses SMPTE order (L, R, C, LFE, Ls, Rs, Lss, Rss, Tfl, Tfr, Tbl, Tbr for 7.1.4). Game-derived plugins often use Unity / Unreal order. Mismatched order produces audibly wrong surrounds in 100% of cases.

---
