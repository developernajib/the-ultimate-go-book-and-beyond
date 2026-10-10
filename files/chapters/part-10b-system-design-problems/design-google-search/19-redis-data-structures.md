## Redis Data Structures

Redis serves multiple roles in this architecture: it acts as the crawl frontier (priority queue), a deduplication store for visited URLs, a cache for frequent query results, and the backing store for PageRank scores and autocomplete data. Each use case maps naturally to a specific Redis data structure. Understanding these mappings helps you explain the caching and queueing layers of your design concretely rather than hand-waving about "using a cache."

```
# Query result cache (most common queries)
SET search_cache:{query_hash} '<compressed_json_results>' EX 300

# Autocomplete prefix cache
ZADD autocomplete:go {weight} "golang" {weight} "google" {weight} "go programming"
# Serve top-10 from sorted set per prefix

# PageRank scores
ZADD pagerank {score} "doc_id_abc123"

# Crawl frontier (priority queue)
ZADD url:frontier {priority} "https://example.com/page"
# Pop highest priority: ZPOPMAX url:frontier 1

# Crawl dedup (seen URLs)
SET crawled:{url_hash} "1" EX 1209600  # 14 days

# Rate limiter per domain (crawl politeness)
INCR crawl_rate:{domain}:{second}
EXPIRE crawl_rate:{domain}:{second} 2
# Max 1 request per second per domain
```

---
