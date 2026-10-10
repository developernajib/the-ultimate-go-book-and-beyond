## Interview Follow-Ups

**Q: How do you reduce CPU load on SFU at scale?**

Cut the per-packet syscall cost first, because at 3 Mbps of small RTP packets the syscalls dominate: `recvmmsg`/`sendmmsg` batch many datagrams per call, `io_uring` makes them asynchronous, and DPDK or AF_XDP bypass the kernel network stack entirely. Be precise about which is which in an interview: only DPDK and AF_XDP are kernel bypass, `io_uring` is an asynchronous syscall interface and still goes through the stack. SIMD-optimized RTP header manipulation. Crypto is the other hot path: SRTP is AES, so AES-NI plus a vector-optimized library handles it on the CPU. Do not claim NICs offload it. Modern NICs (ConnectX-6 Dx and later) offer inline crypto offload for IPsec and kTLS, but there is no standard NIC offload path for SRTP.

**Q: How does Zoom handle packet loss for audio?**

Opus has in-band FEC: each packet can carry an LBRR (Low Bit-Rate Redundancy) copy of the *previous* frame, so one lost packet is reconstructed from the packet after it. Know its limits, because interviewers probe them. It recovers single losses, not bursts. It only works in Opus's SILK and hybrid modes, not in pure CELT (the MDCT modes chosen at very high bitrates or sub-10ms frames). It must be switched on with `OPUS_SET_INBAND_FEC` and a non-zero `OPUS_SET_PACKET_LOSS_PERC`. It costs bitrate, and it forces the decoder to hold a packet before playout, spending latency to buy resilience. When FEC cannot recover, Opus PLC synthesizes a plausible continuation of the waveform to hide the gap. Video takes the other trade: NACK-based retransmission, which is worth the round trip only when the jitter buffer is deep enough to wait for it, falling back to a PLI when it is not. Congestion control (GCC, driven by transport-wide feedback) then moves the sender's bitrate.

**Q: How does recording work?**

It depends on where the recording is written. Local recording mixes on the host's own machine and never involves the server. Cloud recording attaches a recording client to the meeting as an extra subscriber: it receives one copy of every stream, persists the raw tracks during the call, and mixes them asynchronously afterward (see the Recording Service deep dive). Mixing is MCU work, transcoding and compositing, which is exactly the CPU cost the live SFU path avoids, and it is affordable here only because it runs offline against stored tracks rather than in the latency path. Output is MP4 to S3. Video layout (speaker view, gallery view) is applied during that mixing pass. Transcription runs an ASR model over the audio track afterward. Note that cloud recording is incompatible with E2EE by construction: the recorder is just another participant, so it can only record what it can decrypt.

---
