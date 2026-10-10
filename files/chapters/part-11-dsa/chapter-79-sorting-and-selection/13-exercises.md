## Exercises

1. **Prove your mergesort is stable.** Implement mergesort over a slice of `struct{Key, Seq int}`, sort by `Key` only, and write a test asserting that for equal keys the `Seq` values remain ascending. Then change the merge's `<=` to `<` and watch the test fail. Keep both tests as documentation of what that character does.

2. **Break the textbook quicksort.** Implement the Lomuto partition with the last element as pivot, then construct three inputs that drive it quadratic: already sorted, reverse sorted, and all-equal. Instrument the comparison count and plot it against n. Then add median-of-three pivot selection and re-run: two of the three inputs get fixed, one does not. Explain which and why, then fix it with a three-way partition.

3. **Quickselect versus heap versus sort.** Implement all three top-k approaches. Benchmark them across k = 1, 10, 1000, 100000 with n = 1,000,000. Find the crossover points where each becomes the best choice and explain the shape of the results. The k where sorting starts to win is the interesting one.

4. **The overflow comparator.** Write a test that sorts `[]int{math.MinInt, 1, 0}` with the comparator `func(a, b int) int { return a - b }` and assert the result is wrong. Fix it with `cmp.Compare` and assert it is right. This is a 10-line exercise that will save you a production incident someday.

5. **External merge sort.** Generate a 2 GB file of random fixed-width records. Sort it using no more than 256 MB of resident memory: chunk, sort, spill, then k-way merge with a heap. Verify the output is sorted and is a permutation of the input (compare sorted checksums, not just line counts). Measure the wall-clock split between phase 1 and phase 2, and vary the run size to find the sweet spot.

6. **Sort less data.** Extend exercise 5: instead of sorting records, sort (key, offset) pairs and materialize the output in a final pass. Measure the difference. Report bytes moved as well as time, since that is the quantity you actually changed.

7. **Radix versus pdqsort.** Implement LSD radix sort for `[]uint32` and benchmark it against `slices.Sort` at n = 1e3, 1e5, 1e7. Find where, or whether, radix wins on your machine. Then repeat with `[]uint64` and explain what changed. If radix never wins, that is a legitimate and instructive result: report it with the numbers.

8. **Detect the unstable dependency.** Take a slice of 20 structs with duplicate keys. Sort with `slices.SortFunc` and record the tie order. Now sort a 10-element subset the same way. Explain why the small one looks stable and the large one does not, referring to pdqsort's `maxInsertion` threshold. This is the production bug from section 79.10, reproduced deliberately.

### Junior -> FAANG: Scaffolded Walkthrough for Exercise 3

Exercise 3 is the one to do first, because it builds the reflex the interview tests.

The scaffold. Write `topKSort`, `topKHeap`, and `topKQuickselect`, all returning the k largest as an unordered slice so the comparison is fair. Use `testing.B` with `b.Loop()` and reset the input inside the loop, since quickselect mutates and you would otherwise be timing a sort of already-sorted data on iteration two. That mistake invalidates more benchmarks than any other.

The success criterion is not "the heap wins." It is that you can explain the shape you observe. Expect the heap to dominate for small k, quickselect to win in the middle, and sort to catch up as k approaches n, at which point you are doing a full sort anyway plus overhead. When you find the crossover, you have derived section 79.6's decision table from measurement rather than taking it on faith, and you will never forget it.

The first-job reflex to build while doing this: notice how much of the benchmark work is setup rather than algorithm. Getting the measurement honest, resetting inputs, avoiding a warmed cache, using `b.Loop()`, is most of the job. That is true of performance work generally.

### Senior @ FAANG: Staff Extensions

**Exercise 5 extension: make it a platform decision.** Turn the external sort into a service-level policy. What is the spill directory, is it on the same disk as the WAL (it should not be), what happens when the disk fills mid-sort, what is the cleanup path when the process is killed between phases, and how is the temp space accounted against a quota. Deliverable: a one-page runbook naming the failure modes and the owner, not just working code. Every one of those questions has caused a real outage somewhere.

**Exercise 3 extension: kill the sort.** Take a service that sorts on a request path and make the sort disappear. Options: maintain a sorted structure incrementally, cache the sorted view keyed by a data version stamp, or push the order into an index. Deliverable: a before-and-after profile and an ADR explaining why the chosen approach fits the read/write ratio. The grading question is whether you measured the read/write ratio before choosing, because that ratio is the entire basis of the decision.

**Bar-raiser variant: the skew problem.** Implement sample sort across 8 goroutines simulating shards, then feed it a Zipf-distributed key set. Watch one partition get most of the data. Now fix it: better sampling, salted hot keys, or dynamic repartitioning. Deliverable: a chart of partition sizes before and after, and a written argument for which mitigation you chose. This is the exact failure that makes real distributed sorts miss their SLA, and having seen it in miniature is worth more than reading about it.
