## 79.9 Case Studies

The examples below are drawn from public engineering record. Where a system's internals are not public, the pattern is presented as illustrative rather than as a claim about how a specific company does it.

### Go's Own Migration to pdqsort

The best-documented sorting case study available to a Go engineer is the standard library's own. Go shipped a quicksort with a heapsort fallback for over a decade, then replaced it with pdqsort in Go 1.19. The change is instructive because of what did *not* motivate it: nobody discovered that quicksort was the wrong algorithm.

What changed was the recognition that real input is not random. Real slices are frequently already sorted, reverse sorted, nearly sorted, or full of duplicates, and the old implementation handled each of those cases at its generic O(n log n) rather than exploiting the structure. pdqsort's additions are all special cases for shapes real data actually has, and the sortedness hint from the pivot selection is free because the samples had to be examined anyway.

The transferable lesson: the win came from studying the input distribution, not from studying algorithms. That is nearly always where sorting wins come from.

### Database Query Engines: Sort as a Physical Operator

In any cost-based query optimizer, and Chapter 156 covers this in depth for C++ engines, `ORDER BY` does not compile to "call sort." It compiles to a physical operator the planner chooses among several:

- If an index already provides the order, the sort is **eliminated entirely**. This is the single largest sorting optimization in existence and it consists of not sorting.
- If the query has a `LIMIT`, the planner uses a **bounded heap** rather than a full sort, exactly the top-k pattern from section 79.6. `ORDER BY score DESC LIMIT 10` over ten million rows is a size-10 heap and one pass.
- If the data exceeds `work_mem`, the engine **spills to disk** and runs an external merge sort, the algorithm from section 79.8.

This is why "add an index" is the standard fix for a slow `ORDER BY`, and why `LIMIT` can change a query's plan and not merely truncate its output. Every strategy in this chapter appears in a mature query planner, chosen by cost rather than by preference.

### Log-Structured Storage: Amortizing the Sort Into Writes

LSM-tree storage engines, the family behind RocksDB, Cassandra, and many others, are built on the observation from section 79.8's senior lens: if you need sorted data continuously, do not sort repeatedly, keep it sorted.

Writes land in an in-memory sorted structure. When it fills, it is flushed to disk as an immutable sorted file, already in order. Background compaction merges those files with, precisely, a k-way merge over sorted runs. The sort cost is amortized into the write path and the merge, and a read never sorts anything.

The pattern to extract: the choice was not a faster sort. It was a data structure that makes the sort incremental. When you find code sorting the same data repeatedly, this is the shape of the fix.

### The Top-K Fan-Out

The distributed top-k structure from section 79.6 is the standard architecture for any "best N results" query at scale, and it is public in the general form: a coordinator asks each of p shards for its local top k, receives p*k candidates, and merges them into the global top k.

The correctness condition is the part worth internalizing, because it is where naive implementations break: this is valid only when each shard can score its own candidates without global information. Score by a stored per-item value and local top-k is exact. Score by anything corpus-wide (a term's inverse document frequency depends on the whole corpus) and a shard cannot rank its own items correctly, which forces the two-phase gather-statistics-then-rank design that real search engines use.

### Junior -> FAANG: What These Have in Common

Read the four cases together and one theme dominates: **the best sorting optimization is not sorting.** The query planner eliminates the sort with an index. The LSM tree keeps data sorted so it never re-sorts. Top-k fan-out sends k elements instead of n. Even pdqsort's biggest wins are detecting input that is already ordered and skipping the work.

Only Go's pdqsort migration is actually about making a sort faster, and even that one came from studying input shapes rather than algorithms.

When you are asked to make something faster in an interview, the impressive move is not a better sort. It is noticing the sort should not happen.

### Senior @ FAANG: The Cost-Based Instinct

The query planner is the model to internalize. It does not have a favorite sort. It has a cost model, statistics about the data, and a set of physical operators, and it chooses per query. That is exactly the posture a staff engineer should have toward sorting in application code: the right sort is a function of the data's size, shape, and location, and any team that has a single blessed answer is wrong some of the time.

The concrete artifact this produces in a design review is a small decision record: what is being ordered, how large is it, where does it live, what consumes the order, and does an index or an incrementally-maintained structure remove the need. Five questions, and they resolve nearly every real sorting decision without anyone naming an algorithm.
