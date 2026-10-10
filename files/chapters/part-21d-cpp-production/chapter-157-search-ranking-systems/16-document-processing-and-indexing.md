## Document Processing and Indexing

The other side of search: the offline (or near-real-time) pipeline that ingests documents, processes them, and writes them into the index. Production document pipelines look more like data engineering than search, but the design choices made here determine what queries can be served and how fresh results are.

### Pipeline Overview

```
source -> [extract] -> [parse / clean] -> [tokenize] -> [normalize]
       -> [language detect] -> [enrich] -> [embed] -> [dedup]
       -> [build segment] -> [merge] -> [serve]
```

Each stage is independently scaled. In a system like Vespa or Lucene, this is a multi-stage data pipeline implemented as a streaming or batch job (Spark, Flink, custom).

### Extraction

For text-only sources, this is reading rows from a database or a document store. For web pages, PDFs, Word documents, etc., extraction is the messiest stage:

- **HTML.** Parse with libxml2, extract text with boilerplate removal (Justext, jusText, DOM-based heuristics, Readability).
- **PDF.** pdfminer, pdftotext, Tika (Java). Extract text and structural metadata.
- **Office formats.** Apache Tika (Java) is the most thorough. Native libraries exist per format.
- **Images, video.** OCR (Tesseract, Google's CloudVision). Speech-to-text. Often via separate ML services.

Boilerplate removal is critical for web. A page's nav bar and footer should not contribute to the document's term distribution, it pollutes IDF. Justext removes paragraphs that look like boilerplate based on text density and link density.

### Tokenization (Document Side)

UAX-29 again, plus language-specific segmenters for CJK. The same rules as the query side, applied to potentially much longer text. For long documents (papers, books), tokenize in streaming fashion to bound memory.

### Normalization

Same as query side: lowercase, accent fold, Unicode normalize. Tokens are emitted with their position and the offset in the original text (for highlighting / snippets).

### Language Detection

Per-document language. CLD3 (Compact Language Detector 3, Google) and FastText's language ID model are the standard. Both run in microseconds per document.

Multi-language documents (a Russian page with English code samples) need per-paragraph or per-sentence detection. The dominant language sets the document's analysis pipeline.

### Stemming, Lemmatization, Stop Words

Apply the language-specific analyzer chosen by language detection. Lucene's analyzer chain is per-language: `StandardTokenizer -> LowerCaseFilter -> StopFilter(language) -> SnowballFilter(language)`.

### Field Extraction

A document has multiple fields: title, body, author, date, URL, anchor text (for web), tags, category. Each is indexed separately and possibly with different analysis settings. BM25F (chapter 5) scores across fields with weights.

### Enrichment

Add features the index can use later:

- **Static rank.** PageRank for web, custom popularity for products, citation count for papers.
- **Quality score.** A learned classifier outputs "spam likelihood", "low-quality content", etc.
- **Topic labels.** Classify into a taxonomy (sports, finance, etc).
- **Entities.** NER pulls out people, places, organizations, dates.
- **Sentiment.** For some verticals.

These features are stored alongside the document and used as features in the LTR layer.

### Embedding Generation

Generate the dense vector for each document. Discussed in chapter 7. The cost dominates large pipelines. Strategies:

- Truncate to first N tokens (most retrieval signal there).
- Pool sentence embeddings instead of running the full model on long text.
- Use a smaller model.

Production batch jobs typically encode 1M-10M documents per hour per A100. Bigger fleets can encode billions per day.

### Deduplication

Web-scale corpora have massive duplication: the same article on multiple sites, same product on multiple sellers, same paper on multiple servers. Deduplication is critical for both index quality and corpus size.

**Exact dedup.** Hash the normalized content (e.g., SHA-256). Group by hash, keep one canonical doc.

**Near-duplicate dedup.** MinHash (Broder 1997). Hash shingles (overlapping n-grams of words) to a fixed-size signature using min-hash functions. Two documents with similar shingles have similar MinHash signatures. Compare with Jaccard similarity over signatures. LSH on MinHash buckets candidate pairs.

```cpp
// MinHash sketch.
struct MinHash {
    int num_perms = 128;
    std::vector<std::pair<std::uint64_t, std::uint64_t>> permutations;  // a, b for ax+b mod p

    std::vector<std::uint64_t> signature(const std::vector<std::uint64_t>& shingles) const {
        std::vector<std::uint64_t> sig(num_perms, std::numeric_limits<std::uint64_t>::max());
        for (auto s : shingles) {
            for (int i = 0; i < num_perms; ++i) {
                auto h = (permutations[i].first * s + permutations[i].second) % PRIME;
                sig[i] = std::min(sig[i], h);
            }
        }
        return sig;
    }
};
```

**SimHash (Charikar 2002).** Map shingle hashes to signed bits, sum, threshold. Different from MinHash but similar in spirit. Used at Google for web dedup.

After fingerprinting, LSH buckets candidates and a final exact comparison (Jaccard or cosine on shingles) confirms duplicates. Documents flagged as duplicates of an already-indexed doc are dropped or chained (so that a query matching a duplicate returns the canonical).

### Segment Building

Once a document is processed, append it to the current writable segment. The segment accumulates documents in memory. When it fills (configurable threshold, e.g. 100MB or 100k docs), it is sealed:

1. Sort terms.
2. Build the dictionary (FST or sorted list).
3. Build posting lists per term (compressed).
4. Build skip structure.
5. Write doc store.
6. Flush to disk.
7. Make available to readers.

The sealed segment is immutable. Future writes go to a new segment.

### Segment Merging

Many small segments hurt query performance (each query visits every segment). Merge policies combine small segments into bigger ones in the background.

**Tiered (Lucene's TieredMergePolicy).** Multiple tiers of segments by size. Merge segments within a tier when there are too many. Similar to LSM tree leveling.

**Time-based.** Merge by ingestion time, useful for time-series data (logs, events).

**Log-structured (LogMergePolicy).** Older Lucene policy: merge adjacent segments by log size.

Merging is expensive: re-read all input segments, build a new combined segment, write it, atomically swap. During merge, both source and destination consume disk and memory. Production tuning balances merge throughput against query latency.

### Soft Deletes

Deletes are tombstones: a per-segment bitmap of deleted docIDs. Future reads check the bitmap. Deleted-but-not-yet-merged documents still consume disk space until the next merge that includes them.

Update = soft delete + insert. The new version becomes the live one, the old persists in the segment until merged out.

### Real-Time Indexing

For applications that need writes visible within seconds (chat search, news search, e-commerce), the segment-based model needs adaptation:

- Smaller segments (1MB instead of 100MB).
- Faster merge cycles.
- An in-memory write buffer that is queryable before it becomes a segment.
- Optional: explicit `refresh` API that flushes the in-memory buffer.

Lucene's NRT (Near Real Time) reader reads from in-memory segment buffers. Latency from write to query visibility: typically 1 second.

Vespa is more aggressive: writes are visible within a few hundred milliseconds via in-memory attribute structures and incremental index updates.

### Backfill and Reindex

When the analyzer or embedding model changes, the index must be rebuilt. This is the most expensive operation in a search system. Strategies:

- **Full reindex offline.** Build a new index from scratch. Run dual: serve queries from the old index until the new is ready, swap. Slow (hours to days), simple.
- **Reindex shard by shard.** Rebuild one shard at a time, redirect traffic.
- **Lazy reindex on read.** When a query hits a shard with stale analyzer, reindex on the fly. Rare, complicates query latency.

A senior team plans for reindexing as a regular operation. The cost of reindexing is a major factor in choosing how aggressive to be with model updates.

### Junior to FAANG

A junior tokenizes documents and ships. A senior at Bing or Google designs the pipeline with stage-level metrics, runs dedup at the right granularity (URL-level vs content-level vs near-duplicate), and tracks the quality regression of each stage's failure mode (when boilerplate removal fails, when language detection mis-identifies). A staff engineer thinks about reindex cost when proposing any analyzer or model change, treats the offline pipeline as a first-class system with its own SLAs (data freshness, throughput), and instruments per-doc-class throughput so that catastrophic ingestion patterns (a single broken source emitting 10x normal volume) are alertable. The interview question: "your search results are stale by 30 minutes. What do you change?" The senior answer covers segment size, NRT refresh interval, replication topology, and the cost of each.

---
