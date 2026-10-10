## Designing an End-to-End Vector Search Engine in C++23

This chapter walks through a small but realistic vector search engine in modern C++. It is not a toy: it has HNSW for similarity, Roaring bitmaps for filters, immutable segments for the build pipeline, and a thread-per-shard execution model. It is also not Vespa: features like distributed coordination and replication are out of scope. The goal is to anchor the previous twenty chapters in working code that compiles, runs, and demonstrates the design choices that matter.

### Requirements

- Documents have a 768-dim embedding and a small set of metadata fields (category, language, recency_score).
- Queries are (query_vector, k, filters). Filters are conjunctions of metadata predicates.
- Target: 100 ms p99 on a 10M-document corpus, single host.
- Updates: support insert and delete with NRT visibility.
- Persistence: index can be persisted to disk and reloaded.

### High-Level Architecture

```
        [Indexer]                  [Searcher]
            |                          |
            v                          v
       writable_segment <--read-- segment_set
            |                          |
            | seal                     |
            v                          |
       sealed_segment ------add-->     |
            |                          |
            | merge (background)       |
            v                          |
       merged_segment <--read----------+
```

A single index is a list of immutable segments plus one writable segment. Inserts go to the writable segment, periodic refresh seals it and adds it to the segment list. A background merger combines small segments into bigger ones.

A query runs against all segments in parallel, top-K from each is merged.

### Core Types

```cpp
namespace vse {

using DocId = std::uint32_t;

struct Document {
    DocId id;
    std::array<float, 768> embedding;   // L2-normalized
    std::uint16_t category;
    std::uint8_t language;
    float recency_score;
};

struct Filter {
    std::optional<std::vector<std::uint16_t>> categories;
    std::optional<std::uint8_t> language;
    std::optional<float> min_recency;
};

struct Query {
    std::array<float, 768> vector;
    std::uint32_t k;
    Filter filter;
    std::chrono::milliseconds budget;
};

struct Hit { DocId doc; float score; };

}  // namespace vse
```

### Segment Layout

```cpp
namespace vse {

class Segment {
public:
    virtual ~Segment() = default;
    virtual std::vector<Hit> search(const Query& q, std::size_t k) const = 0;
    virtual std::size_t size() const = 0;
    virtual bool is_sealed() const = 0;
    virtual void mark_deleted(DocId doc) = 0;
    virtual void persist(const std::filesystem::path&) const = 0;
};

class SealedSegment final : public Segment {
public:
    SealedSegment(std::unique_ptr<HnswIndex> hnsw,
                  RoaringBitmaps filter_bitmaps,
                  std::vector<Document> docs)
      : hnsw_(std::move(hnsw))
      , filters_(std::move(filter_bitmaps))
      , docs_(std::move(docs))
    {}

    std::vector<Hit> search(const Query& q, std::size_t k) const override {
        // Build a candidate bitmap from filter predicates.
        auto allowed = filters_.evaluate(q.filter);
        if (allowed.empty()) {
            return hnsw_->search(q.vector.data(), k, &deleted_);
        }
        return hnsw_->search_with_filter(q.vector.data(), k, allowed, &deleted_);
    }

    std::size_t size() const override { return docs_.size(); }
    bool is_sealed() const override { return true; }
    void mark_deleted(DocId doc) override { deleted_.insert(doc); }
    void persist(const std::filesystem::path& dir) const override;

private:
    std::unique_ptr<HnswIndex> hnsw_;
    RoaringBitmaps filters_;
    std::vector<Document> docs_;
    std::unordered_set<DocId> deleted_;  // tombstones
};

class WritableSegment final : public Segment {
public:
    void add(Document doc) {
        std::lock_guard lg(mu_);
        // Brute-force search until sealed.
        docs_.push_back(std::move(doc));
    }

    std::vector<Hit> search(const Query& q, std::size_t k) const override {
        std::lock_guard lg(mu_);
        std::vector<Hit> hits;
        hits.reserve(docs_.size());
        for (auto& d : docs_) {
            if (deleted_.count(d.id)) continue;
            if (!matches(d, q.filter)) continue;
            float s = inner_product(d.embedding.data(), q.vector.data(), 768);
            hits.push_back({d.id, s});
        }
        std::partial_sort(hits.begin(),
                          hits.begin() + std::min(k, hits.size()),
                          hits.end(),
                          [](auto& a, auto& b) { return a.score > b.score; });
        if (hits.size() > k) hits.resize(k);
        return hits;
    }

    std::size_t size() const override {
        std::lock_guard lg(mu_);
        return docs_.size();
    }

    bool is_sealed() const override { return false; }

    void mark_deleted(DocId doc) override {
        std::lock_guard lg(mu_);
        deleted_.insert(doc);
    }

    std::vector<Document> drain() {
        std::lock_guard lg(mu_);
        std::vector<Document> out;
        out.swap(docs_);
        return out;
    }

private:
    mutable std::mutex mu_;
    std::vector<Document> docs_;
    std::unordered_set<DocId> deleted_;
};

}  // namespace vse
```

The writable segment uses brute-force scoring. This is fine for small sizes (a few thousand docs), we seal before it grows unwieldy.

### HNSW Wrapper

We wrap hnswlib for the sealed segments:

```cpp
namespace vse {

class HnswIndex {
public:
    HnswIndex(std::size_t max_elements, int M = 16, int ef_construction = 200)
      : space_(768),
        index_(&space_, max_elements, M, ef_construction)
    {}

    void add(DocId id, const float* vec) {
        index_.addPoint(vec, id);
    }

    std::vector<Hit> search(const float* query, std::size_t k,
                            const std::unordered_set<DocId>* deleted) const {
        index_.setEf(std::max<int>(50, k * 2));
        auto raw = index_.searchKnn(query, k * 2);  // overshoot for delete filter
        std::vector<Hit> out;
        out.reserve(k);
        while (!raw.empty() && out.size() < k) {
            auto [score, id] = raw.top();
            raw.pop();
            DocId doc = static_cast<DocId>(id);
            if (deleted && deleted->count(doc)) continue;
            out.push_back({doc, -static_cast<float>(score)});  // hnswlib returns -ip
        }
        std::reverse(out.begin(), out.end());
        return out;
    }

    std::vector<Hit> search_with_filter(const float* query, std::size_t k,
                                        const RoaringBitmap& allowed,
                                        const std::unordered_set<DocId>* deleted) const;

private:
    hnswlib::InnerProductSpace space_;
    hnswlib::HierarchicalNSW<float> index_;
};

}  // namespace vse
```

For the filtered search we either post-filter (cheap when the filter is loose) or use hnswlib's filter functor (better when the filter is tight). Production systems do something more clever (chapter 11), but post-filter with overshoot is enough for our scale.

### Index Manager

Coordinates the writable segment, sealing, and the segment list:

```cpp
namespace vse {

class Index {
public:
    Index() : writable_(std::make_unique<WritableSegment>()) {}

    void add(Document doc) {
        writable_->add(std::move(doc));
        if (writable_->size() >= seal_threshold_) {
            seal();
        }
    }

    void remove(DocId doc) {
        std::shared_lock lg(segments_mu_);
        writable_->mark_deleted(doc);
        for (auto& s : sealed_) s->mark_deleted(doc);
    }

    std::vector<Hit> search(const Query& q) {
        std::vector<std::shared_ptr<Segment>> snapshot;
        {
            std::shared_lock lg(segments_mu_);
            snapshot = sealed_;
            snapshot.push_back(writable_);
        }

        std::vector<std::future<std::vector<Hit>>> futures;
        futures.reserve(snapshot.size());
        for (auto& s : snapshot) {
            futures.push_back(std::async(std::launch::async, [&, s] {
                return s->search(q, q.k);
            }));
        }

        std::vector<Hit> all;
        for (auto& f : futures) {
            auto hits = f.get();
            all.insert(all.end(), hits.begin(), hits.end());
        }

        std::partial_sort(all.begin(),
                          all.begin() + std::min<std::size_t>(q.k, all.size()),
                          all.end(),
                          [](auto& a, auto& b) { return a.score > b.score; });
        if (all.size() > q.k) all.resize(q.k);
        return all;
    }

    void seal() {
        auto drained = writable_->drain();
        if (drained.empty()) return;

        auto hnsw = std::make_unique<HnswIndex>(drained.size(), 16, 200);
        RoaringBitmaps filters;
        for (auto& d : drained) {
            hnsw->add(d.id, d.embedding.data());
            filters.add(d);
        }
        auto sealed = std::make_shared<SealedSegment>(
            std::move(hnsw), std::move(filters), std::move(drained));

        {
            std::unique_lock lg(segments_mu_);
            sealed_.push_back(std::move(sealed));
        }

        merger_.maybe_merge(sealed_);
    }

private:
    std::shared_mutex segments_mu_;
    std::vector<std::shared_ptr<Segment>> sealed_;
    std::shared_ptr<WritableSegment> writable_;
    std::size_t seal_threshold_ = 10'000;
    Merger merger_;
};

}  // namespace vse
```

The `std::shared_mutex` allows concurrent searches while writes (which take an exclusive lock) are rare.

### Background Merging

A separate thread periodically picks small segments to merge. The strategy is tiered (small with small).

```cpp
class Merger {
public:
    void maybe_merge(std::vector<std::shared_ptr<Segment>>& segments) {
        // Pick segments smaller than a threshold - merge them into one.
        // Sketch: collect, build new HNSW from union, atomically swap in.
    }
};
```

Details left as an exercise (one of the labs in chapter 24).

### Threading Model

- One thread per query (created via `std::async`).
- Search inside a segment is single-threaded.
- HNSW supports concurrent reads, so multiple queries can hit the same segment in parallel.
- Writes take an exclusive lock on the writable segment.
- Sealing takes an exclusive lock on the segment list briefly.
- Merging runs on a dedicated thread, the swap is brief.

### Persistence

Each sealed segment serializes:

- The HNSW index (hnswlib's `saveIndex`).
- The roaring bitmaps for filters.
- The document store (a flat file with fixed-size records).
- A delete bitmap.

Loading: read each segment from disk, populate the segment list. The writable segment starts empty.

### API

A simple HTTP service wraps `Index`. `POST /docs` for inserts, `DELETE /docs/{id}` for removes, `POST /search` for queries. With Boost.Beast or a similar library, this is a couple hundred more lines.

### What Is Missing Compared to Production

- Replication and distributed coordination.
- Sophisticated merge policy.
- Compaction-aware delete bitmaps.
- Quantization (PQ) for memory efficiency.
- Crash recovery via translog.
- Per-field BM25 (lexical retrieval).
- A query rewriter and processor.
- Real authentication and rate limiting.

Each is its own subsystem and adds an order of magnitude of code.

### Junior to FAANG

A junior writes a vector search engine that works on 100k vectors. A senior writes one that scales to 10M with NRT updates and survives a power loss. A staff engineer writes one that survives a bad release: graceful degradation when the merge thread crashes, when a segment file is corrupted, when the embedding model produces NaNs. The interview question: "your engine returns stale results after a crash. Why and how to fix?" Senior answer covers translog, fsync semantics, recovery on startup, and the cost of fsync on insert latency. Great answer adds: discusses the crash-test plan, mentions tools like `aflfuzz` for testing the segment loader, and notes that the cheapest crash recovery is "rebuild from source if source is durable elsewhere".

---
