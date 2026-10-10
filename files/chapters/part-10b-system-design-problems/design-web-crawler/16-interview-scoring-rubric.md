## Interview Scoring Rubric

This rubric shows what interviewers expect at different seniority levels when you present a web crawler design. Knowing where the bar is set helps you focus your preparation. An L4 candidate should cover the basics, while L5 and L6 candidates need to demonstrate progressively deeper knowledge of distributed systems, fault tolerance, and optimization techniques.

### L4, Expected
- Basic fetch -> extract links -> queue loop
- URL dedup, robots.txt, BFS traversal, single machine

### L5, Strong Hire
- Kafka frontier, bloom filter, domain rate limiting
- SimHash content dedup, distributed workers
- Priority scoring, retry with backoff
- Separate metadata from raw content storage

### L6, Exceptional
- All L5 plus:
- Adaptive recrawl scheduling
- Crawler trap detection
- DNS caching
- Worker coordination with heartbeats
- Consistent hashing for domain assignment
- Storage tiering
- Bloom filter checkpointing
- Cross-worker distributed rate limiting
- Ethical considerations: robots.txt, server load

---
