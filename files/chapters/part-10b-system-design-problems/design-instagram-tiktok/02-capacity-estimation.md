## Capacity Estimation

The numbers below show that this system is overwhelmingly read-heavy: 10 billion views per day versus 100 million uploads. This 100:1 read-to-write ratio means caching and CDN placement drive most architectural decisions. Present these calculations early in an interview to ground your design choices in real constraints.

```
Users:       500M DAU
Uploads:     100M/day = 1,160/sec (≈50M photos + 50M videos)
Views:       10B/day = 115,740/sec
Photos:      50M × 2MB avg → 100TB/day upload
Videos:      50M × 30s at ~20MB → 1PB/day upload
Storage:     ~2EB/year incl. transcoded variants → tiering and cold storage essential
Feed reads:  115,740 req/sec average → ~300K req/sec at peak

CDN egress:  10B views × 5MB avg = 50PB/day
API servers: 300K req/sec / 2000 req/sec/server = 150 servers
```

---
