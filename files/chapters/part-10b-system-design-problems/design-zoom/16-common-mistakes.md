## Common Mistakes and How to Avoid Them

These are the errors interviewers see most often. Each one reveals a misunderstanding of how real-time media systems work at scale. Avoiding these mistakes puts you ahead of most candidates.

1. **P2P mesh for groups.** In a mesh, every client uploads its own video separately to every other client: N*(N-1) directed streams, and N-1 uploads *per client*. A 10-person mesh call means each client encodes and uploads 9 copies of itself, roughly 9.9 Mbps upstream at 1.1 Mbps per stream, which no home connection sustains. An SFU changes exactly one term: each client uploads **once** (1.1 Mbps) and the server fans that stream out. Downloads do not change, N-1 = 9 either way, which is the point people miss. The SFU saves upstream bandwidth and client encode cycles, not downstream. That matters because upstream is the scarce, asymmetric direction on consumer links. P2P is right for 1:1, where mesh and SFU are the same shape anyway and the server is pure overhead.
2. **MCU over SFU.** MCU transcodes every stream into a single composite = 200ms+ latency and massive CPU cost. SFU forwards packets without touching the media content. The latency difference is the reason modern conferencing platforms all use SFU.
3. **No adaptive bitrate.** Sending 720p to a participant on a 3G connection causes packet loss, buffering, and freezing. Simulcast with per-subscriber layer selection is essential. Without it, one bad connection degrades the experience for everyone in the meeting.
4. **Single signaling server.** A single WebSocket server is a single point of failure. When it crashes, every meeting it hosts drops. Redis Pub/Sub enables cross-server signaling so meetings can span multiple signaling instances.
5. **No host migration.** If the host's disconnect ends the meeting, 100 participants lose their call because of one person's network. Automatic host transfer, to a designated co-host if there is one and to the longest-connected participant otherwise, is a basic reliability requirement.
6. **Client-side-only recording.** Client recording depends on the recorder's connection staying stable for the entire meeting. Server-side capture via a dedicated recording participant in the SFU is far more reliable and produces consistent quality.

---
