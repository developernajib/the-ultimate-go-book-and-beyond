## Project Overview

We'll build **GoSearch** - a production-ready full-text search engine similar to Elasticsearch or Solr. The system will support:

- **Inverted index** with posting lists and skip lists
- **Text analysis** with pluggable tokenizers and filters
- **Query language** supporting boolean, phrase, fuzzy, and range queries
- **Ranking algorithms** including TF-IDF and BM25
- **Document storage** with compression and versioning
- **Distributed sharding** for horizontal scaling
- **Real-time indexing** with near-instant search
- **Search features** like highlighting, faceting, and autocomplete
- **REST and gRPC APIs** for indexing and search
- **Performance optimization** for millions of documents

### Why This Project Matters

Search engines are fundamental to modern applications and a common senior+ interview topic:

- **Google**: The entire company is built on search technology
- **Amazon**: Product search drives billions in revenue
- **Netflix**: Content discovery and recommendation
- **Uber**: Location search, driver matching
- **Airbnb**: Property search with complex filters
- **LinkedIn**: Job search, people search
- **Shopify**: Product search for millions of stores
- **GitHub**: Code search across billions of files

### System Architecture

GoSearch exposes both a REST and a gRPC API so that clients can choose between HTTP/JSON convenience and high-throughput binary streaming. Incoming queries flow through a Query Coordinator that rewrites and plans the query, then fans it out in parallel to each shard. Every shard runs its own Text Analyzer pipeline (tokenization, stemming, stop-word removal) and an inverted index that maps terms to posting lists. The coordinator merges partial result sets and applies the global BM25 ranking before returning a single sorted response. A dedicated Replication Manager propagates index segments from primary shards to replicas, keeping read capacity elastic without affecting indexing throughput.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   REST API   │     │   gRPC API   │     │  Admin API   │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       └────────────────────┴────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              │    Query Coordinator      │
              └─────────────┬─────────────┘
                            │
       ┌────────────────────┼────────────────────┐
       │                    │                    │
┌──────▼──────┐      ┌──────▼──────┐     ┌──────▼──────┐
│   Shard 1   │      │   Shard 2   │     │   Shard N   │
├─────────────┤      ├─────────────┤     ├─────────────┤
│ Text        │      │ Text        │     │ Text        │
│ Analyzer    │      │ Analyzer    │     │ Analyzer    │
├─────────────┤      ├─────────────┤     ├─────────────┤
│ Inverted    │      │ Inverted    │     │ Inverted    │
│ Index       │      │ Index       │     │ Index       │
├─────────────┤      ├─────────────┤     ├─────────────┤
│ Document    │      │ Document    │     │ Document    │
│ Store       │      │ Store       │     │ Store       │
└─────────────┘      └─────────────┘     └─────────────┘
       │                    │                    │
       └────────────────────┴────────────────────┘
                            │
                     ┌──────▼──────┐
                     │ Replication │
                     │   Manager   │
                     └─────────────┘
```

### Junior → FAANG: Feature Set as Interview Scope

GoSearch's feature list maps to a complete information retrieval system. For an interview, you will not describe all features. Pick the two or three that are most technically interesting and be able to discuss each for 3-5 minutes: the inverted index structure, BM25 ranking, and distributed sharding. The other features (autocomplete, fuzzy matching, faceted search) are worth mentioning as extensions you would add given more time.

Autocomplete with trie or prefix-indexed terms is a common interview question in its own right. Know the two approaches: a prefix-indexed inverted index (where "search" is indexed as "s", "se", "sea", "sear", "searc", "search") enables fast prefix queries using the existing index infrastructure. A trie data structure (explicit prefix tree) enables faster prefix queries with lower memory overhead. Know the tradeoff.

Fuzzy matching (tolerating typos) using edit distance is worth understanding at the conceptual level. Levenshtein automata (a DFA that accepts all strings within edit distance k of a given string) is the production technique used by Elasticsearch for fuzzy matching. Know that it exists and what it does.

### Senior @ FAANG: GoSearch as a Specialized Versus General Platform Decision

At senior level, building a custom search engine versus using Elasticsearch is a significant architectural decision. Elasticsearch provides distributed search, relevance ranking, faceted navigation, aggregations, and an active open-source community. Building GoSearch provides full control over the index format, query language, and ranking algorithm, but requires significant ongoing maintenance.

Valid reasons to build a custom search engine: extremely high QPS requirements where Elasticsearch's JVM overhead is prohibitive, proprietary index format for significant memory efficiency gains, or specialized ranking algorithms that Elasticsearch's script scoring cannot implement efficiently. The ADR for this decision must document the requirement that Elasticsearch cannot satisfy and the estimated implementation cost compared to Elasticsearch customization.

For most use cases, Elasticsearch with custom analyzers and ranking functions is the right choice. GoSearch is valuable as a learning exercise and as a reference for understanding how search engines work internally. The lesson from building GoSearch is not "I should build my own search engine" but "I now understand how Elasticsearch works, which makes me a better engineer when using it."

---
