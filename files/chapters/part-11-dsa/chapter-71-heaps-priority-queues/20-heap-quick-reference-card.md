## Heap Quick Reference Card

This reference consolidates the complexity guarantees, array index arithmetic, Go `container/heap` interface requirements, canonical problem patterns, and a ready-to-copy implementation template.

Two points are worth stating precisely, because both are commonly repeated in a sloppier form. First, `container/heap` has no default polarity at all: it is not "a min-heap" that you invert. The package only ever asks your `Less` which of two elements comes first, so `Less` alone decides whether the root is the minimum or the maximum, and nothing else in the code changes. Second, `heap.Init` is required only when you hand the package a slice you populated yourself, and it establishes the invariant in O(n). A heap built entirely through `heap.Push` is already valid, and `Init` on it is a no-op.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    HEAP/PRIORITY QUEUE QUICK REFERENCE                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  OPERATIONS & COMPLEXITY                                                    │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Operation          Binary Heap      Fibonacci Heap*                        │
│  Find min/max       O(1)             O(1)                                   │
│  Insert             O(log n)         O(1) amortized                         │
│  Extract min/max    O(log n)         O(log n) amortized                     │
│  Decrease key       O(log n)         O(1) amortized                         │
│  Merge              O(n)             O(1)                                   │
│  Build from array   O(n)             O(n)                                   │
│                                                                             │
│  *Fibonacci heap is rarely used in practice due to high constants           │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ARRAY REPRESENTATION                                                       │
│  ─────────────────────────────────────────────────────────────────────────  │
│  For element at index i (0-indexed):                                        │
│    Parent:      (i - 1) / 2                                                 │
│    Left child:  2*i + 1                                                     │
│    Right child: 2*i + 2                                                     │
│                                                                             │
│  For element at index i (1-indexed):                                        │
│    Parent:      i / 2                                                       │
│    Left child:  2*i                                                         │
│    Right child: 2*i + 1                                                     │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  GO container/heap INTERFACE                                                │
│  ─────────────────────────────────────────────────────────────────────────  │
│  type Interface interface {                                                 │
│      sort.Interface              // Len, Less, Swap                         │
│      Push(x any)         // Add element                                     │
│      Pop() any           // Remove and return last element                  │
│  }                                                                          │
│                                                                             │
│  Functions:                                                                 │
│    heap.Init(h)           // Establish heap property - O(n)                 │
│    heap.Push(h, x)        // Add element - O(log n)                         │
│    heap.Pop(h)            // Remove min/max - O(log n)                      │
│    heap.Remove(h, i)      // Remove at index - O(log n)                     │
│    heap.Fix(h, i)         // Re-heapify after update - O(log n)             │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PROBLEM PATTERNS                                                           │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Top-K Elements:                                                            │
│    K largest  → min-heap of size K (reject if smaller than min)             │
│    K smallest → max-heap of size K (reject if larger than max)              │
│    Time: O(n log k)                                                         │
│                                                                             │
│  Running Median:                                                            │
│    maxHeap (left half) + minHeap (right half)                               │
│    Balance: |maxHeap| = |minHeap| or |minHeap|+1                            │
│                                                                             │
│  Merge K Sorted:                                                            │
│    min-heap of (value, source_index, element_index)                         │
│    Time: O(N log k) where N = total elements                                │
│                                                                             │
│  Graph Shortest Path:                                                       │
│    Dijkstra: min-heap of (distance, node)                                   │
│    Time: O((V+E) log V)                                                     │
│                                                                             │
│  Task Scheduling:                                                           │
│    Process by deadline or priority                                          │
│    Often combined with greedy approach                                      │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  COMMON MISTAKES TO AVOID                                                   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  1. Wrong heap type for top-K (use min for largest K)                       │
│  2. Forgetting heap.Init on a slice you populated yourself                  │
│     (unnecessary if the heap was built only via heap.Push)                  │
│  3. Pop() removes from end, not front (heap manages internally)             │
│  4. Swap must be bidirectional (h[i], h[j] = h[j], h[i])                    │
│  5. Building with N insertions O(N log N) vs heapify O(N)                   │
│  6. Not maintaining two-heap balance for median                             │
│  7. Mutating a live element's priority without heap.Fix                     │
│  8. Assuming the backing slice is sorted (only index 0 is defined)          │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  QUICK CODE TEMPLATE                                                        │
│  ─────────────────────────────────────────────────────────────────────────  │
│  type MinHeap []int                                                         │
│  func (h MinHeap) Len() int           { return len(h) }                     │
│  func (h MinHeap) Less(i,j int) bool  { return h[i] < h[j] } // min         │
│  func (h MinHeap) Swap(i,j int)       { h[i], h[j] = h[j], h[i] }           │
│  func (h *MinHeap) Push(x any)        { *h = append(*h, x.(int)) }          │
│  func (h *MinHeap) Pop() any {                                              │
│      old := *h; n := len(old); x := old[n-1]; *h = old[:n-1]; return x      │
│  }                                                                          │
│                                                                             │
│  // For max-heap, change Less to: return h[i] > h[j]                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Using the Quick Reference Card Effectively

This reference card is a tool for active recall practice, not passive reading. Cover each section and try to reconstruct it from memory: write the index arithmetic without looking, write the `heap.Interface` method signatures without looking, and state the three problem patterns (top-K, running median, merge-k) with their time complexity without looking.

The most-tested facts from this card in FAANG interviews: O(n) heapify vs O(n log n) repeated insertion, O(log n) insert and extract, and the min-heap-for-K-largest rule. If you can state all three with correct complexity bounds in the first 60 seconds of a heap problem, you immediately signal algorithmic competency.

The "Common Mistakes to Avoid" section is worth converting to a verbal checklist you say out loud before writing heap code in an interview. This takes ten seconds and prevents the most common bugs.

### Senior @ FAANG: Reference Card as Team Onboarding Artefact

At staff level, a quick reference card like this one serves a second purpose: it is a concise onboarding document for engineers joining a team that uses heaps extensively. A well-maintained reference card reduces the time for a new engineer to produce correct heap code from days (reading documentation and debugging) to hours (reading the card and reviewing existing tests).

The card above covers the algorithmic layer. A production-grade version for a specific team would add: the specific heap type(s) used in the codebase, the naming convention for `Less` functions (e.g., "always name it `lessBy<Field>`"), the testing standard (property-based tests required for all heap implementations), and links to ADRs that document algorithm choices in key services.

Maintaining this artifact is a staff-level responsibility because it requires architectural awareness (which trade-offs matter for this team), writing clarity (the card must be scannable in under two minutes), and ongoing discipline to keep it synchronized with code changes. Treating it as a living document, reviewed as part of every PR that introduces a new heap implementation, is the operational practice that makes it valuable rather than stale.

---
