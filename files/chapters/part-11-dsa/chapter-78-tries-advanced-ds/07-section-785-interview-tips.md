## 78.5 Interview Tips

Picking the right advanced data structure is often the entire challenge in a hard interview problem. Each structure here solves a specific access pattern: a Trie gives O(m) prefix operations regardless of the dictionary size, a Segment Tree enables O(log n) arbitrary range queries with point or range updates, a Fenwick Tree offers the same asymptotic cost as a Segment Tree for prefix sums but with a smaller constant and simpler implementation, and an LRU/LFU Cache achieves O(1) eviction by pairing a hash map with a doubly-linked list.

### Data Structure Selection Guide

```
┌─────────────────────────────────────────────────────────────────┐
│              ADVANCED DATA STRUCTURE SELECTION                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  TRIE (Prefix Tree)                                             │
│  Use when: String prefix operations, autocomplete, spell check  │
│  Time: O(m) for operations where m = string length              │
│  Space: O(ALPHABET * N * M) worst case                          │
│                                                                 │
│  SEGMENT TREE                                                   │
│  Use when: Range queries with updates                           │
│  Operations: Sum, min, max, GCD over range                      │
│  Time: O(log n) query and update                                │
│  Space: O(n), allocated as 4n ints                              │
│                                                                 │
│  FENWICK TREE (BIT)                                             │
│  Use when: Prefix sum queries with point updates                │
│  Simpler than segment tree, but less flexible                   │
│  Time: O(log n) query and update                                │
│  Space: O(n)                                                    │
│                                                                 │
│  LRU/LFU CACHE                                                  │
│  Use when: Fixed-size cache with eviction policy                │
│  LRU: Evict least recently used                                 │
│  LFU: Evict least frequently used                               │
│  Time: O(1) get and put                                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Complexity Summary

| Data Structure | Build | Query | Update | Space |
|---------------|-------|-------|--------|-------|
| Trie | O(n*m) | O(m) | O(m) | O(α*n*m) |
| Segment Tree | O(n) | O(log n) | O(log n) | O(n), 4n ints in practice |
| Fenwick Tree | O(n log n) | O(log n) | O(log n) | O(n), n+1 ints |
| LRU Cache | O(1) | O(1) | O(1) | O(n) |

Two notes on reading this table honestly, both of which are the kind of thing an interviewer probes.

The segment tree and the Fenwick tree are both O(n) space. Writing the segment tree as "O(4n)" would be a category error, since big-O absorbs constant factors and O(4n) is O(n). The 4x is nonetheless real and worth stating separately: the segment tree allocates `4*n` ints against the Fenwick tree's `n+1`, so at scale it costs roughly four times the memory for the same element count. Complexity class and constant factor are different questions, and the answer to "which is cheaper" here comes entirely from the constant.

The Fenwick build is listed as O(n log n) because the implementation in Section 78.3 calls `Update` n times, and each is O(log n). This is a property of that code, not of the structure. An in-place build that adds each slot's value into its parent runs in O(n). If you quote O(n log n) in an interview, be ready to say which build you mean.

### Junior → FAANG: Using the Selection Guide as an Interview Decision Tool

The selection guide in this section answers the most important question in a hard-tier interview: "Which structure do I reach for?" Practice reciting the four conditions from memory: prefix operations on strings, range queries with updates, prefix sums only, or fixed-size cache with eviction. For each interview problem, state which condition the problem satisfies before writing any code. Interviewers score candidates on communication, and announcing your structure selection with a one-sentence justification is worth as much as the subsequent implementation.

### Senior @ FAANG: Complexity Tables as Governance Artifacts

At the senior level, the complexity summary table is an input to platform capacity planning. A Fenwick tree with O(log n) query and O(log n) update at n = 10^8 elements and 10^6 queries per second requires careful benchmarking to verify that the constant hidden by the O(log n) fits within the latency SLO. The segment tree's 4n ints against the Fenwick tree's n+1 is a 4x memory difference at identical complexity, and it translates directly into cost at scale. Staff engineers use complexity tables like this to estimate whether a proposed data structure fits within a system's operational budget before a single line of production code is written. The ADR template for any new data structure adoption should include a "complexity analysis" section referencing this table and annotating the expected n, query rate, update rate, and resulting memory and CPU estimates at projected scale.
