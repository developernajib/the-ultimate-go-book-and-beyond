## Overview

Hash tables are one of the most important data structures in computer science, providing average O(1) time complexity for insertion, deletion, and lookup. Go's built-in `map` type is implemented as a hash table, but understanding the underlying mechanics helps you write more efficient code and solve interview problems effectively.

```
┌─────────────────────────────────────────────────────────────────┐
│                    HASH TABLE OVERVIEW                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Key: "apple"                                                   │
│    │                                                            │
│    ▼                                                            │
│  hash("apple") = 42                                             │
│    │                                                            │
│    ▼                                                            │
│  index = 42 % table_size = 2                                    │
│    │                                                            │
│    ▼                                                            │
│  ┌─────┬─────────────────────────────────────────────┐          │
│  │  0  │ → ["banana", 5]                             │          │
│  ├─────┼─────────────────────────────────────────────┤          │
│  │  1  │ → nil                                       │          │
│  ├─────┼─────────────────────────────────────────────┤          │
│  │  2  │ → ["apple", 3] → ["grape", 7]  (collision!) │          │
│  ├─────┼─────────────────────────────────────────────┤          │
│  │  3  │ → ["cherry", 2]                             │          │
│  ├─────┼─────────────────────────────────────────────┤          │
│  │  4  │ → nil                                       │          │
│  └─────┴─────────────────────────────────────────────┘          │
│                                                                 │
│  Separate Chaining: Collisions stored in linked lists           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Junior -> FAANG: Reading Diagrams and Building Mental Models

The diagram above encodes three facts that junior candidates often miss. First, a collision does not mean the structure is broken: collisions are expected and chaining handles them correctly at the cost of a slightly longer lookup for that bucket. Second, the hash function output is reduced modulo the table size (`42 % 5 = 2`), meaning the table size itself influences how evenly keys distribute. Third, the linked list in bucket 2 contains both "apple" and "grape," so lookup must scan the chain for the exact key rather than stopping at the first entry.

In interviews, drawing this diagram on the whiteboard (or explaining it verbally) before coding is a strong signal that you understand the data structure, not just the API. Interviewers look for candidates who narrate the lookup path: "I hash the key, reduce modulo capacity, then walk the chain comparing keys until I find a match or reach nil."

### Senior @ FAANG: Evaluating Chaining vs Open Addressing for Production Use

The choice between separate chaining and open addressing is not academic at scale. Chaining uses pointer-based linked lists, which are friendly to high load factors (above 0.75) but unfriendly to CPU cache: each node pointer dereference is a potential cache miss. Open addressing stores all data inline in a contiguous array, which is cache-friendly but requires a lower load factor (typically 0.5 to 0.7) to avoid clustering and must handle the tombstone problem for deletions.

Go's runtime map lands firmly on the open addressing side. Since Go 1.24 it is a Swiss Tables design: slots are stored inline in groups of 8, and probing walks a quadratic sequence of groups rather than following overflow pointers. The trick that makes this fast is the per-group 64-bit control word, which packs one 7-bit fingerprint per slot. A single SWAR comparison against that word yields a bitmask of candidate slots, so the common case touches one cache line and performs zero key comparisons for the 7 non-matching slots. Older descriptions of Go maps as "8-key buckets chained through overflow pointers" describe the pre-1.24 implementation and no longer hold. Understanding this design choice is directly relevant to production decisions: when you are evaluating an external concurrent hash map library (such as `github.com/puzpuzpuz/xsync`), the question is whether its bucket layout optimizes for your read-to-write ratio and key size distribution, not merely whether it is "concurrent-safe."
