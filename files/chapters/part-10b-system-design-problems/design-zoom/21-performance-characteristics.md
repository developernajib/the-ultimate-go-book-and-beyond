## Performance Characteristics

These figures expose the dominant cost centers in a real-time conferencing system. Within a single region, glass-to-glass latency is dominated by things that are not network transit: encode and decode together run about 60ms, and the receiver's jitter buffer adds another 40ms or so by deliberately holding packets to absorb arrival variance. That is why the engineering wins come from hardware-accelerated encode and from tuning the jitter buffer, not from shaving the 1ms the SFU spends forwarding. Geography is the exception that dwarfs all of it: co-locating the SFU in the participant's own PoP is worth not 5ms but the ~100ms of backbone transit that a cross-continent hop would otherwise add, which is the entire argument for the Edge PoP tier.

The E2EE row deserves a warning, because it is where an intuitive answer is backwards. E2EE does **not** cost the SFU anything. The SFU cannot decrypt E2EE media by definition, so it derives no keys and touches no plaintext: it forwards opaque payloads and reads only the RTP headers, exactly as before. The cost lands on the clients, which encrypt each frame once more on send and decrypt every stream they receive, and the real price is paid in lost features (no cloud recording, no transcription) rather than in SFU capacity. Any capacity table showing an SFU serving 20x fewer participants under E2EE has confused E2EE with the hop-by-hop SRTP work the SFU does either way.

```
Signaling Latency:
  - WebSocket message delivery: < 50ms
  - SDP offer/answer exchange: < 200ms total
  - ICE connectivity check: 100-500ms (STUN)
  - Time to first media frame: < 2 seconds

Media Latency (glass-to-glass):
  - Capture + encode: 30ms
  - Network transit (same PoP): 5ms
  - SFU forwarding: 1ms
  - Jitter buffer (receiver): ~40ms  <- adaptive, the tunable one
  - Decode + render: 30ms
  - Total same-region: ~106ms
  - Cross-continent (US->EU): +100ms backbone = ~206ms

  The jitter buffer is latency the receiver adds on purpose, trading
  delay for smoothness. Shrink it and late packets become gaps and
  freezes; grow it and the call starts feeling like a conversation
  over satellite. It adapts to measured jitter, so a 5ms link and a
  60ms link do not pay the same.

SFU Capacity (per instance, ~4 cores):
  - 200 participants (standard meetings)
  - 200 participants with E2EE (unchanged: the SFU forwards
    ciphertext it cannot read, so E2EE costs it nothing)
  - 50 participants when this instance also hosts a recording tap
    (the tap is an extra subscriber per stream, not a transcode)
  - Ingress:  200 x 1.1 Mbps = 220 Mbps
  - Egress:   200 x 2 Mbps (selected layer) = 400 Mbps
  - Total:    ~620 Mbps, ~65,000 packets/sec at ~1200-byte packets

SFU Capacity (per node, ~64 cores, 128GB RAM):
  - ~15 instances x 200 = ~3,000 participants
  - ~3,000 x 3.1 Mbps = ~9.3 Gbps against a 10 Gbps NIC
  - The NIC saturates before the cores do: this is a network-bound
    box, not a compute-bound one

Scaling Numbers:
  - 100K concurrent meetings x 30 avg participants = 3M participants
  - 3M / 200 per instance = 15,000 SFU instances = ~1,000 nodes
  - Signaling: 3M participants x 1 msg/sec = 3M msg/sec
  - 3M / 100K per WebSocket server = 30 signaling servers

Recording Storage:
  - 720p video @1 Mbps: ~450 MB/hour per participant
    (1 Mbps x 3600s / 8 = 450 MB, not 2 GB: 2 GB/hour would imply
     a 4.4 Mbps stream, four times what this design sends)
  - Mixed recording (grid layout) @1.1 Mbps: ~500 MB/hour
  - Audio only @64 Kbps: ~29 MB/hour
  - 1M meetings/day, 10% recorded = 100K recordings/day
```

---
