## Voice Codecs: Opus, AAC, MP3

Audio codecs reduce the bit rate of audio for storage or transmission. Voice codecs add aggressive perceptual coding tuned for speech. Music codecs prioritize transparency at moderate to high bit rates. The senior engineer building real-time voice or media products needs to know the codec families, their licensing, their CPU costs, and their integration patterns.

### Opus

Opus (RFC 6716, 2012) is the dominant open codec for real-time voice. Developed jointly by Xiph (the Vorbis people) and Skype, it merges SILK (speech-optimized, from Skype) and CELT (low-latency music codec, from Xiph) into a single codec that switches modes based on content.

Properties:

- **Frame sizes:** 2.5, 5, 10, 20, 40, or 60 ms. 10 or 20 ms is the standard for voice.
- **Bitrate:** 6 kbps to 510 kbps. 16-32 kbps is excellent for voice. 64-96 kbps is excellent for stereo music.
- **Sample rates:** 8, 12, 16, 24, 48 kHz. The encoder always works internally at 48 kHz and resamples.
- **Latency:** As low as 5ms algorithmic with a 2.5ms frame. Typical voice configuration is 20ms frames with about 20ms total delay.
- **Royalty-free.** No license fees. The dominant codec for WebRTC, Discord, Zoom (the Opus track), Microsoft Teams (Satin in addition), Mumble, Jitsi.

```cpp
#include <opus/opus.h>

class OpusVoiceEncoder {
    OpusEncoder* enc_ = nullptr;
public:
    OpusVoiceEncoder(int sampleRate, int channels) {
        int err = 0;
        enc_ = opus_encoder_create(sampleRate, channels,
                                   OPUS_APPLICATION_VOIP, &err);
        if (err != OPUS_OK) throw std::runtime_error("opus init failed");
        opus_encoder_ctl(enc_, OPUS_SET_BITRATE(24000));
        opus_encoder_ctl(enc_, OPUS_SET_INBAND_FEC(1));
        opus_encoder_ctl(enc_, OPUS_SET_PACKET_LOSS_PERC(10));
        opus_encoder_ctl(enc_, OPUS_SET_DTX(1));
    }
    ~OpusVoiceEncoder() { if (enc_) opus_encoder_destroy(enc_); }

    int encode(const float* pcm, int frameSize, uint8_t* out, int outMax) noexcept {
        return opus_encode_float(enc_, pcm, frameSize, out, outMax);
    }
};

class OpusVoiceDecoder {
    OpusDecoder* dec_ = nullptr;
public:
    OpusVoiceDecoder(int sampleRate, int channels) {
        int err = 0;
        dec_ = opus_decoder_create(sampleRate, channels, &err);
    }
    ~OpusVoiceDecoder() { if (dec_) opus_decoder_destroy(dec_); }
    int decode(const uint8_t* data, int len, float* pcm, int frameSize, int fec) noexcept {
        return opus_decode_float(dec_, data, len, pcm, frameSize, fec);
    }
    int decodePLC(float* pcm, int frameSize) noexcept {
        return opus_decode_float(dec_, nullptr, 0, pcm, frameSize, 0);
    }
};
```

Opus features worth knowing:

- **Inband FEC** redundantly encodes the previous frame in the current frame. The decoder can recover one lost frame at the cost of about 30% bitrate increase.
- **DTX** (Discontinuous Transmission) sends silence frames as a tiny "comfort noise" packet, saving uplink bandwidth during silence.
- **PLC** (Packet Loss Concealment) generates plausible audio when a frame is missing, called by passing `nullptr` to `opus_decode`.
- **Low-delay mode** via `OPUS_SET_APPLICATION(OPUS_APPLICATION_RESTRICTED_LOWDELAY)` and 2.5ms frames is used for live music and broadcast contribution feeds (Comrex, Tieline).

For voice telephony in 2026, Opus is the default unless there is a specific reason to use something else.

### AAC

Advanced Audio Coding (ISO/IEC 14496-3) is the dominant codec for music delivery. Multiple profiles:

- **AAC-LC** (Low Complexity), the universal baseline. Used in iTunes, YouTube, broadcast.
- **HE-AAC v1** (AAC + SBR, Spectral Band Replication). Better at low bitrates by replicating high-frequency content from low-frequency content.
- **HE-AAC v2** (AAC + SBR + PS, Parametric Stereo). Encodes stereo as mono + spatial parameters at very low bitrates (16-32 kbps).
- **xHE-AAC** (Extended HE-AAC, MPEG-D USAC). Combines AAC and Opus-style techniques. Variable bitrate, range from speech to high-quality music. Used by Apple Music for low-bandwidth streaming and by Netflix for some streams.

AAC is patent-encumbered. Decoding is freely licensed in most jurisdictions, encoding requires a license from Via Licensing (the patent pool) for commercial products. Apple, Google, and Mozilla have negotiated wide licenses for browsers and OSes.

Encoders:

- **FDK-AAC** (Fraunhofer's open-source encoder, with a license that allows binary distribution but not the GPL).
- **Apple Core Audio AAC** (the highest-quality encoder for AAC-LC and HE-AAC, only available on Apple platforms via `AudioConverter`).
- **Intel IPP** for x86.

```cpp
// On Apple platforms via Core Audio.
#include <AudioToolbox/AudioToolbox.h>

AudioConverterRef converter;
AudioStreamBasicDescription src{}, dst{};
src.mSampleRate = 48000;
src.mFormatID = kAudioFormatLinearPCM;
src.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
src.mChannelsPerFrame = 2;
src.mBitsPerChannel = 32;
src.mFramesPerPacket = 1;
src.mBytesPerFrame = src.mBytesPerPacket = 8;

dst.mSampleRate = 48000;
dst.mFormatID = kAudioFormatMPEG4AAC;
dst.mChannelsPerFrame = 2;
dst.mFramesPerPacket = 1024;

AudioConverterNew(&src, &dst, &converter);
UInt32 bitrate = 128000;
AudioConverterSetProperty(converter, kAudioConverterEncodeBitRate,
                          sizeof(bitrate), &bitrate);
```

For streaming applications targeting Apple's ecosystem (FairPlay, Apple Music), Apple's encoder is mandatory because Apple Music's "Mastered for iTunes" certification requires it.

### MP3

MPEG-1/2 Audio Layer III is the legacy music codec, ubiquitous since 1995. Patents expired in 2017 (US) and 2012 (EU), so MP3 is now royalty-free. AAC is technically superior at every bitrate and has displaced MP3 in new products. MP3 remains in legacy archives, podcast distribution (where compatibility trumps quality), and some broadcast workflows.

The reference open encoder is LAME (`libmp3lame`). For decoding, `mpg123` and `minimp3` (single-file public domain decoder) are common.

For new products, do not choose MP3. Use AAC for music or Opus for voice.

### FFmpeg as a Codec Hub

`libavcodec` (part of FFmpeg) wraps essentially every codec under one C API. For applications that need to handle multiple codecs (a media player, a transcoder, a recording app that ingests user files), FFmpeg is the de facto C++ integration point.

```cpp
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libswresample/swresample.h>
}

class CodecDecoder {
    AVCodecContext* ctx_ = nullptr;
    SwrContext* swr_ = nullptr;
public:
    bool open(AVCodecID id) {
        const AVCodec* c = avcodec_find_decoder(id);
        if (!c) return false;
        ctx_ = avcodec_alloc_context3(c);
        if (avcodec_open2(ctx_, c, nullptr) < 0) return false;
        return true;
    }
    int decode(const uint8_t* in, int inSize, float* out, int outFrames) noexcept {
        AVPacket pkt{}; pkt.data = const_cast<uint8_t*>(in); pkt.size = inSize;
        if (avcodec_send_packet(ctx_, &pkt) < 0) return -1;
        AVFrame* frame = av_frame_alloc();
        int ret = avcodec_receive_frame(ctx_, frame);
        // Resample to float if necessary, then copy.
        av_frame_free(&frame);
        return ret;
    }
};
```

FFmpeg is LGPL by default, GPL with `--enable-gpl`. Most commercial products that ship FFmpeg take the LGPL branch and dynamic-link.

### Lyra and ML Codecs

Lyra (Google, 2021+) is a neural-network-based voice codec achieving intelligible voice at 3 kbps and good voice at 6 kbps. The decoder runs a small generative model on each side and the encoder transmits a compact feature embedding. Used in Google Meet's "low bandwidth" mode and on Android.

Lyra v2 (2023) updated the architecture. In 2026 the codec is still in production use but its open-source release is partial (decoder reference, encoder less so), and its CPU cost on the audio thread is non-trivial (about 5-10% on a modern phone for decode).

Encodec (Meta, 2022) and SoundStream (Google, 2021) are research codecs in the same family, not yet shipping in consumer products.

The senior engineer should note: ML-based codecs are not (yet) drop-in replacements for Opus in real-time pipelines because the inference cost is unpredictable and the training data biases manifest as distorted output for out-of-distribution signals.

### Choosing for Production

| Use case | Codec choice |
|---|---|
| Voice (VoIP, conferencing) | Opus 16-32 kbps, FEC on, DTX on |
| Music streaming (high quality) | AAC-LC 256 kbps or Opus 256 kbps |
| Music streaming (low bandwidth) | xHE-AAC or Opus at 64 kbps |
| Podcast distribution | AAC-LC 96 kbps or MP3 128 kbps for compatibility |
| Game voice chat | Opus 24 kbps with FEC |
| Apple ecosystem (Apple Music, AirPlay) | AAC-LC at minimum, ALAC for lossless |
| Broadcast contribution | Opus low-delay or AAC-LD |
| Browser-to-browser realtime | Opus (WebRTC) |

### Latency Budget for Codec Round Trip

A typical voice path:

```
mic capture (5-15ms) -> echo cancel (10ms lookahead) -> encode (20ms frame)
-> network (50-150ms typical, much worse on bad links)
-> jitter buffer (40-200ms adaptive)
-> decode (5ms) -> playback (5-15ms)
```

Total mouth-to-ear typically 150-300ms on a healthy connection. Below 150ms feels natural. Above 400ms participants start talking over each other. The ITU recommends sub-150ms for good voice.

The codec is rarely the bottleneck. The jitter buffer and the network path dominate. Sub-section 17 covers WebRTC's full chain.

---
