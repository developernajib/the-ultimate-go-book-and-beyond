## Overview

Linked lists are fundamental data structures that form the basis for many advanced structures like stacks, queues, hash tables, and graphs. While Go's slice is often preferred for sequential data, understanding linked lists is crucial for interviews and for situations where constant-time insertions and deletions at arbitrary positions are required.

```
┌─────────────────────────────────────────────────────────────────┐
│                    LINKED LIST OVERVIEW                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Singly Linked:                                                 │
│  ┌───┬───┐   ┌───┬───┐   ┌───┬───┐   ┌───┬───┐                  │
│  │ 1 │ ●─┼──►│ 2 │ ●─┼──►│ 3 │ ●─┼──►│ 4 │nil│                  │
│  └───┴───┘   └───┴───┘   └───┴───┘   └───┴───┘                  │
│                                                                 │
│  Doubly Linked:                                                 │
│  ┌───┬───┬───┐   ┌───┬───┬───┐   ┌───┬───┬───┐                  │
│  │nil│ 1 │ ●─┼──►│ ●─│ 2 │ ●─┼──►│ ●─│ 3 │nil│                  │
│  └───┴───┴───┘◄──┼───┴───┴───┘◄──┼───┴───┴───┘                  │
│                                                                 │
│  Circular:                                                      │
│  ┌───┬───┐   ┌───┬───┐   ┌───┬───┐                              │
│  │ 1 │ ●─┼──►│ 2 │ ●─┼──►│ 3 │ ●─┼──┐                           │
│  └───┴───┘   └───┴───┘   └───┴───┘  │                           │
│      ▲                               │                          │
│      └───────────────────────────────┘                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Junior -> FAANG: Reading the Diagram Before Writing Code

The ASCII diagram above is the first tool to use in any linked list interview, not a decoration. Before touching a keyboard, draw the exact structure the problem gives you, label the pointers your algorithm will use, and trace three or four steps on paper.

The most important concept to lock in at this stage is that a linked list is not an object you manipulate, it is a graph of nodes connected by pointers. "The list" is just a convention that you are keeping track of the head node. Losing the head pointer is losing the list. This is why the dummy-head pattern exists: it gives you a stable root that is never the target of deletion, so `dummy.Next` is always your safe return value.

**Practical interview habit:** When an interviewer presents a list problem, restate it with a concrete example. "So if the input is [1, 2, 3, 4, 5] and k equals 2, the expected output is [1, 2, 4, 5]?" This narrows ambiguity and forces the interviewer to confirm your understanding before you write a single line.

**Common confusion to clear up:** Circular linked lists are rarely asked about directly. When they appear, it is almost always in the context of cycle detection (Floyd's algorithm) or the Josephus problem variant. Recognize the keyword "circular" as a signal to think about Floyd's or modular rotation, not as a separate data structure requiring a different mental model.

### Senior @ FAANG: Structural Variants and Operational Trade-offs

The three variants shown in the diagram carry distinct operational trade-offs that matter in production system design.

**Singly linked vs. doubly linked as an ADR decision.** Singly linked lists use one pointer per node and support only forward traversal. Doubly linked lists use two pointers per node and support O(1) deletion when you hold a direct reference, forward and backward traversal, and sentinel-based implementations that eliminate all nil-pointer edge cases. The ADR question is: does the application need O(1) deletion by reference? LRU cache eviction requires it. A simple FIFO job queue does not. Paying for the backward pointer without needing the capability costs you memory and cache locality at large scale and buys nothing.

**Circular lists in production.** The standard library ships `container/ring`, a circular doubly linked list, and circular structures show up in timer wheels and ring-buffer designs. The key operational property is that a single pointer (the tail) gives constant-time access to both the head (via `tail.Next`) and the tail itself, which supports O(1) rotation. Timer wheels use circular lists because expiry buckets form a natural ring, though Go's own runtime timers are not a wheel: each P keeps its timers in a min-heap ordered by deadline. When you see a "round-robin" or "rotating cursor" access pattern in a design document, the underlying structure is often circular.

**Platform implication of pointer density.** Each pointer in a doubly linked list is an 8-byte word on 64-bit systems and one more edge the garbage collector must trace during marking. (These are not GC roots. Roots are goroutine stacks and globals. These are heap-to-heap edges discovered from a root, and the mark phase has to walk every one of them.) At 100 million entries, the difference between singly and doubly linked storage is 800 MB of additional heap and proportional scan work. For platforms operating at this scale, the structure choice becomes a platform engineering decision reviewed at the staff level, not an implementation detail left to individual contributors.
