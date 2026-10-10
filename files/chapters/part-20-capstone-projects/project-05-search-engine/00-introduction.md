# Capstone Project 5: Full-Text Search Engine

**Difficulty**: Advanced
**Estimated Time**: 4-5 weeks
**Target**: Production-ready Elasticsearch-like search engine
**Tech Stack**: Go 1.27+, gRPC, Redis, MinIO/S3, NATS

---

### Junior → FAANG: Search as a Core Systems Discipline

Full-text search is one of the most complex and interesting engineering domains. The inverted index, BM25 ranking, query parsing, and tokenization analysis are concepts that appear in technical interviews at companies like Google, Elastic, and any FAANG company with a search product. Building a search engine from scratch gives you first-principles understanding of how Elasticsearch, Solr, and Lucene work internally.

For entry-level interviews, knowing the difference between a forward index (document to terms) and an inverted index (term to documents) and why the inverted index is the correct data structure for full-text search is sufficient. The follow-up question is always "what is the time complexity of a search?" The answer is O(k) where k is the number of documents matching the query, regardless of the total corpus size, because the inverted index maps directly to the document list.

### Senior @ FAANG: Search Engine as a Platform with Quality and Relevance Dimensions

At senior level, a search engine is evaluated on two dimensions beyond correctness: relevance quality (are the right documents ranked highly?) and operational efficiency (does the engine scale to the corpus size and query rate required?). Both dimensions require ongoing investment, not just initial implementation.

Relevance quality is measured with information retrieval metrics: NDCG (Normalized Discounted Cumulative Gain), MRR (Mean Reciprocal Rank), and precision/recall. These metrics require human-labeled relevance judgments as ground truth. Building the infrastructure for relevance evaluation (a labeling pipeline, an A/B testing framework for ranking changes, and automated regression testing against known good queries) is a staff-level platform concern that must be addressed before the search engine goes to production.

---
