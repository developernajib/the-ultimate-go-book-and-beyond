## Common Mistakes and How to Avoid Them

These are the pitfalls interviewers see most often. Each one indicates a fundamental misunderstanding of crawling at scale.

1. **Single-threaded design**: A single-threaded crawler fetches roughly 2 pages per second (dominated by network latency). Reaching 10K pages per second requires 200 workers with 50 concurrent goroutines each. Candidates who do not discuss parallelism show they have not internalized the scale.

2. **No politeness enforcement**: Sending 50 requests per second to a single domain is effectively a DDoS attack. The standard crawl etiquette is 1 request per second per domain. Without domain-partitioned rate limiting, your crawler will get IP-banned and generate 403 errors that waste resources.

3. **In-memory URL set for dedup**: Storing 10 billion URLs at 100 bytes each requires 1TB of RAM. A Bloom filter does the job in 12GB, at a 1% false positive rate. Say what that rate costs rather than presenting the filter as free: 1% of newly discovered URLs will be mistaken for already-seen and dropped permanently, which at this scale is tens of millions of pages the crawler silently never fetches. Naming the trade-off is worth more in an interview than naming the data structure, and a candidate who claims the filter is lossless has the concept backwards.

4. **No content dedup**: Mirror sites, printer-friendly versions, and CMS-generated duplicates mean the same content frequently appears under different URLs. Without SimHash or a similar fingerprinting approach, your index fills with redundant pages and wastes crawl bandwidth.

5. **Ignoring robots.txt**: Treat this as a hard requirement, not a nicety you trade away for coverage. It is standardized as RFC 9309, it is what site operators reasonably expect, and disregarding it has been argued in court as unauthorized access and breach of terms of service. The practical costs land first: non-compliant crawlers get 403s and IP bans, and you burn bandwidth on pages you could never index. Always fetch and cache robots.txt per domain, and get the details right, since a parser that is subtly wrong is worse than useless because it looks compliant while crawling forbidden paths. The common errors all fail toward over-crawling: treating an empty `Disallow:` as "block everything" rather than "allow everything", applying "allow beats disallow" instead of longest-match-wins, applying both the specific and the `*` group instead of exactly one, and reading a 5xx on robots.txt as permission rather than as a temporary full disallow.

6. **No recrawl strategy**: Treating the web as static is a fundamental error. News sites change hourly, and even documentation pages update periodically. Without adaptive recrawl scheduling, your index grows stale and search quality degrades.

7. **Centralized frontier**: A single URL queue becomes a bottleneck well before 10K pages per second. Kafka partitioned by domain hash provides distributed, fault-tolerant queuing that scales linearly with the number of partitions.

---
