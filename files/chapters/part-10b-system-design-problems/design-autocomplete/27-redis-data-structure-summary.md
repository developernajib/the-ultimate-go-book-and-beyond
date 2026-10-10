## Redis Data Structure Summary

Redis serves as the backbone of the distributed caching layer, storing everything from precomputed suggestions to per-user history. Understanding this key schema is essential for debugging, monitoring, and capacity planning. Each key follows a namespaced convention that makes it easy to identify its purpose and manage TTLs independently.

```
# Global term frequencies
terms:freq            ZSET  (member=term, score=frequency)
terms:all             ZSET  (member=term, score=0, for ZRANGEBYLEX)

# Precomputed top-K per prefix
trie:prefix:{prefix}  STRING (JSON array of suggestions, TTL=5min)

# Per-user search history
user:history:{uid}    ZSET  (member=term, score=timestamp)

# Autocomplete cache
ac:{domain}:{prefix}  STRING (JSON, TTL=30s)

# Term count (real-time)
term:count:{term}     STRING (integer, TTL=24h)

# Trending
trending:recent       ZSET  (terms with non-zero recent counts)
qcount:{term}:{min}   STRING (count for specific minute bucket)

# Content blocklist (replicated to all servers)
blocklist:terms       SET   (blocked terms)
```


---
