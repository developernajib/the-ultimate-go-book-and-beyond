## Inverted Index Fundamentals

An inverted index maps terms to the documents that contain them. Everything else in lexical search is a refinement of that one sentence. The reason it dominates over forward scan (looking at every document) is asymptotic: a term that appears in 0.1 percent of a billion-document corpus has a posting list of one million entries, not one billion. The reason it dominates over a B-tree is that the access pattern is sequential scan with skips, which is exactly what compressed integer codecs and CPU prefetchers are good at.

### The Three Tables

A production inverted index is three logical structures.

**Dictionary (term -> term-id, df, postings offset).** Holds every distinct term in the corpus. At web scale this is hundreds of millions of entries. Production dictionaries are a finite-state transducer (FST, as in Lucene) or a sorted block-encoded array (Vespa's `Btree` plus a fixed-prefix front-coding). Hash maps look attractive for O(1) lookup but lose to FSTs because (a) range scans for prefix queries become possible, (b) memory overhead is much lower (FSTs share suffixes), and (c) cache behavior is better.

**Posting list (per term).** A sequence of postings. A posting is at minimum a docID. For ranking it is a (docID, term frequency) pair. For phrase queries it is (docID, tf, positions[]). The list is sorted by docID, which is what allows compression and intersection.

**Document store (docID -> metadata).** Document length (needed for BM25 normalization), and possibly the document body for snippets. Often a separate columnar file because the access pattern (random by docID) differs from posting lists (sequential by term).

### Term Frequency, Document Frequency, IDF

For term t and document d:

- `tf(t, d)` = number of times t appears in d.
- `df(t)` = number of documents containing t.
- `N` = total documents.
- `idf(t) = log((N - df + 0.5) / (df + 0.5) + 1)`, the BM25-flavored IDF.

`df` lives in the dictionary entry, computed at index build time. `tf` lives per-posting. Position lists live alongside `tf` when phrase or proximity queries are supported.

### Postings Encoding

Storing raw 32-bit docIDs is wasteful. Sort the list and store gaps (delta-encoded), then compress the gaps with a variable-length integer code. A typical web search posting list compresses to under one byte per docID. Compression schemes are the next chapter, here we just establish the layout.

A common physical layout (Lucene-style):

```
posting list = [block][block][block]...[tail]
block        = 128 docID-deltas (compressed) + 128 tfs (compressed)
tail         = remainder (less than 128 entries, simpler encoding)
```

Block-aligned encoding matters because it lets the decoder use SIMD lanes of width 4 or 8 efficiently, and because skip pointers can target block boundaries.

### A Minimal C++ Inverted Index

Here is a from-scratch in-memory inverted index for a small corpus, no compression yet.

```cpp
#include <cstdint>
#include <vector>
#include <string>
#include <string_view>
#include <unordered_map>
#include <algorithm>
#include <cmath>

class InvertedIndex {
public:
    using DocId = std::uint32_t;
    using TermId = std::uint32_t;

    struct Posting {
        DocId doc;
        std::uint32_t tf;
    };

    void add_document(DocId doc, std::vector<std::string> tokens) {
        std::unordered_map<TermId, std::uint32_t> term_freqs;
        for (auto& tok : tokens) {
            TermId t = intern(std::move(tok));
            ++term_freqs[t];
        }
        for (auto [t, f] : term_freqs) {
            postings_[t].push_back({doc, f});
        }
        doc_length_[doc] = static_cast<std::uint32_t>(tokens.size());
        ++num_docs_;
    }

    void finalize() {
        for (auto& [t, list] : postings_) {
            std::sort(list.begin(), list.end(),
                      [](auto& a, auto& b) { return a.doc < b.doc; });
        }
        // Compute average doc length for BM25.
        std::uint64_t total = 0;
        for (auto& [d, l] : doc_length_) total += l;
        avg_dl_ = num_docs_ ? static_cast<double>(total) / num_docs_ : 0.0;
    }

    const std::vector<Posting>* postings(std::string_view term) const {
        auto it = dict_.find(std::string(term));
        if (it == dict_.end()) return nullptr;
        auto pit = postings_.find(it->second);
        return pit == postings_.end() ? nullptr : &pit->second;
    }

    double idf(std::string_view term) const {
        auto* p = postings(term);
        std::uint32_t df = p ? static_cast<std::uint32_t>(p->size()) : 0;
        return std::log((num_docs_ - df + 0.5) / (df + 0.5) + 1.0);
    }

    std::uint32_t doc_length(DocId d) const {
        auto it = doc_length_.find(d);
        return it == doc_length_.end() ? 0 : it->second;
    }

    double avg_doc_length() const { return avg_dl_; }
    std::uint32_t num_documents() const { return num_docs_; }

private:
    TermId intern(std::string s) {
        auto it = dict_.find(s);
        if (it != dict_.end()) return it->second;
        TermId id = static_cast<TermId>(dict_.size());
        dict_.emplace(std::move(s), id);
        return id;
    }

    std::unordered_map<std::string, TermId> dict_;
    std::unordered_map<TermId, std::vector<Posting>> postings_;
    std::unordered_map<DocId, std::uint32_t> doc_length_;
    std::uint32_t num_docs_ = 0;
    double avg_dl_ = 0.0;
};
```

This builds a working index. It is also nowhere near production. Three things are missing.

1. **Compression.** Posting lists held as `std::vector<Posting>` with full 32-bit fields are roughly 8 bytes per posting. Production targets one byte. Section 3 fixes this.
2. **Skip structure.** Iterating the posting list linearly to find a target docID is O(n). Section 4 adds skips and block-max.
3. **Dictionary structure.** `std::unordered_map<std::string, TermId>` is fine for a million terms. For a billion-term web dictionary it loses to an FST by 5-10x in memory.

### Junior to FAANG: What Changes

A junior implementation builds the index in memory and serializes it as one big file. A FAANG implementation builds **immutable segments**. Each segment is fully self-contained (its own dictionary, postings, doc store, skip structure) and is sealed once written. Updates create new segments. Deletes write a tombstone bitmap that future readers consult. Background compaction merges small segments into large ones. This is the design pattern that Lucene shipped in 2002 and that Vespa, Elasticsearch, and Manticore still use, because it solves four problems at once: write throughput (no contention with readers), crash recovery (segments are immutable so torn writes are detectable), compression (offline build sees the whole segment), and parallelism (search fans out across segments).

A senior search-infra interview question at Google or Meta will not ask you to implement an inverted index from scratch. It will ask: "explain why immutable segments beat in-place updates for a search index, and where the cost of compaction shows up." A good answer hits IO amplification, write/read tradeoffs, the role of merge policies (tiered vs leveled, like LSM trees), and the fact that pure-append plus background merge is the only structure where a 99th percentile query latency target survives concurrent indexing.

---
