## Capacity Estimation

Before designing any system, you need to understand the scale you are working with. For a video conferencing platform, the most critical numbers are concurrent meetings, bandwidth per participant, and total signaling load. These back-of-the-envelope calculations tell us how many media servers we need and how much network capacity the system must provision. Notice that bandwidth dominates the cost picture, video streaming at scale requires terabits per second of aggregate throughput.

```
Daily participants:     30M
Avg meeting duration:   45 minutes
Avg concurrent:         30M × 45 min / 1440 min = ~1M participants
Peak/average ratio:     ~3 (business hours cluster by time zone)
Peak concurrent:        ~3M participants
Concurrent meetings:    100K at peak
Avg meeting size:       3M / 100K = 30 participants
Bandwidth per participant:
  Send:    1 Mbps video + 64 Kbps audio = ~1.1 Mbps
  Receive: N×1 Mbps (or SFU simulcast: ~2 Mbps)
Ingress bandwidth:      100K meetings × 30 × 1.1 Mbps = 3.3 Tbps
Egress bandwidth:       3M receivers × ~2 Mbps (simulcast) = ~6 Tbps
Media server nodes:     ~9.3 Tbps / 10 Gbps NIC ≈ 1,000 nodes
                        (~3,000 participants each, run as ~15 SFU
                         instances of ~200 participants per node)
Signaling load:         3M participants × 1 msg/sec = 3M msgs/sec
```

---
