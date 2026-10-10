## Skip Lists and Block-Max Top-k Retrieval

A boolean intersection between two posting lists of length n and m, both sorted, is in the worst case O(n + m). For real queries, "the" appears in nearly every document and "machine" in 5 percent, so the gallop-merge between them visits most of the long list even though most of those entries cannot match. Skip pointers and block-max scoring let us skip past entries that **cannot** survive the top-k filter, and they are the single most important algorithmic idea in modern lexical search since BM25 itself.

### Skip Pointers

Lucene's posting layout (since 2.0) places a skip table alongside the posting list. Conceptually:

```
postings: [d_0 ... d_127][d_128 ... d_255]...   blocks of 128
skips L0: every 128th docID + offset to that block
skips L1: every 128*8 = 1024th docID + offset
skips L2: every 128*8*8 = 8192nd docID + offset
```

Multi-level skips give logarithmic descent. To find the smallest docID >= target:

```cpp
struct SkipReader {
    std::vector<DocId> level_keys;   // level i, key for every block
    std::vector<std::size_t> level_offsets;
    // ...

    void advance_to(DocId target, BlockReader& r) {
        // Walk top level down to L0, choosing the largest key <= target.
        // Then point r at that block and let r linearly scan within block.
    }
};
```

Skip pointers turn intersection into a series of "jump to next candidate block" operations. The cost is paying for the skip table (a few percent of posting size) and a small index-time complexity bump.

### Disjunctive Top-k: WAND

For multi-term queries (the common case), we want top-k by score, not all matches. WAND (Weak AND, Broder et al. 2003) is the foundational algorithm.

Setup: each term has a posting iterator. We track an upper bound `UB(t)` on the score any single document can earn from term t. The current top-k threshold is `theta` (the smallest score in our heap of size k).

WAND main loop:

1. Sort iterators by current docID.
2. Find pivot: the smallest index p such that `sum(UB(t_0..t_p)) >= theta`. This is the smallest set of terms that, even at maximum score, could beat theta.
3. If iterators 0..p-1 all point to the same doc as p, this document is a candidate. Score it fully. If its score beats theta, push to heap and update theta.
4. Otherwise, advance one of iterators 0..p-1 forward to at least the pivot docID. Skip pointers make this cheap.
5. Repeat.

The trick is that documents only matched by low-UB terms are skipped without ever being scored. On a typical 3-word query, WAND scores a small fraction of the candidate union.

```cpp
struct TermCursor {
    PostingIterator it;
    double ub;            // term upper bound, precomputed
    double idf;
    DocId current() const { return it.current(); }
    void next() { it.next(); }
    void advance_to(DocId t) { it.advance_to(t); }
};

std::vector<Hit> wand_top_k(std::vector<TermCursor>& cursors, std::size_t k) {
    TopKHeap heap(k);
    double theta = 0.0;

    while (true) {
        std::sort(cursors.begin(), cursors.end(),
                  [](auto& a, auto& b) { return a.current() < b.current(); });

        // Find pivot.
        double accum = 0.0;
        std::size_t pivot = SIZE_MAX;
        for (std::size_t i = 0; i < cursors.size(); ++i) {
            accum += cursors[i].ub;
            if (accum >= theta) { pivot = i; break; }
        }
        if (pivot == SIZE_MAX) break;  // No more candidates can beat theta.

        DocId pivot_doc = cursors[pivot].current();
        if (cursors[0].current() == pivot_doc) {
            double s = full_score(cursors, pivot_doc);
            if (s > theta) {
                heap.push({pivot_doc, s});
                if (heap.full()) theta = heap.threshold();
            }
            cursors[0].next();
        } else {
            // Advance the lowest non-pivot cursor up to pivot_doc.
            cursors[0].advance_to(pivot_doc);
        }
    }
    return heap.results();
}
```

The `ub` per term is `idf(t) * max_tf_norm(t)`, where `max_tf_norm` is the maximum value of the BM25 TF saturation term `(tf * (k1+1)) / (tf + k1 * (1 - b + b * dl/avgdl))` across all documents containing t. Computing it requires a pass over the postings at index time.

### Block-Max WAND (BMW)

WAND's bound is global per term. BMW (Ding and Suel, 2011) refines: for each block of 128 postings, store a tighter per-block max score. Then during the pivot check, use the **block-max** of each cursor's current block instead of the global UB.

This produces dramatically tighter pivots, which translates to dramatically more skips. Reported speedups in the original paper: 2-3x over WAND, sometimes 5x on long queries.

Implementation cost: a per-block max-score table, typically 4 bytes per block. For a 128-posting block, that is 0.03 bits per posting. Free.

```cpp
struct TermCursor {
    PostingIterator it;
    std::vector<float> block_max;     // BMW addition
    double current_block_max() const {
        return block_max[it.block_index()];
    }
};
```

Inside the WAND loop, replace `cursors[i].ub` with `cursors[i].current_block_max()` (which the iterator updates as it crosses block boundaries). Add a check: if the pivot is at end of its block but the next block's block-max with surviving cursors does not beat theta, advance directly past the block.

### MaxScore

MaxScore (Turtle and Flood 1995) is older than WAND and uses a different idea. Sort terms by UB ascending. The terms whose UB sum cannot beat theta are "non-essential": a document has to match at least one essential term to be a candidate. The algorithm processes essential terms by docID and lazily scores non-essentials only when necessary.

MaxScore tends to win on long queries (10+ terms) where many terms are essentially noise (low UB, very high df). WAND/BMW tend to win on short queries.

Production engines (Lucene, Vespa, Pisa) ship both and pick at query time based on heuristics on query length and term UB distribution. Vespa's documentation explicitly mentions WAND for short queries and a MaxScore variant for long ones.

### Block-Max MaxScore

The natural cousin: MaxScore using block-max UBs. Generally the best of both worlds. Mallia, Ottaviano, Porciani, Tonellotto, Venturini (2017) showed that BMM and BMW have similar throughput, with BMM winning on long queries.

### Conjunctive Acceleration

For pure AND queries (all terms must match), the basic algorithm is "advance the cursor with the smallest current docID, gallop other cursors to it". Skip pointers make each gallop logarithmic in posting length. This is what Lucene's `ConjunctionScorer` does. Block-max contributes nothing to pure AND, since every match is required.

### Practical C++ Tips

1. Iterator devirtualization. The `next()` and `advance_to()` calls happen millions of times per query. If the iterator is held behind a virtual interface, the indirect call cost is brutal. Lucene uses a `BulkScorer` interface that processes a block of postings at a time to amortize the dispatch. In C++, prefer CRTP or `std::variant` over `std::function` and `unique_ptr<Iter>`.

2. SIMD top-k threshold compare. After scoring a block, a vectorized comparison of all 128 scores against theta lets you skip most of the heap pushes.

3. Lazy IDF. The IDF for a term is constant across the query, compute once, not per scoring call.

4. Heap structure. A `std::priority_queue<Hit, std::vector<Hit>, std::greater<>>` is fine up to k=10000. Above that, switch to a sorted ring or a tree. For the typical k=10 use, the heap is tiny and theta updates are O(log k).

### Junior to FAANG

A junior search engineer can describe BM25 and posting lists. A FAANG-bar senior search engineer can sketch BMW from memory, explain why the global UB bound is loose enough to motivate block-max in the first place, and discuss when MaxScore wins. They also know the secret: in real systems, the pivot reordering trick (sort cursors by docID inside the WAND loop) is itself a measurable cost, and several engines use a partial sort or a two-pass scheme to amortize it. If you cannot debate the trade-off between full sort and "swap into position" inside the WAND inner loop, you are not at the senior bar yet.

---
