## Capacity Estimation

Before diving into architecture, you need to understand the scale you are designing for. Capacity estimation helps you choose the right storage technology, determine how many workers or servers you need, and justify your CDN strategy during an interview. The numbers below are derived from publicly available data about YouTube and Netflix, and they drive every architectural decision in this chapter.

```
Daily active users:  500M (YouTube) / 50M (Netflix)
Videos watched:      1B hours/day = 41.7M concurrent streams
Upload rate:         500 hours/min = 8.3 hours/sec (YouTube)

Storage per video:
  Source upload:     1 hr ≈ 100GB for a high-bitrate 4K master (~220Mbps),
                     but the average upload is far smaller, call it 4GB/hr
  After transcoding: 6-rung ladder, video 16 + 5 + 2.5 + 1.2 + 0.7 + 0.5 Mbps
                     = 25.9Mbps, plus ~1Mbps of audio ≈ 27Mbps ≈ 12GB per hour
  New storage/day:   500hr/min × 1,440min × 12GB ≈ 8.6PB/day
                     (plus the retained source masters, tiered to cold storage)
  10-year archive:   tens of exabytes → codec re-encodes + cold tiering essential

CDN bandwidth:       41.7M concurrent × 5Mbps avg = 208 Tbps
                     → Distributed across 200+ PoPs globally

Transcoding workers: 500hr/min = 1.8M sec of video arriving per min
                     at 2× realtime a worker clears 120 sec/min
                     → 1.8M / 120 = 15,000 parallel workers
                     → Use auto-scaling serverless workers (AWS Lambda / EC2 Spot)

Metadata DB size:    500M videos × 2KB = 1TB (fits in distributed MySQL)
Watch history:       1B events/day × 200 bytes = 200GB/day → Cassandra/Bigtable
Recommendations:     50M DAU × 20 recommendations = 1B queries/day = 11,574/sec
```

---
