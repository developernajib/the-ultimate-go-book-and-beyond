## Overview

A heap is a specialized tree-based data structure that satisfies the heap property. In a max-heap, parent nodes are always greater than or equal to children. In a min-heap, parents are always less than or equal to children. Heaps are the underlying structure for priority queues, enabling efficient access to the highest (or lowest) priority element.

```
┌─────────────────────────────────────────────────────────────────┐
│                    HEAP STRUCTURE                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Max-Heap (parent >= children):                                 │
│                                                                 │
│                    ┌────┐                                       │
│                    │ 90 │ ← Maximum at root                     │
│                    └─┬──┘                                       │
│               ┌──────┴──────┐                                   │
│             ┌─┴─┐         ┌─┴─┐                                 │
│             │ 85│         │ 70│                                 │
│             └─┬─┘         └─┬─┘                                 │
│          ┌───┴───┐      ┌───┴───┐                               │
│        ┌─┴─┐   ┌─┴─┐  ┌─┴─┐   ┌─┴─┐                             │
│        │ 80│   │ 60│  │ 50│   │ 40│                             │
│        └───┘   └───┘  └───┘   └───┘                             │
│                                                                 │
│  Array representation:                                          │
│  Index:  0   1   2   3   4   5   6                              │
│  Value: [90, 85, 70, 80, 60, 50, 40]                            │
│                                                                 │
│  Parent of i: (i-1)/2                                           │
│  Left child of i: 2*i + 1                                       │
│  Right child of i: 2*i + 2                                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Reading the Heap Structure Diagram

The diagram above is the single most important thing to internalise before writing any heap code. Many candidates understand the concept verbally but freeze when asked to write siftDown because they never connected the visual tree to the array indices.

Work through the example with pencil: node at index 3 has value 80. Its parent is at index `(3-1)/2 = 1`, which is 85. Check: 85 >= 80, the max-heap property holds. Its left child is at index `2*3+1 = 7`, which does not exist in a seven-element heap, so node 3 is a leaf. This manual verification takes one minute but permanently ties the formulas to a concrete picture.

The "complete binary tree" constraint is what makes the array representation valid. Every level is filled left to right before a new level starts, which guarantees there are no gaps in the array. If the heap were not complete, the index formulas would produce incorrect results.

### Senior @ FAANG: Heap Invariant as a Contract

The heap property is a weaker invariant than full sorted order, and that weakness is its strength. Maintaining full sorted order on insert costs O(n). Maintaining only the heap invariant costs O(log n), because the invariant only constrains the parent-child relationship, not sibling order. At the staff level, you should be able to articulate this trade-off precisely: "I chose a heap over a sorted slice because the downstream consumer only needs repeated minimum extraction, not sorted iteration, and the O(log n) vs O(n) difference in insertion cost compounds across millions of events per second."

The heap-as-contract framing also matters for code review. When reviewing a pull request that introduces a heap, a senior engineer checks: is the `Less` function consistent with the problem's priority definition? Is `heap.Init` called before any operation on a pre-populated slice? Does `Swap` correctly maintain any secondary index (for indexed priority queues)? Violations of these contracts do not always produce immediate panics. They produce silent incorrect behavior that surfaces only under specific orderings of input, which makes them among the most expensive bugs to track down in production.
