## 71.4 Merge K Sorted Lists/Arrays

Merging k sorted lists efficiently requires always selecting the globally smallest current head across all lists. A min-heap seeded with the head of each list enables this: each extraction pops the current minimum in O(log k) and enqueues the next node from the same list, processing all N total elements in O(N log k) time.

```go
import "container/heap"

// MergeKLists merges k sorted linked lists
// LeetCode 23: Merge k Sorted Lists
// Time: O(N log k), Space: O(k)
func MergeKLists(lists []*ListNode) *ListNode {
    h := &ListNodeHeap{}
    heap.Init(h)

    // Add head of each list
    for _, list := range lists {
        if list != nil {
            heap.Push(h, list)
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

type ListNode struct {
    Val  int
    Next *ListNode
}

type ListNodeHeap []*ListNode

func (h ListNodeHeap) Len() int           { return len(h) }
func (h ListNodeHeap) Less(i, j int) bool { return h[i].Val < h[j].Val }
func (h ListNodeHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *ListNodeHeap) Push(x any) { *h = append(*h, x.(*ListNode)) }
func (h *ListNodeHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

// MergeKSortedArrays merges k sorted arrays
func MergeKSortedArrays(arrays [][]int) []int {
    type Item struct {
        val      int
        arrayIdx int
        elemIdx  int
    }

    h := make([]Item, 0)

    // Initialize with first element of each array
    for i, arr := range arrays {
        if len(arr) > 0 {
            h = append(h, Item{val: arr[0], arrayIdx: i, elemIdx: 0})
        }
    }

    // Manual heapify since we need custom comparison.
    // siftDown must be declared before buildHeap refers to it: a variable's
    // scope starts at its declaration, so a closure defined earlier in the
    // function body cannot see it.
    siftDown := func(items []Item, idx int) {
        n := len(items)
        for {
            smallest := idx
            left, right := 2*idx+1, 2*idx+2
            if left < n && items[left].val < items[smallest].val {
                smallest = left
            }
            if right < n && items[right].val < items[smallest].val {
                smallest = right
            }
            if smallest == idx {
                break
            }
            items[idx], items[smallest] = items[smallest], items[idx]
            idx = smallest
        }
    }

    // Bottom-up heapify: O(k), cheaper than k individual insertions.
    for i := len(h)/2 - 1; i >= 0; i-- {
        siftDown(h, i)
    }

    result := make([]int, 0)
    for len(h) > 0 {
        // Pop min
        min := h[0]
        result = append(result, min.val)

        // Get next element from same array
        nextIdx := min.elemIdx + 1
        if nextIdx < len(arrays[min.arrayIdx]) {
            h[0] = Item{
                val:      arrays[min.arrayIdx][nextIdx],
                arrayIdx: min.arrayIdx,
                elemIdx:  nextIdx,
            }
            siftDown(h, 0)
        } else {
            // Remove this array from heap
            h[0] = h[len(h)-1]
            h = h[:len(h)-1]
            if len(h) > 0 {
                siftDown(h, 0)
            }
        }
    }

    return result
}
```

### Junior → FAANG: The K-Way Merge Pattern

The k-way merge is a canonical Hard problem and one of the highest-signal patterns in FAANG interviews. The core idea is simple once you see it: you cannot compare all k list heads globally without a data structure, so you put all the current heads into a min-heap. The minimum across all k heads is always at the heap root, and you can extract it in O(log k) and push its successor in O(log k). The total cost is O(N log k) for N total elements across k lists.

The most common mistake is trying to implement this without a heap, using nested loops instead. That costs O(N * k), which is acceptable for k=3 but terrible for k=1000 (a realistic scenario when merging k shards in a distributed sort).

When implementing `MergeKSortedArrays`, the three-field struct `{val, arrayIdx, elemIdx}` is the key: it lets you look up the next element in the same source array after extracting the minimum. Practice writing this struct and the siftDown that operates on it from scratch.

For interview preparation: `MergeKLists` (LeetCode 23) is rated Hard and is a recurring favorite in senior coding rounds. Time yourself implementing it cleanly in under 20 minutes.

### Senior @ FAANG: External Sort and Distributed Merge

The k-way merge is the algorithmic core of external merge sort, which is how databases and data warehouses sort datasets that exceed memory. The standard approach generates k sorted runs (each fitting in memory), then merges them using a min-heap. A production Go implementation of external sort adds: memory budget tracking to prevent OOM, disk spill with configurable paths, and checkpointing so that a failed merge can resume from the last committed output position.

At the distributed level, merging k sorted streams from k Kafka partitions, k database replicas, or k time-series shards uses the same O(N log k) algorithm over a network. The heap lives on the coordinator node. Each "shard" is a cursor that fetches the next element via RPC. The latency profile is what changes, and it changes the analysis completely: instead of an O(1) array access, each heap extraction can trigger a network round trip. Comparisons are now free relative to fetches, so counting comparisons tells you nothing about runtime. The correct engineering response is to add prefetch buffers: each cursor keeps a local buffer of already-fetched elements, so extraction hits memory in the common case and fetches happen asynchronously ahead of demand. The algorithm is unchanged, the cost model is not, and noticing that is the point.

A staff-level design review for a distributed merge service asks: what is the memory overhead of k buffers at buffer size B? What happens when one shard is slow or unavailable? How do you detect and handle a shard that produces out-of-order data? These questions distinguish engineers who implement the textbook algorithm from engineers who ship reliable production systems.
