## Common Mistakes and How to Avoid Them

These are the pitfalls that interviewers see most often when candidates design a search engine. Each mistake either breaks correctness, kills performance, or ignores a critical user-facing feature. Review this list before your interview to make sure your design does not fall into any of these traps.

1. **Term-based sharding.** Sharding the index by term means a multi-word query like "Go concurrency patterns" requires cross-shard joins to intersect the posting lists for "Go", "concurrency", and "patterns". Document-based sharding keeps all terms for a document on the same shard, enabling local intersection.
2. **No PageRank.** Ranking by text relevance alone (BM25) produces results dominated by keyword-stuffed spam pages. PageRank (or a similar link-authority signal) is essential for separating high-quality content from SEO manipulation.
3. **Sequential crawling.** A single-threaded crawler indexing one page at a time would take centuries to cover 50 billion pages. Distributed crawling with thousands of concurrent workers, each respecting per-domain rate limits, is the only viable approach.
4. **No spell correction.** Users frequently misspell queries. Without spell correction ("Did you mean...?"), the search engine returns zero or low-quality results for common typos. Edit-distance algorithms and query log mining for similar popular queries solve this.
5. **No freshness mechanism.** An index that only updates weekly misses breaking news entirely. A delta index for recently crawled pages gives near-real-time freshness without the cost of rebuilding the main index.
6. **Single-phase ranking.** Running a complex ML ranking model across all 50 billion documents per query is computationally impossible. Two-phase ranking (fast BM25 recall in shards, then ML re-ranking on the top candidates) is the standard approach.
7. **No deduplication.** The same content often appears at multiple URLs (mirrors, syndication, www vs non-www). Without deduplication (using content hashes or near-duplicate detection like SimHash), search results fill with redundant copies.
8. **Ignoring robots.txt.** Not respecting robots.txt is both legally risky and practically harmful, sites may block your crawler's IP, and you waste resources crawling pages the site owner has explicitly marked as off-limits.
9. **Flat text results.** Users expect rich snippets with highlighted query terms, knowledge panels, image previews, and structured data. Returning just a list of URLs is not competitive with modern search expectations.
10. **No autocomplete.** Autocomplete reduces the number of keystrokes users need and guides them toward well-formed queries that produce better results. At 100K QPS, autocomplete also reduces the diversity of queries that hit the index, improving cache hit rates.

---
