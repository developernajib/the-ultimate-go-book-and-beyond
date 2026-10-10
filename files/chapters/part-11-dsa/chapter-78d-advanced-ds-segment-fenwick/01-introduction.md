## Overview

Some problems demand more than hash maps and binary search. When you need to answer **range queries** efficiently, whether sums over subarrays, minimums over intervals, or counts of elements in a range, you need specialized data structures. This chapter covers three:

1. **Segment Trees.** Arbitrary range queries and updates in O(log n).
2. **Fenwick Trees (Binary Indexed Trees).** Lightweight prefix-sum structures.
3. **Sweep Line Algorithms.** Process events in sorted order to solve geometric and interval problems.

We also tackle **interval problems** and **monotonic stack/deque** patterns, which appear constantly in FAANG interviews.

---

### Junior → FAANG: Mapping Problem Descriptions to the Right Tool

The three structures in this chapter each solve a distinct problem shape. If the problem asks for a sum, minimum, or maximum over a subarray with updates, think Fenwick or segment tree. If the problem involves intervals being added over time and asks for overlap counts or area unions, think sweep line. If the problem asks for the next larger element or a sliding window extremum, think monotonic stack or deque. The entry-level skill is learning these three mappings and applying them before resorting to O(n) brute force. Practice identifying the problem shape in the first 2 minutes of reading a problem statement, before thinking about code.

### Senior @ FAANG: Owning the Choice Between These Structures in a Production Context

At the senior level, the choice between Fenwick and segment tree is a tradeoff that belongs in a design document. Fenwick trees are dramatically less code and have smaller constants, both in time and in memory, since they need exactly n+1 array slots against a segment tree's 4n. Segment trees are far more general: any associative operation, lazy range updates, range min and max, and the ability to descend the tree to answer "find the first position where the prefix exceeds X."

Be honest about the cost of the Fenwick tree's brevity, because the conventional framing gets this backwards. Fenwick trees are *easier to misindex than segment trees*, not harder. They are mandatorily 1-indexed, the `i & -i` loops give no hint of what they mean, and every off-by-one failure is silent. A 0-indexed Fenwick tree loses element 0 completely and still returns confident, wrong sums. A segment tree's structure at least corresponds to something you can picture and print. The Fenwick tree's does not, which is exactly why it is short.

So the debuggability question, which is the one that matters at 3 AM, does not favor the shorter code. It favors the code whose intermediate state a tired engineer can inspect and recognize. That argues for encoding whichever convention you choose into a shared, thoroughly tested package precisely so that no one debugs it at 3 AM.

The sweep line's operational hazard is different and sharper: it is sensitive to event ordering at ties. A tie-break bug in the comparator produces wrong answers only on inputs where coordinates coincide, which random testing hits rarely and hand-written test cases usually omit. Test the comparator against adversarial inputs built specifically to collide.
