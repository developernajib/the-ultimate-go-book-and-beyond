## Interview Scoring Rubric

This rubric reflects what interviewers expect at each level. Use it to prioritize which topics to cover first, nail the L5 fundamentals before reaching for L6 depth.

### L4 (Mid-Level), Meets Bar
The candidate understands WebRTC basics (SDP, ICE, DTLS-SRTP), can draw a signaling flow diagram, and recognizes why a media server is needed for group calls (N-squared streams without one). Gaps at this level: no distinction between SFU and MCU, no mention of simulcast or adaptive bitrate.

### L5 (Senior), Strong Hire
Designs an SFU-based architecture with simulcast (3 quality layers per publisher). Explains adaptive bitrate via RTCP feedback loops. Includes Edge PoPs for latency reduction. Handles host migration on disconnect. Covers waiting rooms and breakout rooms as meeting control features. Gaps at this level: does not discuss E2EE key exchange, recording pipeline architecture, or SFU failover.

### L6 (Staff), Exceptional
Everything from L5 plus: cascading SFUs for meetings that exceed single-server capacity, E2EE built on a per-meeting group key that ECDH only wraps (and the candidate knows why pairwise media keys cannot work behind an SFU), with the consequences for recording and transcription spelled out, two-phase recording pipeline (capture raw streams then mix asynchronously), syscall and copy reduction on the media path (`recvmmsg`/`sendmmsg` batching, `io_uring`, and true kernel bypass via DPDK or AF_XDP), Google Congestion Control (GCC) driven by transport-wide feedback rather than loss alone, distinct webinar vs interactive architecture, and automated SFU failover with participant migration.

---
