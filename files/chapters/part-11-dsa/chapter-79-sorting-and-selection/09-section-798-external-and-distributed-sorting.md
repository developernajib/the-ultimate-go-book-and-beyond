## 79.8 External and Distributed Sorting

"Sort 10 TB with 64 GB of RAM" is a standard system design question and a real engineering problem. It is also where every property from the earlier sections stops being academic: mergesort's sequential access wins, quicksort's random access loses, and stability becomes a merge-time decision.

### External Merge Sort

The classic answer has two phases.

**Phase 1, sort runs.** Read as much as fits in memory, sort it, write it to a temporary file. Repeat until the input is consumed. With 10 TB of input and, say, 32 GB usable, this produces roughly 320 sorted runs.

**Phase 2, k-way merge.** Open all runs, and repeatedly emit the smallest unconsumed record across them. A heap over the run heads makes each step O(log k).

```go
// mergeRuns performs a k-way merge over sorted streams using a heap
// of one head element per run. Memory is O(k), not O(n).
type runHead struct {
    val Record
    run int
}

func mergeRuns(runs []*bufio.Reader, out *bufio.Writer) error {
    h := &runHeap{} // min-heap ordered by val
    heap.Init(h)

    // Prime the heap with the first record of each run.
    for i, r := range runs {
        if rec, err := readRecord(r); err == nil {
            heap.Push(h, runHead{rec, i})
        } else if err != io.EOF {
            return err
        }
    }

    for h.Len() > 0 {
        top := heap.Pop(h).(runHead)
        if err := writeRecord(out, top.val); err != nil {
            return err
        }
        // Refill only from the run we just consumed from.
        if rec, err := readRecord(runs[top.run]); err == nil {
            heap.Push(h, runHead{rec, top.run})
        } else if err != io.EOF {
            return err
        }
    }
    return out.Flush()
}
```

Three properties make this work, and each is a lesson from earlier sections:

- **Memory is O(k), not O(n).** Only one record per run is resident. This is the bounded-heap idea from section 79.6 again.
- **All I/O is sequential.** Every run is read front to back and the output is written front to back. On any storage medium, this is the access pattern that performs best, and it is why mergesort rather than quicksort is the basis of external sorting.
- **Stability is a tie-break on run index.** If two records compare equal, emitting the one from the earlier run preserves the original order, provided phase 1's sort was stable. Stability is not automatic here, it is something the merge comparison chooses to provide.

The knob is k. Too many runs and you have too many open files and too little buffer per stream, so reads stop being usefully sequential. Too few and phase 1 needs more memory per run. When k exceeds what one pass can handle, you merge in multiple passes, and total I/O becomes O(n log_k(n/M)) rather than O(n).

### Distributed Sorting

Across machines the bottleneck changes from disk to network, and the question becomes how to partition.

**Sample sort** is the standard approach and it is bucket sort from section 79.5 with the bucket boundaries learned from the data:

1. Sample the dataset, a small random subset from every node.
2. From the sample, choose p-1 splitters that divide the key space into p roughly equal partitions.
3. Every node partitions its local data by those splitters and shuffles each partition to the node that owns it.
4. Every node sorts its partition locally, with an external merge sort if needed.
5. The global order is now node 0's data, then node 1's, and so on. **No final merge is required.**

Step 5 is the elegant part and the answer to the design question. If the consumer can read partitions in order, the sort is finished when the local sorts finish. You never materialize a single global stream.

Step 2 is where it fails in practice. Skewed keys produce unequal partitions, one node gets a disproportionate share, and that straggler sets the job's completion time. This is the same skew problem that makes a `GROUP BY` on a hot key slow, and the mitigations are the same: sample more, split the hot keys across nodes with a salt, or handle heavy hitters separately.

### Sorting Less

The most valuable move in this section is to sort something smaller than the records.

```go
// Instead of moving 500-byte records, sort 16-byte (key, offset) pairs
// and materialize the output once, at the end.
type keyRef struct {
    key    uint64
    offset int64
}
```

If a record is 500 bytes and the key is 8, sorting (key, offset) pairs cuts the bytes moved by more than 30x. Every swap becomes cheap, far more of the working set fits in cache, and the full records are touched exactly once when writing output. This is the representation lever from section 79.5, and at terabyte scale it is frequently the difference between a job that finishes and one that does not.

### Junior -> FAANG: The Script for "Sort 10 TB"

This question has a structure, and the structure is the answer.

Do not start with an algorithm. Start with four questions, because they determine everything: How big is a record, and how big is the key? Are the keys bounded integers or arbitrary? Must the output be one sorted stream, or is globally-ordered-across-shards enough? One machine or many?

Then give the two-phase answer: sort runs that fit in memory, write them out, k-way merge with a heap. State the memory (O(k) for the merge, one buffer per run) and the I/O (sequential everywhere, roughly 2 reads and 2 writes of the dataset for a single-pass merge).

Then volunteer the optimization: sort (key, offset) pairs rather than whole records. Interviewers are waiting for it, and offering it unprompted lands well.

If they extend to multiple machines, the answer is sample sort: sample, choose splitters, shuffle, sort locally, done. Name skew as the failure mode before they ask.

### Senior @ FAANG: The Sort You Do Not Do

The staff-level observation is that terabyte sorts are usually a symptom. Ask why the data must be sorted at all, and the answer is often something a different structure provides more cheaply.

If the sort feeds a range query, an index answers range queries without ever sorting the base data. If it feeds a top-k, section 79.6 does it in one pass with a bounded heap. If it feeds a join, a hash join beats a sort-merge join when one side fits in memory. If it feeds deduplication, a hash set or a Bloom filter pre-pass costs a fraction. If it runs nightly over data that arrives continuously, an LSM tree keeps the data sorted incrementally and amortizes the cost into the writes, which is exactly what Chapter 37B's storage engines do.

Sort-merge join earns its keep in the specific case where both sides are enormous, neither fits in memory, and one or both are already sorted by the join key, at which point the sort was already paid for. The genuinely irreducible cases are narrow: a total order is contractually required (a ledger export), or the consumer is an external system that demands sorted input.

The design review question, then, is not "which sort algorithm?" It is "what consumes this order, and can that consumer be satisfied without a total order?" The best sort is the one you deleted.
