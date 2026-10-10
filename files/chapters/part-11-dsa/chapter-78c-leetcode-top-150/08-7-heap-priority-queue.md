## 78C.7 Heap / Priority Queue

Heaps efficiently maintain the min or max element. Use Go's `container/heap` package.

---
### LC 703 - Kth Largest Element in a Stream 🟢

**Key Insight**: Maintain a min-heap of size k. The root is then always the k-th largest element.

```go
import "container/heap"

type KthLargest struct {
    k    int
    heap IntHeap
}

type IntHeap []int

func (h IntHeap) Len() int            { return len(h) }
func (h IntHeap) Less(i, j int) bool  { return h[i] < h[j] }
func (h IntHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *IntHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *IntHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

func Constructor(k int, nums []int) KthLargest {
    kl := KthLargest{k: k, heap: IntHeap{}}
    heap.Init(&kl.heap)
    for _, n := range nums {
        kl.Add(n)
    }
    return kl
}

func (kl *KthLargest) Add(val int) int {
    heap.Push(&kl.heap, val)
    for kl.heap.Len() > kl.k {
        heap.Pop(&kl.heap)
    }
    return kl.heap[0]
}
```
**Time**: Add O(log k).
**Space**: O(k).

---
### LC 215 - Kth Largest Element in an Array 🟡

**Key Insight**: Use a min-heap of size k, or use quickselect for average O(n).

```go
import "container/heap"

func findKthLargest(nums []int, k int) int {
    h := &IntHeap{}
    heap.Init(h)

    for _, n := range nums {
        heap.Push(h, n)
        if h.Len() > k {
            heap.Pop(h)
        }
    }
    return (*h)[0]
}

type IntHeap []int

func (h IntHeap) Len() int            { return len(h) }
func (h IntHeap) Less(i, j int) bool  { return h[i] < h[j] }
func (h IntHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *IntHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *IntHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```
**Time**: O(n log k).
**Space**: O(k).

---
### LC 347 - Top K Frequent Elements 🟡

**Key Insight**: Count frequencies, then use a min-heap of size k keyed by frequency.

```go
import "container/heap"

func topKFrequent(nums []int, k int) []int {
    freq := make(map[int]int)
    for _, n := range nums {
        freq[n]++
    }

    h := &FreqHeap{}
    heap.Init(h)
    for num, count := range freq {
        heap.Push(h, [2]int{num, count})
        if h.Len() > k {
            heap.Pop(h)
        }
    }

    result := make([]int, k)
    for i := k - 1; i >= 0; i-- {
        result[i] = heap.Pop(h).([2]int)[0]
    }
    return result
}

type FreqHeap [][2]int

func (h FreqHeap) Len() int            { return len(h) }
func (h FreqHeap) Less(i, j int) bool  { return h[i][1] < h[j][1] }
func (h FreqHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *FreqHeap) Push(x any) { *h = append(*h, x.([2]int)) }
func (h *FreqHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```
**Time**: O(n log k).
**Space**: O(n).

---
### LC 373 - Find K Pairs with Smallest Sums 🟡

**Key Insight**: Use a min-heap seeded with pairs (nums1[i], nums2[0]). For each popped pair, push the next pair from nums2.

```go
import "container/heap"

func kSmallestPairs(nums1 []int, nums2 []int, k int) [][]int {
    if len(nums1) == 0 || len(nums2) == 0 {
        return nil
    }

    h := &PairHeap{}
    heap.Init(h)
    for i := 0; i < len(nums1) && i < k; i++ {
        heap.Push(h, [3]int{nums1[i] + nums2[0], i, 0})
    }

    var result [][]int
    for h.Len() > 0 && len(result) < k {
        top := heap.Pop(h).([3]int)
        i, j := top[1], top[2]
        result = append(result, []int{nums1[i], nums2[j]})
        if j+1 < len(nums2) {
            heap.Push(h, [3]int{nums1[i] + nums2[j+1], i, j + 1})
        }
    }
    return result
}

type PairHeap [][3]int

func (h PairHeap) Len() int            { return len(h) }
func (h PairHeap) Less(i, j int) bool  { return h[i][0] < h[j][0] }
func (h PairHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *PairHeap) Push(x any) { *h = append(*h, x.([3]int)) }
func (h *PairHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```
**Time**: O(k log k).
**Space**: O(k).

---
### LC 621 - Task Scheduler 🟡

**Key Insight**: The most frequent task determines the frame. The answer is max(len(tasks), (maxFreq-1)×(n+1) + countOfMax).

```go
func leastInterval(tasks []byte, n int) int {
    var freq [26]int
    for _, t := range tasks {
        freq[t-'A']++
    }

    maxFreq := 0
    maxCount := 0
    for _, f := range freq {
        if f > maxFreq {
            maxFreq = f
            maxCount = 1
        } else if f == maxFreq {
            maxCount++
        }
    }

    slots := (maxFreq - 1) * (n + 1) + maxCount
    if len(tasks) > slots {
        return len(tasks)
    }
    return slots
}
```

No heap is needed: only the maximum frequency and how many tasks share it affect the answer.

**Time**: O(len(tasks)). Note that `n` here is the cooldown, not the input size.
**Space**: O(1), a fixed 26-element count.

---
### LC 295 - Find Median from Data Stream 🔴

**Key Insight**: Use two heaps, a max-heap for the lower half and a min-heap for the upper half, and keep their sizes balanced.

```go
import "container/heap"

type MedianFinder struct {
    lo MaxHeap // lower half
    hi MinHeap // upper half
}

func Constructor() MedianFinder {
    return MedianFinder{}
}

func (mf *MedianFinder) AddNum(num int) {
    heap.Push(&mf.lo, num)
    heap.Push(&mf.hi, heap.Pop(&mf.lo).(int))
    if mf.hi.Len() > mf.lo.Len() {
        heap.Push(&mf.lo, heap.Pop(&mf.hi).(int))
    }
}

func (mf *MedianFinder) FindMedian() float64 {
    if mf.lo.Len() > mf.hi.Len() {
        return float64(mf.lo[0])
    }
    return float64(mf.lo[0]+mf.hi[0]) / 2.0
}

type MaxHeap []int

func (h MaxHeap) Len() int            { return len(h) }
func (h MaxHeap) Less(i, j int) bool  { return h[i] > h[j] }
func (h MaxHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *MaxHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *MaxHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}

type MinHeap []int

func (h MinHeap) Len() int            { return len(h) }
func (h MinHeap) Less(i, j int) bool  { return h[i] < h[j] }
func (h MinHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *MinHeap) Push(x any) { *h = append(*h, x.(int)) }
func (h *MinHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```
**Time**: AddNum O(log n), FindMedian O(1).
**Space**: O(n).

---
### LC 355 - Design Twitter 🟡

**Key Insight**: Each user has a list of tweets with timestamps. Use a merge-k-sorted-lists approach (min-heap) to get the feed.

```go
import "container/heap"

type Twitter struct {
    time      int
    tweets    map[int][]tweet
    following map[int]map[int]bool
}

type tweet struct {
    time int
    id   int
}

func Constructor() Twitter {
    return Twitter{
        tweets:    make(map[int][]tweet),
        following: make(map[int]map[int]bool),
    }
}

func (t *Twitter) PostTweet(userId int, tweetId int) {
    t.time++
    t.tweets[userId] = append(t.tweets[userId], tweet{t.time, tweetId})
}

func (t *Twitter) GetNewsFeed(userId int) []int {
    h := &TweetHeap{}
    heap.Init(h)

    users := []int{userId}
    if follows, ok := t.following[userId]; ok {
        for u := range follows {
            users = append(users, u)
        }
    }

    for _, u := range users {
        tw := t.tweets[u]
        if len(tw) > 0 {
            idx := len(tw) - 1
            heap.Push(h, tweetEntry{tw[idx].time, tw[idx].id, u, idx})
        }
    }

    var result []int
    for h.Len() > 0 && len(result) < 10 {
        entry := heap.Pop(h).(tweetEntry)
        result = append(result, entry.tweetId)
        if entry.idx > 0 {
            tw := t.tweets[entry.userId]
            next := entry.idx - 1
            heap.Push(h, tweetEntry{tw[next].time, tw[next].id, entry.userId, next})
        }
    }
    return result
}

func (t *Twitter) Follow(followerId int, followeeId int) {
    if t.following[followerId] == nil {
        t.following[followerId] = make(map[int]bool)
    }
    t.following[followerId][followeeId] = true
}

func (t *Twitter) Unfollow(followerId int, followeeId int) {
    if t.following[followerId] != nil {
        delete(t.following[followerId], followeeId)
    }
}

type tweetEntry struct {
    time    int
    tweetId int
    userId  int
    idx     int
}

type TweetHeap []tweetEntry

func (h TweetHeap) Len() int            { return len(h) }
func (h TweetHeap) Less(i, j int) bool  { return h[i].time > h[j].time }
func (h TweetHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *TweetHeap) Push(x any) { *h = append(*h, x.(tweetEntry)) }
func (h *TweetHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```
**Time**: GetNewsFeed O(k log k) where k is followed users.
**Space**: O(n) total tweets and follows.

---
### LC 767 - Reorganize String 🟡

**Key Insight**: Greedily place the two most frequent characters each round, using a max-heap to pick the highest frequencies available.

```go
import "container/heap"

func reorganizeString(s string) string {
    var freq [26]int
    for _, c := range s {
        freq[c-'a']++
    }

    h := &CharHeap{}
    heap.Init(h)
    for i := 0; i < 26; i++ {
        if freq[i] > 0 {
            heap.Push(h, charFreq{byte('a' + i), freq[i]})
        }
    }

    var result []byte
    for h.Len() >= 2 {
        first := heap.Pop(h).(charFreq)
        second := heap.Pop(h).(charFreq)

        result = append(result, first.ch, second.ch)
        first.count--
        second.count--

        if first.count > 0 {
            heap.Push(h, first)
        }
        if second.count > 0 {
            heap.Push(h, second)
        }
    }

    if h.Len() == 1 {
        last := heap.Pop(h).(charFreq)
        if last.count > 1 {
            return ""
        }
        result = append(result, last.ch)
    }
    return string(result)
}

type charFreq struct {
    ch    byte
    count int
}

type CharHeap []charFreq

func (h CharHeap) Len() int            { return len(h) }
func (h CharHeap) Less(i, j int) bool  { return h[i].count > h[j].count }
func (h CharHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *CharHeap) Push(x any) { *h = append(*h, x.(charFreq)) }
func (h *CharHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```
**Time**: O(n log 26) = O(n).
**Space**: O(1).

---
### LC 502 - IPO 🔴

**Key Insight**: Two structures pulling in different directions. Sort projects by **capital ascending** so you can unlock them cheapest-first as your funds grow, and hold the unlocked ones in a **max-heap by profit** so each of the k picks takes the best currently affordable project. Capital only ever increases, so a project once unlocked stays unlocked.

```go
import (
    "container/heap"
    "sort"
)

func findMaximizedCapital(k int, w int, profits []int, capital []int) int {
    n := len(profits)
    idx := make([]int, n)
    for i := range idx {
        idx[i] = i
    }
    sort.Slice(idx, func(a, b int) bool { return capital[idx[a]] < capital[idx[b]] })

    avail := &MaxHeap{} // profits of every project we can currently afford
    heap.Init(avail)
    next := 0 // projects before this index are already unlocked

    for range k {
        for next < n && capital[idx[next]] <= w {
            heap.Push(avail, profits[idx[next]])
            next++
        }
        if avail.Len() == 0 {
            break // nothing affordable, more capital will never arrive
        }
        w += heap.Pop(avail).(int)
    }
    return w
}

type MaxHeap []int

func (h MaxHeap) Len() int           { return len(h) }
func (h MaxHeap) Less(i, j int) bool { return h[i] > h[j] } // > gives a max-heap
func (h MaxHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *MaxHeap) Push(x any)        { *h = append(*h, x.(int)) }
func (h *MaxHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[:n-1]
    return x
}
```

The `next` cursor never rewinds, which is what keeps this O(n log n) rather than O(k × n). Each project is pushed at most once across all k rounds, because `w` is monotonically non-decreasing and the capital order is fixed. The early `break` matters for correctness of the running time as well as the answer: without it, a `k` of 10⁵ against a handful of projects would spin uselessly.

The exchange argument for the greedy choice: since taking a project never reduces capital, the set of affordable projects at round t+1 is a superset of the set at round t. So taking the maximum profit now cannot close off any option later, which means no lookahead is needed.

**Time**: O(n log n) - the sort dominates, plus O(n + k) heap operations at O(log n) each.
**Space**: O(n) - index permutation and heap.

---

### Junior → FAANG: Heap Size Strategy for Top-K Problems

The counterintuitive rule: to find the K largest elements, maintain a min-heap of size K. To find the K smallest, maintain a max-heap of size K. The heap size is always K, not n. When you add an element that would exceed K, pop the top. What remains is the K extreme elements. If you use a max-heap to find the K largest, you must heap all n elements before extracting K times, which is O(n log n + k log n). The size-K min-heap approach is O(n log k), better when k is small.

Task Scheduler is the hardest problem in this section and requires recognizing that it is a simulation problem, not a pure heap problem. The optimal schedule maximizes CPU utilization by always scheduling the most frequent remaining task first, using idle slots only when no other tasks are available. The key insight: the number of idle slots is determined solely by the most frequent task's count, not by the task ordering.

Go's `container/heap` implementation detail: `heap.Init` builds the heap in O(n) time using bottom-up heapification, which is more efficient than inserting n elements one at a time (O(n log n)). Use `heap.Init` when you have all elements upfront. Use `heap.Push` when elements arrive one at a time.

### Senior @ FAANG: Priority Queues in Work Scheduling and Circuit Breaking

Priority queues underlie work schedulers in production Go services. A priority queue of pending requests, ordered by deadline or SLA tier, allows a server to process high-priority requests first when it is under load. The Kubernetes resource scheduler uses priority queues to order pending pod creation by PriorityClass. Understanding the O(log n) per-operation cost lets you calculate the maximum throughput of a priority-queue-based scheduler and identify when the queue operations become the bottleneck relative to the work being scheduled.

Circuit breaker implementations that use time-based priority queues (e.g., "retry this failed request after exponential backoff") require careful handling of concurrent push and pop operations. In Go, wrapping `container/heap` with a mutex is the standard approach, but for high-throughput schedulers, consider a lock-free priority queue implementation using atomic compare-and-swap or a channel-based design where a single goroutine owns the heap and receives push/pop requests through channels.
