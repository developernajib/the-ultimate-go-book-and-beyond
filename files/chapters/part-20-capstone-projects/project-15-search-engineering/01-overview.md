## Overview

Search is one of the most complex domains in software engineering - combining information retrieval theory, distributed systems, machine learning, and low-latency systems design. This chapter builds a production-grade search system in Go, covering inverted indexes, BM25 ranking, vector search, query parsing, and observability. After this chapter you will be able to:
- Build an inverted index with TF-IDF and BM25 scoring
- Implement query parsing with operators (AND, OR, NOT, phrase)
- Design a distributed search cluster with consistent hashing
- Integrate vector/semantic search with Elasticsearch and pgvector
- Build autocomplete with a trie and Levenshtein distance
- Implement faceted search, pagination, and highlighting
- Tune search relevance and measure quality with NDCG/MRR metrics
- Design a search system that handles 100K QPS

---
