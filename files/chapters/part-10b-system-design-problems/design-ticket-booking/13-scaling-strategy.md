## Scaling Strategy

### Peak Sale Event Architecture

The system operates in two distinct modes, and knowing when to switch between them is critical. During normal operation, a small fleet handles browsing and low-volume bookings. Before a high-demand sale, the system pre-warms additional capacity and enables the virtual queue. This pre-scaling approach avoids cold-start latency that would cause timeouts during the initial traffic surge. After the sale completes, resources scale back down to avoid unnecessary cost.

```
Normal Mode (10K concurrent):
  5 API servers, 1 PostgreSQL + 2 replicas, 3-node Redis

Sale Event Mode (5M concurrent, triggered 1 hour before):
  1. Scale API: 5 -> 50 pre-warmed instances
  2. Scale Redis: 3 -> 6 nodes
  3. CDN: pre-warm event page and seat map
  4. Enable virtual queue
  5. Disable non-essential features

During sale:
  Virtual queue absorbs 99% of traffic
  Only 10K users/min (~167/sec) enter booking flow
  Redis serves ~200K queue-position reads/sec + ~167 hold scripts/sec
  PostgreSQL handles confirmations (~500 writes/sec: hold, payment, confirm)

After sale (30 min post-sellout):
  Scale down to normal
```

---
