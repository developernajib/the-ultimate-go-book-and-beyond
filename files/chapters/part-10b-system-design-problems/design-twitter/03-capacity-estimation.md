## Capacity Estimation

Before diving into architecture, you need to understand the scale of the system you are building. Capacity estimation helps you pick the right storage engines, decide how many servers you need, and identify which operations will be your bottleneck. The numbers below are rough but realistic for a platform with 200 million daily active users.

```
Tweets/day:      500M = 5,787/sec average, ~17,000/sec peak
Timeline reads:  800M/day = 9,259/sec (peak ~30K/sec)
Characters/tweet: 280 chars = ~560 bytes avg
Daily storage:   500M × 560B = 280GB/day (text only)
Annual storage:  ~100TB (tweets text)

Media:           30% of tweets have media, avg 100KB
                 = 150M × 100KB = 15TB/day media

Timeline fan-out:
  Regular user: avg 200 followers → 5,787/sec × 200 = 1.16M Redis writes/sec
  Celebrity (10M followers): single tweet → 10M writes (skip fan-out → pull)

Search index:    500M tweets/day × 560B = 280GB/day to Elasticsearch
                 Searchable corpus: ~2TB (last 7 days in hot index)

Redis memory:    200M users, each timeline: 800 tweet IDs × 8 bytes = 6.4KB
                 200M × 6.4KB = 1.28TB across Redis cluster
```

The most critical number is the fan-out write rate: 1.16 million Redis writes per second from distributing regular-user tweets to follower timelines. This drives the decision to use Redis Cluster with pipelining (batching 1,000 writes per pipeline call). The celebrity problem appears in the numbers too, a single user with 10 million followers would generate 10 million writes from one tweet, which is why accounts above 100,000 followers use pull-on-read instead. The 280GB/day search index tells you the Elasticsearch hot tier has to hold a ~2TB working set in page cache to keep 7 days of tweets searchable at sub-50ms latency, which is roughly 8 to 10 nodes with 256GB of RAM each.

Treat these figures as order-of-magnitude sizing, not a bill of materials. Two of them are deliberately optimistic. The 8-bytes-per-tweet-ID timeline arithmetic counts the IDs and ignores the skiplist and hash-table overhead a Redis sorted set carries per entry, which is several times larger. And the 200-follower average hides the shape of the distribution: the mean is dragged around by a long tail, and it is the tail, not the mean, that decides whether your fan-out workers keep up. Size from measurements and percentiles before you commit to a cluster.

---
