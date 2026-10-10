## Game Audio Middleware

Game audio is its own world. The audio engineer ships not a plugin but a runtime that loads thousands of sound assets, dispatches them in response to gameplay events, applies dynamic mixing based on game state, and renders to whatever output the player has (stereo, headphones, 5.1, Dolby Atmos for headphones, native speakers). The two products that dominate are Wwise (Audiokinetic) and FMOD (Firelight Technologies), with Unreal MetaSound and Unity's native audio for engine-bundled options.

### Wwise

Wwise is the licensed AAA-game audio middleware, used in Assassin's Creed, Fortnite, Cyberpunk 2077, Call of Duty, and most other major titles. The C++ runtime is `AK::SoundEngine`. The authoring tool is a separate Windows/macOS application where sound designers build the asset hierarchy.

Core concepts:

- **Events** are named entry points. The game calls `AK::SoundEngine::PostEvent("Play_Footstep", gameObjectID)` and Wwise plays whatever the sound designer assigned.
- **Game objects** are entities in the world (player, NPCs, environmental sources). Each has 3D position, velocity, and game parameters.
- **RTPCs (Real-Time Parameter Controls)** map game variables to audio parameters. Health to filter cutoff, distance to volume, etc.
- **States and switches** are global conditions (combat / explore, indoor / outdoor) that change which assets play.
- **Soundbanks** are loaded asset packs.

```cpp
#include <AK/SoundEngine/Common/AkSoundEngine.h>

void initWwise() {
    AkMemSettings memSettings;
    AK::MemoryMgr::GetDefaultSettings(memSettings);
    AK::MemoryMgr::Init(&memSettings);

    AkStreamMgrSettings streamSettings;
    AK::StreamMgr::GetDefaultSettings(streamSettings);
    AK::StreamMgr::Create(streamSettings);

    AkInitSettings initSettings;
    AkPlatformInitSettings platformSettings;
    AK::SoundEngine::GetDefaultInitSettings(initSettings);
    AK::SoundEngine::GetDefaultPlatformInitSettings(platformSettings);
    AK::SoundEngine::Init(&initSettings, &platformSettings);
}

void update(float dt) {
    AkSoundPosition pos;
    pos.SetPosition(player.x, player.y, player.z);
    pos.SetOrientation({0,0,1}, {0,1,0});
    AK::SoundEngine::SetPosition(playerObjectID, pos);
    AK::SoundEngine::RenderAudio();
}

void onFootstep() {
    AK::SoundEngine::PostEvent(AK::EVENTS::PLAY_FOOTSTEP, playerObjectID);
}
```

Wwise's lower-level features that senior engineers use:

- **Source plugins** for procedural audio (custom synthesizers).
- **Effect plugins** for custom DSP (the Wwise plugin SDK is C++).
- **Audio device plugins** for non-standard outputs.
- **Custom mixers** for special routing.

Wwise plugins are full-fledged C++ DSP modules, just with a Wwise-specific lifecycle. The DSP rules from earlier sections still apply.

### FMOD Studio

FMOD is the other major commercial middleware, used in Hollow Knight, Celeste, Forza Horizon, and many other titles. The runtime API is `FMOD::Studio::System` (event-based, equivalent to Wwise) and `FMOD::System` (lower-level, equivalent to Wwise's Sound API).

```cpp
#include <fmod_studio.hpp>
#include <fmod.hpp>

FMOD::Studio::System* system;
FMOD::Studio::System::create(&system);
system->initialize(1024, FMOD_STUDIO_INIT_NORMAL, FMOD_INIT_NORMAL, nullptr);

FMOD::Studio::Bank* masterBank;
system->loadBankFile("Master.bank", FMOD_STUDIO_LOAD_BANK_NORMAL, &masterBank);

FMOD::Studio::EventDescription* desc;
system->getEvent("event:/SFX/Footstep", &desc);
FMOD::Studio::EventInstance* instance;
desc->createInstance(&instance);

instance->set3DAttributes(/* FMOD_3D_ATTRIBUTES with position, velocity, etc. */);
instance->start();

system->update();
```

FMOD differs from Wwise in licensing (FMOD has a generous indie tier, free up to a budget threshold), in the authoring tool (FMOD Studio is generally easier for small teams), and in some technical details (FMOD's snapshot system for ducking, Wwise's bus structure). For shipping a game in 2026, the choice between Wwise and FMOD comes down to studio preference and existing knowledge more than capability.

### Unity Native Audio Plugin SDK

Unity's audio is built on FMOD (a custom in-house build) plus the Native Audio Plugin SDK for custom DSP. A native audio plugin is a C/C++ DLL exposing a fixed set of callbacks:

```cpp
#include "AudioPluginUtil.h"

extern "C" UNITY_AUDIODSP_EXPORT_API
int UnityGetAudioEffectDefinitions(UnityAudioEffectDefinition*** definition) {
    static UnityAudioEffectDefinition def;
    def.structsize = sizeof(UnityAudioEffectDefinition);
    def.paramstructsize = sizeof(UnityAudioParameterDefinition);
    def.apiversion = UNITY_AUDIO_PLUGIN_API_VERSION;
    def.pluginversion = 0x010100;
    def.channels = 2;
    def.numparameters = NumParams;
    def.create = CreateCallback;
    def.process = ProcessCallback;
    def.release = ReleaseCallback;
    static UnityAudioEffectDefinition* defPtr = &def;
    *definition = &defPtr;
    return 1;
}

UNITY_AUDIODSP_RESULT UNITY_AUDIODSP_CALLBACK ProcessCallback(
    UnityAudioEffectState* state,
    float* in, float* out,
    unsigned int frames,
    int inChannels, int outChannels) {
    // Per-block DSP. Same realtime rules apply.
    return UNITY_AUDIODSP_OK;
}
```

Used for spatializers, ambisonics decoders, custom reverbs, and procedural audio. The SDK is open and freely available from Unity.

### Unreal MetaSound

Unreal Engine 5 introduced MetaSound, a node-graph audio synthesis system that replaced the older SoundCue system. MetaSound nodes are C++ classes that the engine can connect into graphs at runtime. Custom nodes are written by inheriting from `Metasound::IOperator`:

```cpp
class FMyOscillatorOperator : public Metasound::TExecutableOperator<FMyOscillatorOperator> {
public:
    static const Metasound::FNodeClassMetadata& GetNodeInfo();
    static Metasound::FVertexInterface DeclareVertexInterface();
    void Execute() {
        const float* freq = FrequencyInput->GetReadPointer();
        float* out = AudioOutput->GetWritePointer();
        for (int32 i = 0; i < NumFrames; ++i) {
            // Generate sample using freq[i] for FM-style modulation.
        }
    }
};
```

MetaSound supports per-sample audio rate parameters (control rate parameters update once per block, audio rate parameters update every sample), making it suitable for FM and modular-style synthesis inside a game.

For a senior audio engineer at Epic or a UE-using studio, MetaSound is the place where custom DSP integrates into the engine.

### Occlusion and Obstruction

Game audio differs from music plugin audio in needing to model how the environment changes the sound:

- **Occlusion:** A wall between the source and the listener. Reduces direct sound and reverb tail.
- **Obstruction:** A wall between source and listener but not blocking the room reflections. Reduces direct sound, leaves reverb.

The game engine raycasts from listener to source and feeds occlusion / obstruction values to Wwise or FMOD as RTPCs, which the sound designer maps to filter cutoffs and gain reductions.

### Distance Attenuation

Linear, logarithmic, or sound-designer-authored curves. A typical curve attenuates 6 dB per doubling of distance for direct sound, with a custom curve for reverb send. Air absorption (a high-frequency rolloff increasing with distance) makes far sources sound dull.

### Dynamic Mixing and Ducking

When dialogue plays, the music ducks. When an explosion fires, the foley ducks. Wwise and FMOD both have side-chain mechanisms (bus to bus, snapshot to snapshot) that game-side code triggers based on game state.

### Spatializers

For VR and headphone listening, every source is spatialized through HRTF or ambisonic. Wwise has a built-in spatializer plugin and integrates with Microsoft's Spatial Sound, Oculus Audio SDK, Steam Audio, and Apple Spatial Audio. FMOD has Resonance Audio (Google) and Steam Audio integrations.

For Apple's Spatial Audio on Vision Pro, the game submits PCM streams with positional metadata via `AVAudioEngine` and the system handles HRTF with head tracking.

### Audio LOD

Like graphics, audio scales by level of detail:

- **Voice limits** prevent more than N simultaneous instances of any one sound.
- **Audibility culling** silences sources too far or too quiet to matter.
- **Quality LOD** swaps a procedural model for a stem at distance, or swaps a high-quality reverb for a cheap one in non-focal areas.

Wwise has a built-in voice manager that handles voice limits and culling. Custom code can layer on top for game-specific decisions.

### CPU Budgets

Game audio runs alongside the rest of the game's frame. The audio thread on a console title typically gets one core, with budget split between Wwise/FMOD and any custom DSP. A AAA console game allocates 5-15% of one core to audio. A mobile game allocates less and uses fewer voices.

### Native Audio in Unreal vs Wwise

Unreal teams often debate "native MetaSound" vs Wwise. Tradeoffs:

- **MetaSound** is in-engine, has no extra licensing, integrates tightly with the editor, and supports modular synthesis. Less mature for AAA-scale mixing workflows.
- **Wwise** is industry-standard for large teams, has a sophisticated bus system, and has a separate editor that audio designers prefer. Costs licensing fees per platform.

A team starting a project today picks based on team size, target platforms, and audio designer preference. Both are mature.

---
