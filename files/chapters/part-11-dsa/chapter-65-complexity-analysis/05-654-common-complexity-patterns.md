## 65.4 Common Complexity Patterns

### Recognizing Patterns

Identifying an algorithm's complexity class from its structure (rather than deriving it mathematically) is the practical skill interviewers test. Each pattern below maps a recognizable code shape to a guaranteed complexity: nested loops over the same range always produce O(n²), a loop index that doubles each iteration produces O(log n), and two pointers converging from opposite ends scan each element at most once for O(n). Recognizing these shapes lets you reason about complexity in seconds.

```go
// Pattern: Processing each pair → O(n²)
func allPairs(arr []int) {
    for i := 0; i < len(arr); i++ {
        for j := i + 1; j < len(arr); j++ {
            // Process pair (arr[i], arr[j])
        }
    }
}

// Pattern: Binary search variants → O(log n)
func binarySearchVariant(arr []int, target int) int {
    left, right := 0, len(arr)
    for left < right {
        mid := left + (right-left)/2
        if condition(arr[mid], target) {
            left = mid + 1
        } else {
            right = mid
        }
    }
    return left
}

// Pattern: Two pointers on sorted array → O(n)
func twoPointers(arr []int, target int) (int, int) {
    left, right := 0, len(arr)-1
    for left < right {
        sum := arr[left] + arr[right]
        if sum == target {
            return left, right
        }
        if sum < target {
            left++
        } else {
            right--
        }
    }
    return -1, -1
}

// Pattern: Sliding window → O(n)
func slidingWindow(arr []int, k int) int {
    windowSum := 0
    for i := 0; i < k; i++ {
        windowSum += arr[i]
    }

    maxSum := windowSum
    for i := k; i < len(arr); i++ {
        windowSum += arr[i] - arr[i-k]
        if windowSum > maxSum {
            maxSum = windowSum
        }
    }
    return maxSum
}

// Pattern: Divide and conquer → O(n log n) when combine is O(n), as in merge sort
// (with an O(1) combine like the one below, the recursion itself is O(n))
func divideAndConquer(arr []int, left, right int) int {
    if left == right {
        return arr[left]
    }

    mid := (left + right) / 2
    leftResult := divideAndConquer(arr, left, mid)
    rightResult := divideAndConquer(arr, mid+1, right)

    return combine(leftResult, rightResult)
}

// Pattern: BFS/DFS → O(V + E) for graphs
func bfs(graph map[int][]int, start int) []int {
    visited := make(map[int]bool)
    queue := []int{start}
    result := []int{}

    for len(queue) > 0 {
        node := queue[0]
        queue = queue[1:]

        if visited[node] {
            continue
        }
        visited[node] = true
        result = append(result, node)

        for _, neighbor := range graph[node] {
            if !visited[neighbor] {
                queue = append(queue, neighbor)
            }
        }
    }
    return result
}
```

### Junior → FAANG: Pattern Recognition as Interview Strategy

Recognizing these patterns transforms an interview from a puzzle-solving exercise into a pattern-matching exercise. When you see a problem that asks for "the maximum sum of any k consecutive elements," your pattern library immediately flags it as a sliding window. When you see "find a pair that sums to target in a sorted array," the two-pointer pattern fires. This recognition is what allows experienced candidates to reach an O(n) solution quickly while others are still exploring O(n²) approaches.

Practice labeling problems before solving them. Before writing any code, state: "This looks like a two-pointer problem because the array is sorted and we are looking for pairs." That framing commits you to a direction and gives the interviewer confidence that your approach is deliberate. If your initial pattern guess is wrong, saying so explicitly ("I thought two-pointer but the unsorted input rules that out, so I will try sliding window instead") still demonstrates systematic thinking.

For BFS and DFS, memorize the O(V + E) bound and understand why: each vertex is visited once, and each edge is examined once. The BFS queue and visited set are both O(V) space.

### Senior @ FAANG: Pattern Libraries as Team Assets

At senior level, individual pattern knowledge is expected. The higher-order question is how you transfer that knowledge to the team and make it a durable asset rather than knowledge locked in one person's head.

One mechanism is a pattern library: an internal document or wiki that maps problem shapes to algorithmic patterns with links to canonical implementations. When a new engineer joins the team, this library reduces ramp-up time. When a code reviewer spots a suboptimal approach, they can link to the pattern page rather than writing a lengthy explanation from scratch.

Another mechanism is calibrated code review. When you see an O(n²) solution that could be a sliding window, do not just suggest the fix. Ask the author to explain their reasoning. "Walk me through why you chose the nested loop approach." This surfaces whether the issue was a pattern-recognition gap (the author did not know the pattern exists) or an application gap (they knew the pattern but could not apply it to this specific problem). The intervention is different in each case, and a good senior engineer diagnoses before prescribing.

For BFS specifically, the choice between BFS and DFS in a production system is not just about correctness. BFS uses O(width) queue space, which for a highly connected social graph can be enormous. DFS uses O(depth) stack space, which for a deep call graph can blow the goroutine stack limit. The right choice depends on the graph's structural properties, and a senior engineer models both before committing to an implementation.

---
