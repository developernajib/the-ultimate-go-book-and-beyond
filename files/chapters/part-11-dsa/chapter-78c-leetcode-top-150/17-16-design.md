## 78C.16 Design

Design problems test your ability to combine data structures for efficient operations.

---
### LC 146 - LRU Cache

*(Covered in Linked List section.)*

---
### LC 155 - Min Stack

*(Covered in Stack section.)*

---
### LC 208 - Implement Trie

*(Covered in Tries section.)*

---
### LC 295 - Find Median from Data Stream

*(Covered in Heap section.)*

---
### LC 380 - Insert Delete GetRandom O(1) 🟡

**Key Insight**: Use an array for O(1) random access and a hash map for O(1) lookup. Swap with the last element on removal.

```go
import "math/rand"

type RandomizedSet struct {
    nums    []int
    indices map[int]int
}

func Constructor() RandomizedSet {
    return RandomizedSet{indices: make(map[int]int)}
}

func (rs *RandomizedSet) Insert(val int) bool {
    if _, ok := rs.indices[val]; ok {
        return false
    }
    rs.indices[val] = len(rs.nums)
    rs.nums = append(rs.nums, val)
    return true
}

func (rs *RandomizedSet) Remove(val int) bool {
    idx, ok := rs.indices[val]
    if !ok {
        return false
    }
    last := rs.nums[len(rs.nums)-1]
    rs.nums[idx] = last
    rs.indices[last] = idx
    rs.nums = rs.nums[:len(rs.nums)-1]
    delete(rs.indices, val)
    return true
}

func (rs *RandomizedSet) GetRandom() int {
    return rs.nums[rand.Intn(len(rs.nums))]
}
```
**Time**: O(1) for all operations.
**Space**: O(n).

---
### LC 381 - Insert Delete GetRandom O(1) - Duplicates Allowed 🔴

**Key Insight**: Same approach but the map stores a set of indices for each value. Pick any index on removal.

```go
import "math/rand"

type RandomizedCollection struct {
    nums    []int
    indices map[int]map[int]bool
}

func Constructor() RandomizedCollection {
    return RandomizedCollection{indices: make(map[int]map[int]bool)}
}

func (rc *RandomizedCollection) Insert(val int) bool {
    _, exists := rc.indices[val]
    if !exists || len(rc.indices[val]) == 0 {
        rc.indices[val] = make(map[int]bool)
    }
    rc.indices[val][len(rc.nums)] = true
    rc.nums = append(rc.nums, val)
    return !exists || len(rc.indices[val]) == 1
}

func (rc *RandomizedCollection) Remove(val int) bool {
    idxSet, ok := rc.indices[val]
    if !ok || len(idxSet) == 0 {
        return false
    }

    // Get any index for val
    var removeIdx int
    for idx := range idxSet {
        removeIdx = idx
        break
    }

    lastIdx := len(rc.nums) - 1
    lastVal := rc.nums[lastIdx]

    // Swap with last
    rc.nums[removeIdx] = lastVal

    // Update indices
    delete(rc.indices[val], removeIdx)
    delete(rc.indices[lastVal], lastIdx)
    if removeIdx != lastIdx {
        rc.indices[lastVal][removeIdx] = true
    }

    rc.nums = rc.nums[:lastIdx]
    if len(rc.indices[val]) == 0 {
        delete(rc.indices, val)
    }
    return true
}

func (rc *RandomizedCollection) GetRandom() int {
    return rc.nums[rand.Intn(len(rc.nums))]
}
```
**Time**: O(1) average for all operations.
**Space**: O(n).

---
### LC 895 - Maximum Frequency Stack 🔴

**Key Insight**: Use a map of stacks keyed by frequency. Push to the current frequency's stack, pop from the max frequency's stack.

```go
type FreqStack struct {
    freq    map[int]int
    group   map[int][]int
    maxFreq int
}

func Constructor() FreqStack {
    return FreqStack{
        freq:  make(map[int]int),
        group: make(map[int][]int),
    }
}

func (fs *FreqStack) Push(val int) {
    fs.freq[val]++
    f := fs.freq[val]
    if f > fs.maxFreq {
        fs.maxFreq = f
    }
    fs.group[f] = append(fs.group[f], val)
}

func (fs *FreqStack) Pop() int {
    stack := fs.group[fs.maxFreq]
    val := stack[len(stack)-1]
    fs.group[fs.maxFreq] = stack[:len(stack)-1]
    if len(fs.group[fs.maxFreq]) == 0 {
        delete(fs.group, fs.maxFreq)
        fs.maxFreq--
    }
    fs.freq[val]--
    return val
}
```
**Time**: O(1) for Push and Pop.
**Space**: O(n).

---
### LC 1472 - Design Browser History 🟡

**Key Insight**: Use a slice as a stack with a cursor. Visit truncates the forward history, while Back and Forward just move the cursor.

```go
type BrowserHistory struct {
    history []string
    current int
}

func Constructor(homepage string) BrowserHistory {
    return BrowserHistory{
        history: []string{homepage},
        current: 0,
    }
}

func (bh *BrowserHistory) Visit(url string) {
    bh.history = bh.history[:bh.current+1]
    bh.history = append(bh.history, url)
    bh.current++
}

func (bh *BrowserHistory) Back(steps int) string {
    bh.current -= steps
    if bh.current < 0 {
        bh.current = 0
    }
    return bh.history[bh.current]
}

func (bh *BrowserHistory) Forward(steps int) string {
    bh.current += steps
    if bh.current >= len(bh.history) {
        bh.current = len(bh.history) - 1
    }
    return bh.history[bh.current]
}
```
**Time**: O(1) for all operations (Visit is amortized O(1)).
**Space**: O(n) total visits.

---

### Junior → FAANG: Design Problems as Data Structure Composition Exercises

Design problems test your ability to combine two or more standard data structures to achieve a complexity guarantee that neither alone can provide. LRU Cache requires a hash map for O(1) lookup and a doubly linked list for O(1) move-to-front. RandomizedSet requires a hash map for O(1) index lookup and a slice for O(1) random access and O(1) swap-and-pop removal. FreqStack requires a hash map of frequencies and a map of frequency-indexed stacks. In each case, the interview technique is the same: write out the operations and their required complexities first, then ask "which data structure gives me O(1) for each of these, and what am I missing?" The missing piece reveals the second structure needed.

### Senior @ FAANG: Production System Design Derived from Interview Design Problems

Each interview design problem is a simplified version of a production system. LRU Cache is the read-through cache in front of a database, and at FAANG scale it becomes a distributed LRU with sharding, replication, and TTL-based expiry (Redis, Memcached). RandomizedSet is the data structure underlying A/B test bucket assignment, reservoir sampling in streaming systems, and random-access in probabilistic data structures. FreqStack is a building block for top-k tracking, which powers trending topics on Twitter, popular products on Amazon, and hot content on YouTube. The staff-level interview question is: "Design a distributed top-k system that processes 1 million events per second and returns the top 100 keys at any moment with at most 1-second staleness." The answer involves count-min sketch for approximate frequency tracking, a local top-k heap updated per batch, and a gossip or MapReduce-style aggregation across nodes. The interview-level FreqStack is the single-node component. The production concern is making that component work in a distributed, fault-tolerant, and operationally maintainable way. When owning such a system, the ADR documents the error tolerance (count-min sketch false positive probability), the memory budget per node, the aggregation latency budget, and the degradation behavior under partition.
