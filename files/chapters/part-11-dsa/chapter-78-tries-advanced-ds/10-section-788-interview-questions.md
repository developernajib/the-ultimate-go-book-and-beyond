## 78.8 Interview Questions

### Question 1: Implement Trie with Wildcard Search

Extending a standard trie to support the `.` wildcard requires a recursive search helper that, upon encountering a dot, fans out to every child node and returns true if any branch eventually matches the remainder of the pattern. Regular characters still follow the deterministic single-child path, so the overhead of recursion is only incurred at wildcard positions.

```go
// Design a trie that supports '.' wildcard matching

type WordDictionary struct {
    children map[rune]*WordDictionary
    isEnd    bool
}

func Constructor() WordDictionary {
    return WordDictionary{children: make(map[rune]*WordDictionary)}
}

func (wd *WordDictionary) AddWord(word string) {
    node := wd
    for _, ch := range word {
        if node.children[ch] == nil {
            node.children[ch] = &WordDictionary{children: make(map[rune]*WordDictionary)}
        }
        node = node.children[ch]
    }
    node.isEnd = true
}

func (wd *WordDictionary) Search(word string) bool {
    return wd.searchHelper(word, 0)
}

func (wd *WordDictionary) searchHelper(word string, index int) bool {
    if index == len(word) {
        return wd.isEnd
    }

    ch := rune(word[index])

    if ch == '.' {
        // Wildcard: try all children
        for _, child := range wd.children {
            if child.searchHelper(word, index+1) {
                return true
            }
        }
        return false
    }

    if wd.children[ch] == nil {
        return false
    }
    return wd.children[ch].searchHelper(word, index+1)
}
```

### Question 2: Range Sum Query with Updates

A Fenwick tree stores partial sums indexed by the lowest set bit of each position, enabling both point updates and prefix sum queries in O(log n) time. To compute an arbitrary range sum `[left, right]`, the implementation subtracts the prefix sum up to `left-1` from the prefix sum up to `right`, making updates and range queries equally efficient without the overhead of a full segment tree.

```go
// Implement NumArray with O(log n) update and range sum

type NumArray struct {
    tree []int
    n    int
}

func ConstructorNumArray(nums []int) NumArray {
    n := len(nums)
    na := NumArray{
        tree: make([]int, n+1),
        n:    n,
    }
    // Build Fenwick tree
    for i, num := range nums {
        na.add(i+1, num)
    }
    return na
}

func (na *NumArray) add(i, delta int) {
    for i <= na.n {
        na.tree[i] += delta
        i += i & (-i)
    }
}

func (na *NumArray) prefixSum(i int) int {
    sum := 0
    for i > 0 {
        sum += na.tree[i]
        i -= i & (-i)
    }
    return sum
}

func (na *NumArray) Update(index int, val int) {
    // Get current value and compute delta
    current := na.SumRange(index, index)
    delta := val - current
    na.add(index+1, delta)
}

func (na *NumArray) SumRange(left int, right int) int {
    return na.prefixSum(right+1) - na.prefixSum(left)
}
```

### Question 3: Count of Smaller Numbers After Self

Processing the array from right to left turns this into a sequence of rank queries: for each element, query how many already-seen elements have a smaller rank, then insert the current element's rank. Coordinate compression maps the original values to a compact integer range first, which keeps the Fenwick tree size proportional to the number of distinct values rather than the value magnitudes.

```go
// For each element, count numbers to its right that are smaller

func countSmaller(nums []int) []int {
    n := len(nums)
    result := make([]int, n)

    // Coordinate compression
    sorted := make([]int, n)
    copy(sorted, nums)
    sortInts(sorted)
    rank := make(map[int]int)
    for _, num := range sorted {
        if _, ok := rank[num]; !ok {
            rank[num] = len(rank) + 1 // ranks are 1-based: a Fenwick index of 0 would hang
        }
    }

    // Fenwick tree for counting
    tree := make([]int, len(rank)+2)

    update := func(i int) {
        for i < len(tree) {
            tree[i]++
            i += i & (-i)
        }
    }

    query := func(i int) int {
        sum := 0
        for i > 0 {
            sum += tree[i]
            i -= i & (-i)
        }
        return sum
    }

    // Process from right to left
    for i := n - 1; i >= 0; i-- {
        r := rank[nums[i]]
        result[i] = query(r - 1) // Count elements smaller than current
        update(r)
    }

    return result
}

func sortInts(nums []int) {
    // Simple quicksort
    if len(nums) < 2 {
        return
    }
    pivot := nums[len(nums)/2]
    left, right := 0, len(nums)-1
    for left <= right {
        for nums[left] < pivot {
            left++
        }
        for nums[right] > pivot {
            right--
        }
        if left <= right {
            nums[left], nums[right] = nums[right], nums[left]
            left++
            right--
        }
    }
    sortInts(nums[:right+1])
    sortInts(nums[left:])
}
```

### Question 4: Maximum XOR Subarray (Trie-based)

The key observation is that `XOR(i, j) = prefix[j] XOR prefix[i-1]`, which reduces the problem to finding two prefix XOR values whose XOR is maximized, exactly the Maximum XOR of Two Numbers problem. Inserting each prefix XOR into a binary trie as it is computed, then greedily querying for the maximum XOR partner, solves it in a single pass costing O(32n), which is O(n) with a constant of 32.

That constant is a hard-coded assumption, and it is the thing to notice. The loop runs `i` from 31 down to 0, so it inspects the low 32 bits and nothing else, while Go's `int` is 64 bits wide. Every bit at position 32 or above is silently dropped. On `[]int{1 << 40, 3}` the function returns 3, when the true answer is 1099511627779. Nothing panics and nothing warns.

This is fine for LeetCode 421, whose constraints cap values at 2^31 - 1, and it is not fine as a general-purpose routine in a language whose `int` is not 32 bits. If the input domain really is 32-bit, say so in the signature by taking `[]int32` or `[]uint32`, so the type enforces what the loop assumes. If it is not, drive the loop from `bits.UintSize - 1` or a named constant instead of a literal 31. Note also that the greedy walk assumes non-negative inputs: a negative `int` has its sign bit set at position 63, which this loop never examines, so negatives are silently mis-ranked.

```go
// Find maximum XOR of any subarray.
// Precondition: 0 <= nums[i] < 2^31. The bit loop below covers only the
// low 32 bits, so larger or negative values are silently mishandled.

func maxXorSubarray(nums []int) int {
    // Key insight: XOR(i, j) = prefix[j] XOR prefix[i-1]
    // So we need max XOR of any two prefix XORs

    type TrieNode struct {
        children [2]*TrieNode
    }

    root := &TrieNode{}

    insert := func(num int) {
        node := root
        for i := 31; i >= 0; i-- {
            bit := (num >> i) & 1
            if node.children[bit] == nil {
                node.children[bit] = &TrieNode{}
            }
            node = node.children[bit]
        }
    }

    findMaxXor := func(num int) int {
        node := root
        maxXor := 0
        for i := 31; i >= 0; i-- {
            bit := (num >> i) & 1
            opposite := 1 - bit
            if node.children[opposite] != nil {
                maxXor |= (1 << i)
                node = node.children[opposite]
            } else if node.children[bit] != nil {
                node = node.children[bit]
            } else {
                break
            }
        }
        return maxXor
    }

    maxResult := 0
    prefix := 0
    insert(0) // Empty prefix

    for _, num := range nums {
        prefix ^= num
        xor := findMaxXor(prefix)
        if xor > maxResult {
            maxResult = xor
        }
        insert(prefix)
    }

    return maxResult
}
```

### Question 5: Stream of Characters (Suffix Trie)

Because queries ask whether any dictionary word is a suffix of the character stream seen so far, inserting words in reverse lets each incoming character be matched backward through the accumulated stream. On each `Query`, the code walks the stream in reverse while following trie edges, returning true the moment it reaches a node marked as a word end.

The backward walk is cheaper than it looks and the bookkeeping is more expensive than it looks, which is worth separating. The loop appears to scan the whole stream, but it exits as soon as no child matches, and the trie is only as deep as the longest dictionary word. So a query costs O(L) in the longest word, not O(n) in the stream length, no matter how long the stream grows.

The memory is the real problem. `sc.stream` appends forever and nothing ever truncates it, so a checker fed a million characters holds a million runes to answer questions that can only ever consult the last L of them. For a structure whose entire premise is an unbounded stream, that is the wrong shape. The fix is to keep only the last L characters in a ring buffer, which bounds memory at the longest word and changes nothing about the answers. Raise this before the interviewer does.

```go
// Check if stream ends with any word from dictionary

type StreamChecker struct {
    root   *TrieNode
    stream []rune
}

type TrieNode struct {
    children map[rune]*TrieNode
    isEnd    bool
}

func ConstructorStreamChecker(words []string) StreamChecker {
    sc := StreamChecker{
        root:   &TrieNode{children: make(map[rune]*TrieNode)},
        stream: make([]rune, 0),
    }

    // Insert words in reverse (for suffix matching)
    for _, word := range words {
        node := sc.root
        runes := []rune(word)
        for i := len(runes) - 1; i >= 0; i-- {
            ch := runes[i]
            if node.children[ch] == nil {
                node.children[ch] = &TrieNode{children: make(map[rune]*TrieNode)}
            }
            node = node.children[ch]
        }
        node.isEnd = true
    }

    return sc
}

func (sc *StreamChecker) Query(letter byte) bool {
    sc.stream = append(sc.stream, rune(letter))

    // Check if stream suffix matches any word
    node := sc.root
    for i := len(sc.stream) - 1; i >= 0; i-- {
        ch := sc.stream[i]
        if node.children[ch] == nil {
            return false
        }
        node = node.children[ch]
        if node.isEnd {
            return true
        }
    }

    return false
}
```

### Junior → FAANG: Five Interview Questions as Difficulty Milestones

The five questions in this section form a difficulty progression: wildcard trie (medium), Fenwick range sum (medium), count of smaller with coordinate compression (hard), max XOR subarray with prefix XOR reduction (hard), stream suffix checker with reverse trie (hard). Work through them in order. When you can solve questions 1 and 2 without reference, you are ready for a standard FAANG onsite. When you can solve all five, you are ready for the hardest tier. For each problem, time yourself and target: Q1 in 15 minutes, Q2 in 15 minutes, Q3-Q5 in 30 minutes each. If a problem takes longer, study the solution and re-attempt in a week rather than spending more time on the first attempt.

### Senior @ FAANG: Advanced Interview Questions as System Design Seeds

Each of these five questions is the seed of a larger system design problem. The wildcard trie is the core of a "Magic Dictionary" or spell-checker service: extend the question by asking how to handle 10 million words, 100 thousand concurrent searches, and real-time word additions. The Fenwick range sum is the core of an audit log query service: extend it by asking how to handle out-of-order event ingestion, range queries by time window, and the requirement to replay queries as of a historical timestamp. The "count of smaller after self" is the core of a real-time inversion count service for ranking quality monitoring: extend it by asking how to handle a stream of new rankings and serve inversion count queries at any point in the stream. A bar-raiser interviewer will guide the conversation from the coding question to the system design question, and a staff-level candidate is expected to drive that extension without prompting. Practice explicitly asking yourself, after solving each question, "How would this change if the input were a stream? If it had to be distributed? If it had to support deletions?" and sketching an answer before moving on.
