## Capacity Estimation

Before diving into architecture, you need to estimate the scale of the system to make informed decisions about storage, throughput, and partitioning. These numbers drive every downstream design choice, from how many database shards you need to how much S3 bandwidth to provision. Getting capacity estimation right in an interview shows you understand real-world constraints rather than designing in a vacuum.

```
Users:              700M registered, 100M daily active
Storage:            500M GB = 500PB
Avg file size:      ~1MB
Files total:        500PB / 1MB = ~500B files
Upload QPS:         100M DAU × 5 uploads/day / 86400 = 5,787/sec
Download QPS:       3x uploads = ~17K/sec
Metadata writes:    5,787/sec
Block size:         4MB chunks
Deduplication:      ~30% space savings (duplicate blocks across users)
```

---
