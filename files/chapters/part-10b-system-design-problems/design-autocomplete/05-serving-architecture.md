## Serving Architecture

Not all prefixes are created equal. A single-character prefix like "g" absorbs an outsized share of the 100K QPS because every query starts with one keystroke, while a longer prefix like "golang tut" is far more specific and much less frequent. This tiered approach assigns each prefix length to the caching layer that best matches its access pattern, keeping the hottest data in memory and pushing the long tail to Redis or on-demand lookups.

```
Prefix length → Tier assignment:
  len(prefix) == 1:  Top-level (global cache, ~40 prefixes, warm forever)
  len(prefix) <= 3:  L1 in-memory trie (100K prefixes, refresh every 5min)
  len(prefix) <= 6:  L2 Redis cache (10M prefixes, TTL=30s)
  len(prefix) >  6:  On-demand from term frequency store

Why: Short prefixes absorb most of the QPS,
     long prefixes are specific → fewer QPS but need exact results.
```

---
