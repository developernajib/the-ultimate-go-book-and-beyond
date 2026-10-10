## Problem Statement

Design a web crawler that powers a search engine by systematically downloading and indexing the publicly accessible web. The crawler must be both aggressive enough to cover billions of pages and polite enough to avoid disrupting any individual website. The requirements below define the scale, constraints, and quality expectations.

- **Crawl 10 billion pages across the internet**: This is the approximate size of the indexable web. A full pass takes roughly 11.5 days at the target throughput.
- **Process 10,000 pages per second**: This throughput requires 200 worker machines running 50 concurrent fetches each. A single machine cannot achieve this alone due to network latency and domain rate limits.
- **Respect robots.txt and crawl-delay**: Every domain's robots.txt must be fetched, parsed, and cached. The crawler must obey the exclusion rules of RFC 9309, and honor the crawl-delay directive where a site sets one, noting that crawl-delay is a non-standard extension that most sites omit, so the default politeness interval does the real work. Non-compliance results in IP bans, and it is an ethical and potentially legal failure rather than a tuning choice.
- **Handle duplicate content**: Deduplication operates at two levels. URL dedup prevents re-fetching pages already visited. Content dedup catches mirror sites and printer-friendly versions that serve identical text under different URLs.
- **Support continuous re-crawling**: The web changes constantly, news sites update hourly, documentation pages change weekly. The crawler must adaptively schedule recrawls based on each page's observed change frequency.
- **Extract links, text, metadata for search indexing**: Raw HTML must be parsed to extract clean text, page titles, language tags, and outbound links for discovery. Noise elements (ads, navigation, scripts) must be stripped.
- **Politeness: max 1 request per second per domain**: This is the standard crawl etiquette. Achieving 10K total requests per second means crawling 10K different domains in parallel, not one domain faster.
- **Fault-tolerant**: Network timeouts, DNS failures, malformed HTML, and crawler traps (infinite URL generators) are routine. The system must classify each failure, retry appropriately, and never crash the entire pipeline.

---
