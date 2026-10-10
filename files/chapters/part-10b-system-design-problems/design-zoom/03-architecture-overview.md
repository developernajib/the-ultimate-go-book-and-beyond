## Architecture Overview

The architecture follows a three-layer design that separates concerns cleanly. At the outermost layer, Edge Points of Presence (PoPs) sit close to users in 30+ cities worldwide, minimizing the last-mile latency that ruins call quality. Behind them, media servers using the SFU (Selective Forwarding Unit) pattern route audio and video packets without transcoding, keeping latency under 150 milliseconds. The signaling and meeting services handle control-plane operations like joining, leaving, muting, and screen sharing over WebSocket connections.

```
Participant (Browser/Desktop/Mobile)
       │  WebRTC (UDP/DTLS-SRTP)
       │  WebSocket (signaling)
       ▼
┌─────────────────────────────────────────────────────────┐
│               Edge Points of Presence (PoP)             │
│  (30+ cities globally - closest to participant)         │
└───────────────────────────┬─────────────────────────────┘
                            │ internal backbone (low latency)
                   ┌────────▼────────────┐
                   │   Media Servers     │
                   │   (SFU - Selective  │
                   │    Forwarding Unit) │
                   └──────────┬──────────┘
                              │
                   ┌──────────▼──────────┐
                   │  Signaling Service  │
                   │  (meeting control)  │
                   └──────────┬──────────┘
                              │
                   ┌──────────▼──────────┐
                   │  Meeting Service    │
                   │  (state, roster)    │
                   └─────────────────────┘
```

---
