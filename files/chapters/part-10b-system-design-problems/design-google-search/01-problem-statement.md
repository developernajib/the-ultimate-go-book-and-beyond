## Problem Statement

Building a web search engine at Google's scale is an exercise in managing extreme fan-out. A single user query touches thousands of index shards in parallel, each running a BM25 retrieval against billions of documents, and the coordinator must merge, re-rank, and render results, all within 200 milliseconds. Meanwhile, a continuous crawl pipeline ingests millions of new and updated pages per day, feeding them through parsing, indexing, and link-graph analysis. The dual challenge of serving queries at extreme speed while keeping the index fresh is what makes this one of the most demanding system design problems.

Design a web search engine supporting:
- Index 50 billion web pages
- Handle 8.5 billion queries/day (~100K QPS)
- Return results in < 200ms
- Crawl and index new/updated pages continuously
- Rank by relevance (content + PageRank)
- Handle typos, synonyms, personalization
- Support rich results (snippets, images, news)

---
