## 159.13 WebRTC Stack

WebRTC is the real-time communication stack: peer-to-peer audio, video, and data channels with sub-second latency. It powers Google Meet, Discord, Microsoft Teams web client, Zoom web, Slack huddles, and most browser-based video calling. The C++ implementation is libwebrtc, lives in Chromium at `third_party/webrtc/`, and is also a separate repo at `webrtc.googlesource.com/src`.

### Scope

libwebrtc is roughly 1.2 million lines of C++. It implements:

- Media engine: audio and video capture, encode, decode, render.
- RTP/RTCP packetization, jitter buffer, FEC, retransmissions.
- Codecs: Opus (audio), VP8, VP9, AV1, H.264 (video, optional licenses).
- Echo cancellation (AEC3), noise suppression, automatic gain control.
- Transport: ICE, STUN, TURN for NAT traversal.
- Security: DTLS-SRTP for media, DTLS for data channels.
- Bandwidth estimation: GCC (Google Congestion Control) and BBR variants.
- SDP parsing and negotiation.

### High-Level Architecture

```
JavaScript:  RTCPeerConnection
                  |
                  v  (Mojo / direct call in renderer)
              PeerConnection (libwebrtc)
                  |
        +---------+----------+
        |                    |
        v                    v
  MediaEngine          P2PTransportChannel (ICE)
  (audio + video)             |
        |                     v
        v                  DTLS Transport
  RtpSender / RtpReceiver     |
        |                     v
        +-----> SrtpTransport (encrypted media)
                              |
                              v
                          Network (UDP)
```

PeerConnection is the central object. Inside it:

- `Call`: the media graph. One `VideoSendStream` per outgoing video, one `AudioSendStream` per outgoing audio, mirrored on the receive side.
- `RtpTransport`: the SRTP-encrypted RTP bus.
- `IceTransport` and `DtlsTransport`: layered transports.
- `MediaSession`: tracks the SDP-level session description.

### Media Pipeline

For an outgoing video stream:

```
Camera frame  ->  VideoSource
              ->  VideoEncoder (VP8 / VP9 / AV1)
              ->  RTPPacketizer (split into RTP packets)
              ->  RTCPSender / RetransmissionBuffer
              ->  SrtpTransport (encrypt)
              ->  IceTransport (write to socket)
              ->  UDP socket
```

For incoming:

```
UDP socket  ->  IceTransport
            ->  SrtpTransport (decrypt)
            ->  RtpDemuxer (route by SSRC)
            ->  ReceiveStream (jitter buffer, NACK, FEC)
            ->  VideoDecoder
            ->  VideoSink (HTMLVideoElement, canvas, etc.)
```

The jitter buffer is the unsung hero: it absorbs network reordering and packet timing variance, dropping or playing out frames at a steady cadence. The buffer adapts depth based on observed jitter. Too shallow and you stutter, too deep and you add latency.

### Codecs

Audio: Opus is the default and mandatory. Wide bitrate range (6 to 510 kbps), low algorithmic delay (~22.5 ms by default).

Video: VP8 is mandatory in WebRTC 1.0. VP9 and AV1 are widely supported. H.264 (Constrained Baseline) is supported but requires per-platform decoder licensing. AV1 was the major ecosystem push from 2022 onward: substantially better quality at the same bitrate, but encode is expensive (real-time AV1 encode requires hardware on most devices).

Encoders live behind `webrtc::VideoEncoder`. Each codec has a default software encoder plus optional hardware-accelerated variants (Chrome's VAEncoder, MediaCodec on Android, VideoToolbox on Apple).

### NAT Traversal: ICE, STUN, TURN

Two peers behind home routers cannot directly send packets to each other, the router has no port mapping. ICE (Interactive Connectivity Establishment) tries every connectivity option in priority order:

1. **Host candidates.** Local IPs.
2. **Server reflexive (srflx).** Public IP/port discovered through a STUN server.
3. **Peer reflexive (prflx).** Discovered during connectivity checks.
4. **Relayed (relay).** Through a TURN server (last resort, full media relay).

ICE runs connectivity checks (STUN binding requests) across all candidate pairs, picks the best one, and switches if a better path appears. The implementation in `webrtc/p2p/base/p2p_transport_channel.cc` is a state machine over hundreds of pairs.

TURN is necessary because symmetric NATs (common on enterprise networks and 4G/5G cellular) prevent direct connections. TURN servers relay UDP between peers at the cost of doubled bandwidth and added latency.

### DTLS-SRTP

Media in WebRTC is encrypted. The handshake is DTLS (TLS over UDP) which establishes shared keys, exporting them as SRTP keys via the DTLS-SRTP profile (RFC 5764). After handshake, RTP packets are encrypted with SRTP (per-packet AES counter mode + HMAC for auth).

Code path:

```cpp
class DtlsTransport : public DtlsTransportInternal {
  // Wraps a SSLStreamAdapter (BoringSSL) over an ICE transport.
  // After handshake, exports SRTP key material:
  bool ExportKeyingMaterial(absl::string_view label,
                            const uint8_t* context,
                            size_t context_len,
                            uint8_t* result, size_t result_len);
};
```

The keys feed into `SrtpSession` which encrypts/decrypts each RTP packet.

### Bandwidth Estimation

WebRTC has to send video at a rate the network can deliver without queueing or loss. GCC (Google Congestion Control), the default since ~2015, observes packet arrival timing reports from the receiver and infers the link's bottleneck rate.

Algorithm summary:

- Sender stamps every RTP packet with a transport-wide sequence number and send time.
- Receiver reports back arrival times via RTCP transport feedback.
- Sender computes the delay gradient (change in one-way delay over time).
- Increase rate when delay is stable, decrease when delay grows.
- Loss-based fallback if loss rate exceeds 10%.

Implementation in `webrtc/modules/congestion_controller/`. There is also a newer BBR-derived congestion control in active development.

### Audio Processing Module (APM)

The APM applies in-loop audio processing on captured audio: AEC3 (acoustic echo cancellation), NS (noise suppression), AGC2, voice activity detection, high-pass filtering. AEC3 is a substantial DSP pipeline that cancels speaker output from microphone input, accounting for variable delay through the audio stack.

Code: `webrtc/modules/audio_processing/`. Heavy use of SIMD intrinsics for the filter banks.

### Data Channels

Beyond media, WebRTC offers `RTCDataChannel`: ordered or unordered, reliable or unreliable byte streams over the same DTLS connection. Implemented via SCTP-over-DTLS (RFC 8261). Used by collaborative document editors, multiplayer games, and file-transfer apps.

### Integration with Chromium

In Chromium, libwebrtc lives in the renderer process. Reasons:

- Capture devices are exposed to the renderer through the media service after permission.
- Encoder/decoder hardware acceleration goes through the GPU process.
- Per-tab isolation: a screen share in tab A does not see tab B's media.

The renderer's main thread dispatches into libwebrtc's worker threads (network, signaling, worker thread). PeerConnection's threading model is strict: each method has a documented "thread" it must be called on, and `RTC_DCHECK_RUN_ON()` enforces it in debug builds.

### Performance Numbers

- Glass-to-glass latency for a typical 1080p call: 100 to 250 ms.
- VP9 software encode at 720p30: a few hundred MHz of CPU.
- AV1 software encode at 720p30: roughly 3x to 5x VP9, hardware preferred.
- Opus encode + decode round trip: <2 ms CPU.
- AEC3 frame processing: <2 ms per 10 ms audio frame.

### Senior Interview Material

- "Walk through what happens when a user clicks Join Meeting in Google Meet, from `getUserMedia` through to the first remote video frame."
- "Why does WebRTC use UDP rather than TCP? What does it lose, what does it gain?"
- "Compare ICE candidate types and explain when TURN is required."
- "How does the jitter buffer balance latency vs glitches?"
- "Explain Google Congestion Control. Why is delay-based estimation preferred to loss-based on modern networks?"

The next section returns to the rendering/compositing path.

---
