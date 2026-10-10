## Quick Reference: Scale Numbers

These are the key numbers to remember for a video streaming system design interview. Being able to cite specific scale figures makes your design credible and demonstrates quantitative reasoning.

- 500 hours/min uploaded (YouTube) = 8.3 hours/sec of new content
- 15,000 parallel transcoding workers needed for real-time processing
- 6 quality levels per video: 4K, 1080p, 720p, 480p, 360p, 240p
- Ladder sums to ~27 Mbps, so ~12GB of output per source hour
- 6-second CMAF segments, the duration Apple's HLS spec recommends
- ~8.6PB new storage per day after transcoding
- 208 Tbps sustained CDN egress = 68 EB/month, which is why you own your edge
- 95%+ CDN cache hit rate means origin handles <5% of traffic
- 41.7M concurrent streams globally
- 1B watch-history events per day to Cassandra/Bigtable
- 11,574 recommendation queries/sec = pre-compute and cache top 20 per user
- Two-stage recommendation: millions -> 500 candidates -> 20 results
- View counts: eventually consistent, batched every 30 seconds via stream processing

---
