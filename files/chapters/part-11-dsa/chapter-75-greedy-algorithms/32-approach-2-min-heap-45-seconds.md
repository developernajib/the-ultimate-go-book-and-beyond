## Approach 2: Min-Heap (45 seconds)
"Sort by start time. Use min-heap to track earliest ending
meeting. For each meeting, if it starts after heap-top ends,
pop (reuse room). Always push new end time."

```go
func minMeetingRoomsHeap(intervals [][]int) int {
    slices.SortFunc(intervals, func(a, b []int) int {
        return cmp.Compare(a[0], b[0])
    })

    h := &IntHeap{}
    heap.Init(h)

    for _, interval := range intervals {
        if h.Len() > 0 && (*h)[0] <= interval[0] {
            heap.Pop(h)
        }
        heap.Push(h, interval[1])
    }

    return h.Len()
}
```

### Junior → FAANG: When to Choose the Heap Approach

The heap approach and the two-array approach both run in O(n log n) time and O(n) space, so they are equivalent in complexity. The heap approach has higher constant-factor overhead (each heap operation is more expensive than an array index), so the two-array approach is faster in practice. Choose the heap approach in an interview when the interviewer explicitly asks for it, or when the problem has additional constraints (such as knowing which specific room is being freed, not just that a room is freed).

The heap approach is more natural if the problem asks you to assign meetings to specific rooms (not just count them). The heap stores the end time of the meeting currently in each room, and popping the minimum tells you which room to reuse. If the problem does not require tracking specific room assignments, the two-array approach is simpler and should be preferred.

In Go, implementing `heap.Interface` from scratch is a common source of interview bugs. Practice the Push/Pop implementation until it is automatic: `Push` appends to the slice, `Pop` removes and returns the last element (not the root). The heap package handles heapify.

### Senior @ FAANG: Heap-Based Approaches in Resource Management Systems

The min-heap approach directly models resource pool management. In a database connection pool, the heap contains active connections sorted by their lease expiration time. When a new request arrives, if the earliest-expiring connection has already expired, it is reclaimed (heap pop) and a new connection is issued. Otherwise, a new connection is created and added to the pool. The heap's Len() at any point is the pool size.

This analogy holds for thread pools, file descriptor pools, and any resource with a lease duration. The staff engineer designing a connection pool considers: should the pool be bounded (maximum heap size)? Should expired connections be reclaimed lazily (on next request) or eagerly (background goroutine)? The eager reclamation requires a separate goroutine with a timer, while lazy reclamation is simpler but wastes resources during quiet periods. Both are valid. The choice depends on the memory vs. latency tradeoff for the specific use case.

Connection pool design is a staple of staff-level system design interviews. The candidate is expected to recognize it as a resource scheduling problem, connect it to the heap-based meeting rooms approach, and extend it with production concerns (bounded pool size, health checking, connection warm-up, graceful shutdown). The ability to make this connection between an interview algorithm and a production system design is a strong L6 signal.
