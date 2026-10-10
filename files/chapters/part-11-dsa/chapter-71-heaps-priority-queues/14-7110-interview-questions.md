## 71.12 Interview Questions

### Question 1: Find Median from Data Stream

Finding the median of a running data stream is non-trivial because the median changes with every insertion. The dual-heap approach maintains a max-heap of the lower half and a min-heap of the upper half, keeping them balanced so the median is always readable from the heap roots in O(1). The key invariant is that every element in the max-heap is ≤ every element in the min-heap, which is enforced by routing each new number through the max-heap first before possibly migrating the top to the min-heap.

```go
// MaxIntHeap and IntHeap are the slice-based heaps from Section 71.2.
type MedianFinder struct {
    maxHeap *MaxIntHeap // lower half
    minHeap *IntHeap    // upper half
}

func Constructor() MedianFinder {
    return MedianFinder{
        maxHeap: &MaxIntHeap{},
        minHeap: &IntHeap{},
    }
}

func (mf *MedianFinder) AddNum(num int) {
    // Route through the lower half first, then hand its max to the
    // upper half. This enforces maxHeap.max <= minHeap.min without
    // ever comparing num against anything explicitly.
    heap.Push(mf.maxHeap, num)
    heap.Push(mf.minHeap, heap.Pop(mf.maxHeap))

    // Rebalance so maxHeap is equal in size or exactly one larger.
    if mf.minHeap.Len() > mf.maxHeap.Len() {
        heap.Push(mf.maxHeap, heap.Pop(mf.minHeap))
    }
}

func (mf *MedianFinder) FindMedian() float64 {
    if mf.maxHeap.Len() > mf.minHeap.Len() {
        return float64((*mf.maxHeap)[0])
    }
    return float64((*mf.maxHeap)[0]+(*mf.minHeap)[0]) / 2.0
}
```

### Junior → FAANG: Structured Interview Answers for Heap Questions

When an interviewer asks you to solve Find Median from Data Stream, they are watching for several things beyond correctness: do you ask clarifying questions first? Do you identify the naive solution (sorting, O(n log n) per query) before proposing the optimized one? Do you state the invariant explicitly?

Model answer structure for this problem:
1. Clarify: "Is the stream finite or potentially unbounded? Do I need to support removing elements?" (Usually no to both, which simplifies the problem.)
2. Brute force: "I could insert each element into a sorted slice. Finding the median is O(1) but insertion is O(n)."
3. Insight: "I only need the boundary between the lower and upper halves, not full sorted order. Two heaps maintain this boundary."
4. State the invariant: "Every element in the max-heap is at most every element in the min-heap. The sizes differ by at most one."
5. Code the three-step insert sequence.
6. Verify out loud on a concrete input. For `[5, 3, 8]`:
   - Insert 5: push to small, move its max to large (small={}, large={5}), large is now bigger so move it back. small={5}, large={}. Median 5.
   - Insert 3: push to small={5,3}, move max 5 to large. small={3}, large={5}, sizes equal so no rebalance. Median (3+5)/2 = 4.0.
   - Insert 8: push to small={3,8}, move max 8 to large={5,8}. small={3}, large={5,8}, large is bigger so move its min 5 back. small={5,3}, large={8}. Median 5.

   Check it against the sorted stream: [3,5,8] has median 5. Matches.

For Merge K Sorted Lists: explain why the naive O(N*K) approach is slow (repeatedly finding the minimum by scanning all k heads) before showing how the heap reduces this to O(N log K).

### Senior @ FAANG: Interview Design and Question Calibration at L6

Staff engineers often participate in interview calibration sessions where they score recorded or written interview responses against a rubric. Understanding what distinguishes L4 from L5 from L6 responses to these two questions sharpens your ability to both interview and coach.

For Find Median from Data Stream, an L4 response implements the two-heap solution correctly. An L5 response adds: time and space complexity analysis, mentions the sliding window extension (LeetCode 480), and asks whether approximate quantiles (t-digest) are acceptable. An L6 response does all of this and then discusses the production observability implications: "If this stream represents request latency in our API, I would use HDRHistogram in the metrics layer rather than two heaps, because HDRHistogram supports merge across replicas and is reset-able per reporting interval."

For Merge K Sorted Lists, an L4 response implements the heap correctly. An L5 response mentions the external merge sort connection and the time complexity proof. An L6 response discusses the distributed merge scenario: "In a distributed system where the k sorted lists come from k database shards, the bottleneck shifts from CPU to network latency. I would add prefetch buffers on each shard cursor and use async I/O so the heap extraction is never blocked on a network call."

These distinctions are the bar-raiser's mental model when scoring interview packets. Understanding them allows you to calibrate your own answers and the answers of candidates you interview.

### Question 2: Merge K Sorted Lists

Naively merging K sorted lists by repeatedly scanning all list heads costs O(N·K) time. A min-heap reduces the per-element cost to O(log K) by always extracting the globally smallest node in O(log K) and immediately pushing that node's successor, keeping the heap size bounded at K at all times. This makes the overall complexity O(N log K), where N is the total number of nodes across all lists.

```go
func mergeKLists(lists []*ListNode) *ListNode {
    h := &ListNodeHeap{}
    heap.Init(h)

    for _, l := range lists {
        if l != nil {
            heap.Push(h, l)
        }
    }

    dummy := &ListNode{}
    curr := dummy

    for h.Len() > 0 {
        node := heap.Pop(h).(*ListNode)
        curr.Next = node
        curr = curr.Next

        if node.Next != nil {
            heap.Push(h, node.Next)
        }
    }

    return dummy.Next
}
```

---
