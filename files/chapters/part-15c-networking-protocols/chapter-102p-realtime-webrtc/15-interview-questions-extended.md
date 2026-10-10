## 102P.13 Advanced WebRTC & Real-Time Interview Questions

**Q: How does WebRTC handle NAT traversal?**

A: WebRTC uses the ICE (Interactive Connectivity Establishment) framework. Each peer gathers three types of candidates: (1) **Host candidates** - local interface IP:port. (2) **Server-reflexive (srflx) candidates** - public IP:port discovered via STUN. (3) **Relay candidates** - IP:port on a TURN server. ICE performs connectivity checks between all candidate pairs using STUN binding requests. The first successful check wins and becomes the nominated pair. Symmetric NATs block srflx paths, requiring a TURN relay. Typically 80-85% of connections succeed with host or srflx. The rest fall back to TURN.

---

**Q: What is the difference between STUN and TURN servers?**

A: STUN (Session Traversal Utilities for NAT) is a lightweight UDP service that tells a client its public IP:port - it does **not** relay traffic. A STUN request costs essentially zero bandwidth. TURN (Traversal Using Relays around NAT) allocates a relay endpoint on the public internet and **forwards all media packets** between peers. TURN is required when both peers are behind symmetric NAT or strict firewalls. TURN is bandwidth-intensive and typically the most expensive infrastructure component in a video platform (~$0.03-0.05 per GB of relayed traffic). Always deploy TURN alongside STUN for reliable connectivity.

---

**Q: How would you scale a video conferencing platform to 100K concurrent rooms?**

A: Three layers:

1. **Signaling tier** - Stateless Go HTTP/WebSocket servers behind a load balancer. Rooms are mapped to signaling nodes via consistent hashing or a Redis-backed registry. Target: 50K WebSocket connections per node, 10-20 nodes.

2. **SFU tier** - Stateful media servers (pion-based or mediasoup). Each room is pinned to one SFU node. Use a room-placement service (like a distributed hash table) to route joining peers to the correct SFU. Scale horizontally. Auto-scale on CPU and bandwidth metrics. Target: 500 rooms per SFU node at 8 participants/room.

3. **TURN tier** - Regional coturn clusters. 15-20% of connections need TURN relay. Geo-route with DNS latency policies. Auto-scale on active allocation count.

Database: Redis for ephemeral room/peer state. Postgres for billing, recordings, audit logs. Message bus (Kafka or NATS) for cross-service events (room created, participant joined).

---

**Q: How does Zoom's architecture differ from pure WebRTC?**

A: Zoom uses its own proprietary UDP protocol ("Zoom's Real-Time Protocol"), not WebRTC. Key differences:

- **Custom codec and packetization**: Zoom controls the entire stack, allowing tighter integration between codec (VP8/H.264/AV1 internally negotiated) and their network adaptation layer.
- **Zoom Multimedia Router (MMR)**: A centralized server topology similar to SFU but with selective processing (noise suppression, echo cancellation) done at the client, not the server.
- **Global Points of Presence (PoPs)**: Zoom's routers are deployed at 200+ PoPs. Client media is routed through the nearest PoP and backhauled over Zoom's private backbone - more predictable latency than the public internet.
- **E2E Encryption option**: Zoom's E2EE mode is a layer on top of their existing MCU-like infrastructure, requiring all clients to share keying material.

Pure WebRTC gives you browser-native support at the cost of less control. Zoom's proprietary stack gives control at the cost of requiring a native client.

---

**Q: What is simulcast and why is it important for video quality?**

A: Simulcast is a technique where a video sender encodes the same stream at **multiple resolutions and bitrates simultaneously** (e.g., 720p/1.5 Mbps, 360p/400 Kbps, 180p/120 Kbps) and sends all layers to the SFU. The SFU then forwards the appropriate layer to each receiver based on:

- The receiver's available downlink bandwidth (estimated via REMB/TWCC).
- The receiver's screen layout (someone in a thumbnail grid doesn't need 720p).
- Explicit quality selection (the receiver pinning a speaker to full screen).

Without simulcast, an SFU would have to forward the same 720p stream to a mobile client on a 500 Kbps connection - causing packet loss and poor quality. With simulcast, the SFU switches to the 180p layer transparently (after requesting a PLI keyframe). Layer switches are seamless and sub-second.

---

**Q: How does Discord achieve low-latency voice with 500K concurrent users?**

A: Discord's voice infrastructure key decisions:

1. **WebRTC for transport** - Discord uses WebRTC's SRTP/DTLS stack for encrypted UDP transport, but with custom signaling (not browser-native WebRTC).
2. **Selective Forwarding** - Discord's voice servers act as SFUs. They forward Opus-encoded audio packets with minimal processing (no mixing, unlike traditional MCUs).
3. **Opus codec** - 20 ms frames, 8-128 Kbps, built-in FEC (Forward Error Correction) for packet loss recovery, DTX (Discontinuous Transmission) to skip silent frames (60-70% bandwidth saving).
4. **Regional voice servers** - Discord operates voice regions (us-east, eu-west, etc.). Users connect to the closest region. Media does not traverse the public internet across regions.
5. **Connection persistence** - Discord maintains persistent WebSocket connections for signaling. Rejoining a channel reuses existing signaling state, reducing re-establishment latency.
6. **Go services** - Discord's backend services are predominantly Go and Rust, handling millions of concurrent connections efficiently via goroutines and async I/O.

---

**Q: CRDT vs OT for collaborative editing - when to use each?**

A: Both solve the same core problem - merging concurrent edits without conflicts - but with different trade-offs:

**Use OT when:**
- You have a reliable central server (Google Docs model).
- You need reliable undo/redo with intention preservation.
- Your team has experience with OT's transform functions.
- The document structure is complex (rich text with formatting, spreadsheet cells).

**Use CRDTs when:**
- You need offline-first or P2P collaboration (Figma, Notion, Linear).
- You want to avoid central coordination (edge-deployed, multi-master).
- You can tolerate eventual convergence and simpler undo semantics.
- You are using Yjs or Automerge (battle-tested, production-grade CRDT libraries).

In practice: for new collaborative tools, **CRDTs with Yjs** is the modern default. OT is legacy (but entrenched at Google). Do not implement OT or CRDT from scratch - use Yjs (TypeScript/Go port) or Automerge.

---

**Q: What metrics indicate a healthy WebRTC deployment?**

A: The four key signal quality metrics from `RTCStatsReport`:

| Metric | Healthy | Degraded | Action |
|---|---|---|---|
| **ICE success rate** | > 98% | < 95% | Check TURN coverage. Add relay candidates |
| **Packet loss** | < 0.5% | > 2% | Check network path. Switch to TURN if srflx lossy |
| **Jitter** | < 20 ms | > 50 ms | Investigate network congestion. Adjust jitter buffer |
| **RTT** | < 100 ms | > 300 ms | Route through closer TURN/SFU node |

Track ICE candidate type distribution (host/srflx/relay ratio) separately per platform (mobile vs desktop) and per geographic region to identify NAT traversal gaps.

### Junior → FAANG: What Makes a WebRTC Answer Strong at Entry Level

The WebRTC NAT traversal question is the entry-level WebRTC question. A strong entry-level answer covers: ICE collects candidates from local interface, STUN server (public IP discovery), and TURN server (relay). Peers exchange candidates via signaling. ICE connectivity checks select the best working path. TURN is the fallback for symmetric NAT.

The detail that elevates an entry-level answer to mid-level: explain what symmetric NAT is and why it blocks standard STUN. "Symmetric NAT assigns a different external port for each destination, so the STUN-discovered address only works for connections to the STUN server, not for peer-to-peer connections to another client. TURN solves this by providing a fixed relay address."

For the ICE candidate type distribution metric: understanding that monitoring host/srflx/relay ratios by platform and region reveals TURN capacity gaps is the kind of operational awareness that shows you have thought about WebRTC deployment, not just WebRTC implementation.

### Senior @ FAANG: Bar-Raiser Depth on WebRTC System Design

The bar-raiser version of the WebRTC interview question is: "design a video conferencing system that handles 100,000 concurrent rooms, each with up to 50 participants, with a 99.9% session establishment success rate and p99 ICE latency under 3 seconds." This requires: signaling server architecture (stateless with consistent hashing, or stateful with room affinity), SFU cluster design (room-pinned assignment, cascade protocol for large rooms), TURN fleet sizing (based on relay ratio and bandwidth budget), geographic routing (latency-optimized participant placement), and monitoring (ICE success rate by region, STUN/TURN split, session establishment latency percentiles).

The L6 signal: candidates who can answer this with specific numbers (N TURN nodes per region, Y signaling servers per region, Z SFU instances per cluster) and can explain how each number is derived from the requirements are demonstrating the quantitative reasoning that staff-level system design requires. The answer does not need to be precise. It needs to show a methodology for arriving at numbers from requirements.


---
