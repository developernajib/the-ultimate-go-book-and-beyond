## Scaling Strategy

Scaling a video conferencing system is fundamentally different from scaling a web application because the bottleneck is network bandwidth and real-time packet forwarding, not request-response throughput. The strategy uses geographic distribution (Edge PoPs) to keep latency low and cascading SFUs to handle large meetings that exceed a single server's capacity. For webinar-style events with over 1000 participants, the system switches to a CDN-like fan-out model where most attendees are view-only receivers, accepting slightly higher latency (3-5 seconds) in exchange for massive scalability.

```
Edge PoPs:  30+ cities, 10-50 SFU nodes each, ~1,000 nodes total,
            <10ms to participant
Media:      ~200 participants per SFU instance, ~15 instances per node
            → 1,000 nodes x 15 x 200 = 3M participants at peak
            Each node: 3,000 x ~3.1 Mbps ≈ 9.3 Gbps, so a 10 Gbps NIC
            is the wall the node hits, not its CPU
Signaling:  WebSocket + Redis Pub/Sub for cross-server, sticky sessions
            per meeting
Large (100+):   Cascading SFUs, active speaker detection (top 4 video)
Webinar (1000+): CDN-like distribution, 3-5s latency OK, panelists via SFU
```

Keep the two units straight, because interviewers push on exactly this. An SFU *instance* is a process handling ~200 participants. An SFU *node* is a machine running ~15 of them. Quoting "15,000 servers" when you mean 15,000 processes on 1,000 machines is a 15x error in the cost model.

---
