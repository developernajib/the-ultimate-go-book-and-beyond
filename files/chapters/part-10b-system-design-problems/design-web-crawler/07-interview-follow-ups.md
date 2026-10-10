## Interview Follow-Ups

These are the most commonly asked follow-up questions in web crawler interviews. They test whether you understand the adversarial nature of the web and the practical constraints of crawling at scale.

**Q: How do you avoid spider traps (infinite loops)?**

Spider traps generate an infinite number of URLs through mechanisms like calendar pages, session IDs, or deeply nested category trees. Five heuristics work together to detect and avoid them: (1) Depth limit: skip URLs more than 10 hops from seed pages, since most valuable content is within 3-5 clicks of the homepage. (2) URL length limit: skip URLs longer than 500 characters, which are almost always machine-generated. (3) Domain-level budget: once a domain exceeds its discovery budget (500K URLs per pass in the trap detection deep dive), stop *expanding* it and fall back to crawling only what the priority queue already ranks highly. (4) Pattern detection: identify and skip URLs containing session parameters (?session=, ?sid=, ?jsessionid=) or infinite pagination (?page=99999). (5) Repeating path detection: skip URLs with repeating path segments like /a/b/a/b/a/b, which indicate recursive directory structures.

Heuristic 3 is the one that will burn you, so state it carefully. A flat rule like "skip any domain past 100K URLs" is not trap detection, it is a rule that deletes the best sites on the web from your index. English Wikipedia alone is roughly seven million articles, and this very chapter's `computePriority` boosts `wikipedia.org` by 2x. A crawler that boosts a domain and then blacklists it at 100K URLs is arguing with itself. Large legitimate sites and infinite trap generators both produce unbounded URLs, so URL *count* cannot distinguish them. What distinguishes them is yield: a trap emits endless URLs whose content is near-duplicate or empty, while Wikipedia emits endless URLs with distinct content. So budget by domain, tie the budget to observed quality (unique-content rate, SimHash duplicate rate, page quality score), and demote rather than blacklist. Reserve hard blocking for domains that fail those signals outright.

**Q: How do you prioritize what to crawl?**

Priority score combines four signals: PageRank (computed from the link graph of previously crawled pages), freshness weight (news domains score higher because their content changes frequently), domain trust (Wikipedia, government sites, and established media score higher than unknown domains), and depth penalty (deeper URLs are progressively deprioritized because they are less likely to contain important content). The formula is:

```
priority = PageRank × freshness × domain_trust × 1/(1 + depth)
```

Note the `1 + depth`, not `1/depth`. Seed URLs are depth 0, and they are the most important URLs you have, so the naive form divides by zero on exactly the pages you care about most. The simplified `computePriority` in the core components section takes a different shape, subtracting a linear depth penalty from an additive base rather than multiplying, which is easier to reason about when there is no PageRank to multiply by yet. Both are defensible. What matters is that you pick one, and that a depth of 0 is a valid input.

Breadth-first is the right traversal for the first pass, and the reason is not tradition. BFS from a set of seeds reaches high-value pages early, because important pages tend to be linked from many places and therefore sit shallow in the graph, and it naturally spreads requests across many hosts, which is what politeness needs. Depth-first does the opposite on both counts: it burrows into one site, which concentrates load on a single server and dives into the low-value tail before it has seen the shallow pages elsewhere. It also walks straight into calendar traps and never comes back. Once PageRank data exists, subsequent passes use the priority queue, which is a best-first traversal that generalizes BFS.

**Q: How do you crawl at 10K pages/sec with politeness?**

The key insight is that politeness constrains per-domain throughput to 1 request per second, but the internet has millions of domains. You achieve high aggregate throughput by crawling many domains in parallel. Specifically: 200 worker machines, each handling 50 domains concurrently at 1 request per second per domain, yields 200 * 50 = 10,000 pages per second total. Kafka partitioning by domain hash ensures each worker receives a consistent set of domains, preventing cross-worker politeness violations. A Redis-based distributed rate limiter provides a safety net during Kafka consumer group rebalances, when domain ownership temporarily overlaps between workers.

---
