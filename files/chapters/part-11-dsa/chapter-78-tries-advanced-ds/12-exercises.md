## Exercises

### Exercise 1: Design Add and Search Words
Design a data structure that supports adding words and searching with wildcards.

### Exercise 2: Range Module
Track ranges with add, query, and remove operations.

### Exercise 3: Count Range Sum
Count range sums within [lower, upper] using segment tree or Fenwick tree.

### Exercise 4: All O'one Data Structure
Design a structure with O(1) inc, dec, getMaxKey, getMinKey.

### Junior → FAANG: Approaching These Exercises Strategically

Each exercise here is a "design" problem that requires combining two or more data structures. The entry point for all of them is the same: write out the required operations and their complexity targets before touching code. For "Design Add and Search Words," the operations are AddWord (O(m)) and Search (O(m) with wildcard branching), which points to a trie with recursive search on wildcards. For "Range Module," the operations are add, remove, and query on intervals, which points to an interval tree or sorted list of non-overlapping intervals. For "Count Range Sum," build the prefix sums first, and state the reduction precisely, because a loose version of it will not survive contact with the implementation. You are counting pairs `i < j` with `prefix[j] - prefix[i]` inside `[lower, upper]`, which rearranges into: for each `j`, count the earlier `prefix[i]` lying in `[prefix[j]-upper, prefix[j]-lower]`. That is a range-count over previously seen values, which points to a merge sort, or to a Fenwick or segment tree over coordinate-compressed prefix sums. For "All O'one," O(1) for all four operations points to a doubly linked list of frequency buckets with a hash map for O(1) lookup. Identify the right structure before implementing.

### Senior @ FAANG: Production Systems That Embed These Exercise Patterns

At the senior level, each exercise corresponds to a class of production system. "Design Add and Search Words" is the core of a spell-checker or pattern matching engine in a text processing pipeline. "Range Module" is the core of a network access control list manager where IP ranges are added, removed, and queried. "Count Range Sum" is the core of a bounded anomaly detector that counts events in a value range over a time window. "All O'one" is the core of a real-time top-1 and bottom-1 leaderboard where scores change frequently. Each production system adds the concerns that exercises omit: concurrency (the Range Module must handle concurrent add/remove without corrupting the interval list), persistence (the All O'one structure must survive a restart), and observability (the Count Range Sum must expose its current state for debugging). The exercises are the algorithmic core. The production challenge is wrapping that core in the infrastructure that makes it reliable, maintainable, and operable.
