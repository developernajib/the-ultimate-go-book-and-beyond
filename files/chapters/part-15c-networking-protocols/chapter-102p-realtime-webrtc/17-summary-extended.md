## Summary

| Topic | Key Pattern |
|---|---|
| **SFU vs MCU vs Mesh** | SFU for ≥4 participants: single upload, server forwards selectively |
| **Simulcast** | 3 quality layers. SFU switches on bandwidth/layout. PLI for keyframe |
| **Bandwidth estimation** | REMB for receiver feedback. TWCC + GCC for sender-side congestion control |
| **CRDT sync server** | Store binary Yjs updates. Broadcast to peers. Replay snapshot to late joiners |
| **OT vs CRDT** | OT = server-ordered, good undo. CRDT = offline-first, decentralized merge |
| **STUN** | Reflexive address discovery only. Zero bandwidth cost |
| **TURN** | Full relay. ~15-20% of connections. Budget 2 Mbps per HD stream |
| **coturn credentials** | HMAC-SHA1 ephemeral credentials. 1-hour TTL. Deny private IP ranges |
| **ICE latency** | Target <500 ms end-to-end. Pre-gather candidates. Use anycast STUN |
| **WebRTC metrics** | ICE success rate, packet loss, jitter, RTT, candidate type distribution |
| **Scaling to 100K rooms** | Stateless signaling (consistent hash) + SFU cluster (room-pinned) + regional TURN |

### Junior → FAANG: The Rows That Reward Memorization

The rows with the highest interview return on investment from this table: "SFU vs MCU vs Mesh" (appears in almost every multi-party video interview question), "OT vs CRDT" (appears in every collaborative editing interview question), "TURN" (the 15-20% relay fraction is the number that shows you understand production WebRTC, not just protocol theory), and "WebRTC metrics" (showing you know what to monitor is a strong signal of operational awareness).

Practice recalling each row from the topic only, then from the key pattern only. The row that most commonly causes confusion: STUN vs TURN. STUN is stateless address discovery with zero bandwidth cost. TURN is a relay with significant bandwidth cost. Confusing the two in an interview is a common mistake that undermines an otherwise strong WebRTC answer.

### Senior @ FAANG: The Summary as a Platform Architecture Checklist

Each row in the extended summary table is a platform architecture checklist item for a WebRTC deployment. Before launching a WebRTC product, verify: Is the SFU topology chosen based on the expected participant count distribution? Is simulcast configured with appropriate layer parameters for the target video quality and bandwidth budget? Is TWCC enabled for sender-side congestion control? Is there a CRDT sync server or OT server (as appropriate) with documented consistency guarantees? Is coturn deployed with ephemeral HMAC credentials (not static shared secrets)? Is ICE latency monitored with a target of less than 500ms? Are WebRTC metrics emitted to the observability platform?

This checklist-driven approach converts the summary table from a knowledge reference into a production readiness gate. The L6 contribution is converting the checklist into an automated pre-launch validation: a CI job that checks that all platform requirements are met before a WebRTC feature can be deployed to production.

---

### Navigation

- **Previous Chapter**: [Chapter 102J - Network Debugging and Performance Optimization](../chapter-102j-network-debugging-performance/00-introduction.md)
- **Next Part**: [Part XVI: Observability & SRE](../../part-16a-observability-sre/00-part-intro.md)
- **Next Chapter**: [Chapter 103 - OpenTelemetry Complete Guide](../../part-16a-observability-sre/chapter-103-opentelemetry/00-introduction.md)
