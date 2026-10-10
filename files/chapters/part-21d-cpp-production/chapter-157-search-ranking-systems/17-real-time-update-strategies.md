## Real-Time Update Strategies

Search engines built on immutable segments give up in-place updates by design. Adding a new document is cheap (append to the writable segment), modifying an existing document is "delete plus insert", which leaves a tombstone. The art is making this look real-time to users while keeping the underlying invariants that make immutable segments fast.

### The Lucene Model

Lucene (and Elastic, Solr, OpenSearch on top of it) is the canonical reference. The index is a sequence of segments. New writes go to an in-memory `IndexWriter` buffer. The buffer holds:

- Pending added documents.
- Pending deletes (a set of (docID, segmentID) pairs marking deletions).

A `flush` operation seals the buffer into a new segment on disk. A `commit` operation makes new segments durable and visible to **new** readers. A `refresh` operation makes them visible **without** durability (in-memory only), giving NRT visibility.

```
   IndexWriter
      |
      v
[in-memory buffer]   <-- writes go here
      |
      | flush
      v
[new segment file]   <-- sealed, immutable
      |
      | merge (background)
      v
[merged segments]
```

A reader holds a snapshot of segments. After `refresh`, a new reader can be opened that sees the latest snapshot. Old readers remain valid until they are released, their segments are reference-counted.

### NRT Latency

The time from `addDocument` to "queryable" is the NRT latency. For Lucene defaults (refresh every 1 second), it is ~1 second. Tuning:

- More frequent refresh -> lower NRT latency, more small segments, more merge load.
- Less frequent refresh -> higher NRT latency, less merge load, lower CPU.

Production tuning depends on workload. A news search wants 1-second NRT. A web crawl can tolerate hours. An e-commerce inventory update needs seconds for in-stock changes to be visible.

### Vespa's More Aggressive Model

Vespa keeps a separate **attribute** structure for fields that need real-time updates (price, stock, popularity). Attributes are in-memory column stores, modified in place. Document data is in segments (Vespa calls them "buckets"), updated via the segment-merge model.

The split: lexical postings live in segments (hard to update). Numeric/scalar fields and dense vector fields used for ranking live in attributes (easy to update). A query can use both: BM25 from segments, recency boost from attributes. The recency boost can be live within milliseconds.

### ANN Index Real-Time Updates

For HNSW, real-time inserts are doable: hnswlib supports concurrent insert + search. Performance degrades with insert rate, serving QPS drops as insert load rises.

Deletes in HNSW are harder (chapter 09). Three approaches:

1. **Tombstone + filter at result collection.** Lose some quality (deleted node still consumes graph capacity, search visits it).
2. **Mark-and-replace.** Reuse deleted slots when new inserts arrive. Good for steady-state, bad if the fill pattern is uneven.
3. **Periodic rebuild.** Build a fresh HNSW in the background, swap atomically.

For IVFPQ, deletes are simpler: remove from the cell's posting list. Inserts are simpler: append to the closest cell's posting list. The downside is cluster drift, if the corpus changes substantially, the original cluster centroids no longer reflect the data, and quality degrades. Periodic centroid retraining is required.

### Replication and Real-Time

Replicating writes across replicas takes time. The user-visible latency is `write to primary + replicate to followers + refresh on followers`. With sync replication and aggressive refresh, this is typically 100-500 ms.

For very-low-latency requirements, async replication with a "best-effort" guarantee is sometimes used. The primary acknowledges immediately, followers catch up later. Risk: if the primary fails before replication, the write is lost. Acceptable for some workloads (logs, telemetry), unacceptable for others (orders, transactions).

### Write Throughput

A single Lucene IndexWriter handles ~10k-100k docs/second depending on document size and analysis cost. Higher throughput requires sharding (multiple writers, each owning a shard).

For very-high-throughput indexing (web crawl, log pipelines), the dominant cost is analysis (tokenization, language detection, embedding). Embedding is the expensive one, a 110M-parameter encoder on GPU does ~5k docs/second. To exceed that, the embedding stage runs on a fleet, not a single host, and the indexer consumes a queue of pre-embedded documents.

### Crash Recovery

Each segment is durable on disk after `commit`. If the process crashes:

- Segments committed before the crash survive.
- The in-memory buffer is lost.
- A write-ahead log (transaction log) replays uncommitted writes.

Lucene calls this the **translog**. Each write is appended to the translog before going into the in-memory buffer. On startup, the translog is replayed to restore the buffer state. After a flush, the corresponding translog entries can be discarded.

Vespa uses a similar mechanism. The translog is a per-shard append-only log.

### Update Visibility Semantics

Subtle: when a user updates a document and immediately queries, do they see their update?

- **Read-your-writes.** Yes, the user sees their update. Requires either (a) routing the query to the same replica that took the write, with a read-after-write consistency, or (b) waiting for the refresh that includes the write.
- **Eventual visibility.** Maybe not immediately, but within the NRT window.
- **Strong consistency.** Always see latest committed write. Needs synchronous replication and read-side coordination, expensive.

Most search systems offer eventual visibility by default. Read-your-writes is opt-in (e.g., Elasticsearch's `?refresh=wait_for` parameter blocks the write until the next refresh, making the result immediately queryable).

### Garbage Collection of Old Segments

After segments merge, the old segments are no longer referenced by any reader. Eventually the file system can reclaim the space. Lucene refcounts segments, the count drops to zero when all readers using them are released. The Lucene `Directory` then deletes the underlying files.

Background merging plus segment refcounting plus translog rotation give a complete picture: writes accumulate, segments are built, merges happen, old segments are released, files are deleted. The system reaches a steady state where input rate matches merge rate matches deletion rate.

### C++ Real-Time Index Sketch

```cpp
class IndexWriter {
public:
    void add(const Document& doc) {
        auto entry = analyze(doc);
        translog_.append(entry);
        {
            std::lock_guard lg(buffer_mu_);
            buffer_.push_back(std::move(entry));
        }
        maybe_flush();
    }

    void refresh() {
        std::vector<AnalyzedDoc> to_seal;
        {
            std::lock_guard lg(buffer_mu_);
            to_seal.swap(buffer_);
        }
        if (to_seal.empty()) return;
        auto seg = build_segment(to_seal);
        segments_.add(std::move(seg));
        // Notify readers via SegmentRegistry change broadcast.
        registry_.publish_snapshot(segments_.snapshot());
    }

    void commit() {
        refresh();
        translog_.fsync();
        translog_.rotate();
    }

private:
    Translog translog_;
    std::mutex buffer_mu_;
    std::vector<AnalyzedDoc> buffer_;
    SegmentList segments_;
    SegmentRegistry registry_;
};
```

Production code adds: per-segment merge management, configurable refresh interval, deletion handling, and concurrent reader registration.

### Junior to FAANG

A junior calls `addDocument` and prays. A senior at Bing or Vespa understands the segment lifecycle (create, seal, merge, release), tunes the merge policy for the workload, and instruments NRT latency as a top-level SLO. A staff engineer at Lucene or OpenSearch knows the translog format, debug merges that misbehave (a runaway merge that holds a lock for minutes), and reasons about the interaction between replication and refresh under load. The interview question: "your NRT latency p99 is 5 seconds, target is 1 second, what's wrong?" Senior answer: profile the refresh path, check buffer sizes, segment counts, merge backpressure, and replication lag, fix the dominant component. Great answer adds: the remediation may be moving from segment-based attributes to in-memory attributes for the fields that matter, accepting that lexical postings stay in segments.

---
