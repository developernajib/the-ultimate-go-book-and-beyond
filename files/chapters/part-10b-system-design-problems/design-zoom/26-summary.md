## Summary

The following table provides a quick reference for every major component in the Zoom-like system, the technology choice behind it, and why that choice was made. When studying this design, pay attention to how each layer has a single clear responsibility, signaling is separate from media routing, which is separate from persistent storage. This separation is what allows each layer to scale independently based on its own bottleneck: **bandwidth** for media (the SFU saturates its NIC long before its cores), open **connections** for signaling, and **IOPS** for storage.

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Signaling | WebSocket + JSON | SDP/ICE negotiation |
| Media routing | SFU (Selective Forwarding) | Low-latency media relay, no transcoding |
| Simulcast | 3 quality layers | Adaptive quality per subscriber |
| Edge PoPs | 30+ global locations | < 10ms to nearest server |
| NAT traversal | STUN (discovery), TURN (relay) | Connect the 10-20% with no direct path |
| Media transport | WebRTC (DTLS-SRTP) | Encrypted **hop-by-hop**: the SFU can read the media |
| Optional E2EE | Group key + SFrame | Encrypted end-to-end: the SFU cannot, and recording and transcription are forfeited |
| Meeting state | Redis | Active session metadata |
| Persistence | PostgreSQL | Meeting records |
| Recording | Cloud mixing + S3 | Two-phase: capture raw, mix offline |
| Access control | Token + passcode, waiting room | Authorize every join, not just authenticate |


---
