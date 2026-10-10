## 80.12 Coding Meta-Skills and Interview Speed

Knowing algorithms isn't enough. FAANG interviewers evaluate *how* you solve problems, your speed, your communication, your decision-making under pressure. Two candidates with identical algorithmic knowledge can get wildly different results based on their meta-skills.

This section covers the skills that sit above the algorithms: time management, pattern recognition, coding speed, and handling problems you've never seen before.

### Time Management: The 45-Minute Breakdown

Most coding interviews are 45 minutes. Subtract 5 minutes for introductions and 5 for your questions at the end. You have **35 minutes** to solve 1-2 problems. Here's how top candidates allocate that time:

**Single Problem (35 minutes):**

| Phase | Time | What You Do |
|-------|------|-------------|
| **Clarify** | 2-3 min | Restate the problem. Ask about edge cases, constraints, input size. "Can the array be empty? Can values be negative? What's the expected input size?" |
| **Plan** | 5-7 min | Think out loud. Identify the pattern. Discuss 1-2 approaches with trade-offs. State time/space complexity before coding. |
| **Code** | 15-18 min | Write clean, working code. Use meaningful variable names. No pseudocode, write real Go. |
| **Test** | 5-7 min | Walk through your code with a concrete example. Check edge cases (empty input, single element, duplicates). |
| **Optimize** | 3-5 min | If your solution isn't optimal, discuss what you'd improve. If it is, mention the trade-offs you considered. |

**Two Problems (35 minutes):**

Meta's coding rounds often require two problems. Budget 15-17 minutes each with no buffer. This means:
- Clarify in 1 minute (not 3)
- Plan in 2 minutes (not 7)
- Code in 10 minutes (not 18)
- Test in 2 minutes (not 7)

The difference between passing and failing Meta's coding round is often pure speed.

**The clock trick:** At the 15-minute mark, you should be coding. If you're still planning, you're behind. At the 25-minute mark, you should be testing. If you're still coding, simplify, get a working brute force solution rather than an incomplete optimal one.

### The Pattern Decision Tree

When you see a new problem, don't stare at it hoping for insight. Run through this decision tree:

```
Is the input SORTED or can it be sorted cheaply?
├── Yes → Binary Search, Two Pointers, or Merge-based approach
└── No ↓

Does the problem ask for SUBARRAY/SUBSTRING results?
├── Yes → Sliding Window or Prefix Sum
└── No ↓

Does the problem involve PAIRS or COMPLEMENTS?
├── Yes → Hash Map (two-sum pattern)
└── No ↓

Does the problem involve a TREE or GRAPH structure?
├── Tree → DFS (recursive) or BFS (level-order)
└── Graph → BFS (shortest path) or DFS (all paths/cycles)
          → If weighted: Dijkstra. If negative weights: Bellman-Ford.

Does the problem ask for ALL COMBINATIONS or PERMUTATIONS?
├── Yes → Backtracking
└── No ↓

Does the problem have OVERLAPPING SUBPROBLEMS?
├── Yes → Dynamic Programming
│         (Can you define state? What's the recurrence relation?)
└── No ↓

Does the problem involve INTERVALS?
├── Yes → Sort by start time, then sweep/merge
└── No ↓

Does the problem need the TOP K or KTH element?
├── Yes → Heap (min-heap for top K largest, max-heap for top K smallest)
└── No ↓

Does the problem involve CONNECTED COMPONENTS or UNION operations?
├── Yes → Union-Find
└── No ↓

Can you solve it GREEDILY? (local optimal = global optimal?)
├── Yes → Greedy (prove correctness before coding)
└── No → Re-read the problem. You missed a constraint.
```

**How to use this in an interview:** Don't run through it silently. Say it out loud. "The input is unsorted, and we're looking for subarrays... that suggests a sliding window approach. Let me verify, the window condition is..."

Interviewers reward this structured thinking even when you pick the wrong pattern initially.

### Coding Speed: Writing Correct Code Faster

Speed comes from eliminating hesitation, not from typing faster. Here's what actually makes you faster:

**1. Know your language's standard library cold.**

Don't waste 3 minutes wondering "how do I sort a slice of structs in Go?" Know it:

```go
// Sort by age
sort.Slice(people, func(i, j int) bool {
    return people[i].Age < people[j].Age
})

// Binary search
idx := sort.Search(len(arr), func(i int) bool {
    return arr[i] >= target
})

// String → int
n, _ := strconv.Atoi(s)

// Min/max (Go 1.21+)
m := min(a, b)
```

**2. Use Go's strengths, not its weaknesses.**

Go doesn't have a built-in set type. Don't fumble, use a map:

```go
seen := map[int]bool{}    // set of ints
seen[5] = true
if seen[5] { /* exists */ }
```

Go doesn't have a built-in stack or queue. Use slices:

```go
// Stack
stack = append(stack, val)           // push
val, stack = stack[len(stack)-1], stack[:len(stack)-1]  // pop

// Queue
queue = append(queue, val)           // enqueue
val, queue = queue[0], queue[1:]     // dequeue (O(n), fine for interviews)
```

**3. Write skeleton first, fill in details.**

```go
func solve(nums []int, target int) int {
    // 1. Edge cases
    if len(nums) == 0 {
        return -1
    }
    
    // 2. Initialize data structures
    // TODO
    
    // 3. Main loop
    for i := 0; i < len(nums); i++ {
        // TODO: core logic
    }
    
    // 4. Return result
    return -1
}
```

Lay down the structure, then fill each TODO. This prevents getting lost in details and forgetting the big picture.

**4. Don't optimize while writing.**

Write the brute force first. Get it working. Then optimize. A working O(n^2) solution is infinitely better than an incomplete O(n) solution. Many candidates fail because they try to write the optimal solution from the start and never finish.

**5. Avoid common Go interview traps.**

```go
// TRAP: Loop variable capture in goroutines (fixed in Go 1.22+, but interviewers still ask)
for _, v := range items {
    go func() {
        fmt.Println(v) // Before 1.22: prints last value for all goroutines
    }()
}

// TRAP: Nil map write
var m map[string]int
m["key"] = 1 // panic: assignment to entry in nil map

// TRAP: Slice append gotcha
a := []int{1, 2, 3}
b := a[:2]
b = append(b, 4) // This modifies a[2] because b shares a's underlying array
```

### Approaching Unknown Problems

Sometimes no pattern fits. The problem looks unfamiliar. Here's a framework for reasoning from first principles:

**Step 1: Work through small examples by hand.**

Don't think abstractly. Pick a tiny input (3-5 elements) and solve it manually on paper. Watch what your brain does, that's usually the algorithm.

**Step 2: Think about what information you need at each step.**

"At position `i`, what do I need to know to make a decision?" This often reveals the data structure:
- "I need the minimum so far" → running minimum variable
- "I need to look up values I've seen" → hash map
- "I need the next greater element" → monotonic stack
- "I need the shortest path" → BFS + queue

**Step 3: Simplify the problem.**

If the 2D version is hard, solve the 1D version first. If the general case is hard, solve it for sorted input first. Then generalize.

**Step 4: Work backwards from the answer.**

"If I knew the answer was X, what would the input look like?" This can reveal invariants or constraints that narrow the solution space.

**Step 5: State the brute force, then optimize.**

The brute force is always: try every possibility and check each one. State this explicitly:
- "The brute force is O(n^2) , check every pair."
- "Can I avoid redundant work? If I sort first, I can use two pointers instead."

Interviewers want to see this reasoning. A candidate who says "brute force is O(n^3), but I can reduce it to O(n log n) by sorting and using binary search" is showing exactly the thinking process FAANG evaluates.

### Communication During Coding Interviews

**Think out loud, always.** Silence is your enemy. The interviewer can't give you credit for thoughts they can't hear. Even when you're stuck, narrate:

- "I'm noticing that the constraint says n <= 10^4, which means O(n^2) should be fine..."
- "I'm stuck on the state transition for the DP. Let me go back to the example..."
- "I think there might be an edge case with empty input, let me handle that first..."

**When the interviewer gives a hint, take it.** Don't dismiss it or say "I was about to try that." Pause, process the hint, and incorporate it. Acknowledging the hint gracefully shows collaboration.

**When you realize your approach is wrong, say so immediately.** "I just realized this approach doesn't handle the case where there are duplicates. Let me pivot to using a hash map instead." Interviewers reward self-correction. They penalize stubbornly pursuing a broken approach.

**When you don't know something, be honest.** "I'm not sure about the exact API for Go's heap interface, but the approach would be to maintain a min-heap of size K and..." Faking knowledge always backfires.

### Go-Specific Interview Templates

Keep these patterns ready to deploy instantly:

**Binary Search Template:**

```go
func binarySearch(nums []int, target int) int {
    lo, hi := 0, len(nums)-1
    for lo <= hi {
        mid := lo + (hi-lo)/2 // Avoids integer overflow
        if nums[mid] == target {
            return mid
        } else if nums[mid] < target {
            lo = mid + 1
        } else {
            hi = mid - 1
        }
    }
    return -1 // Not found
}
```

**BFS Template (Graph/Tree Level Order):**

```go
func bfs(graph map[int][]int, start int) []int {
    visited := map[int]bool{start: true}
    queue := []int{start}
    result := []int{}

    for len(queue) > 0 {
        node := queue[0]
        queue = queue[1:]
        result = append(result, node)

        for _, neighbor := range graph[node] {
            if !visited[neighbor] {
                visited[neighbor] = true
                queue = append(queue, neighbor)
            }
        }
    }
    return result
}
```

**DFS Template (Backtracking):**

```go
func backtrack(nums []int, path []int, result *[][]int, used []bool) {
    if len(path) == len(nums) {
        tmp := make([]int, len(path))
        copy(tmp, path)
        *result = append(*result, tmp)
        return
    }
    for i := 0; i < len(nums); i++ {
        if used[i] {
            continue
        }
        used[i] = true
        path = append(path, nums[i])
        backtrack(nums, path, result, used)
        path = path[:len(path)-1]
        used[i] = false
    }
}
```

**Sliding Window Template:**

```go
func slidingWindow(s string) int {
    seen := map[byte]int{}
    left, maxLen := 0, 0

    for right := 0; right < len(s); right++ {
        seen[s[right]]++

        for /* window condition violated */ {
            seen[s[left]]--
            if seen[s[left]] == 0 {
                delete(seen, s[left])
            }
            left++
        }

        if right-left+1 > maxLen {
            maxLen = right - left + 1
        }
    }
    return maxLen
}
```

**Two Pointers Template:**

```go
func twoSum(nums []int, target int) (int, int) {
    // Assumes nums is sorted
    lo, hi := 0, len(nums)-1
    for lo < hi {
        sum := nums[lo] + nums[hi]
        if sum == target {
            return lo, hi
        } else if sum < target {
            lo++
        } else {
            hi--
        }
    }
    return -1, -1
}
```

These templates are your interview muscle memory. Practice them until you can write them without thinking, your brain should be focused on the problem, not the syntax.

### Junior → FAANG: Speed Through Pattern Automation, Not Rushing

Interview speed comes from pattern recognition, not from typing faster. When you can look at a problem and immediately categorize it (sliding window, two pointers, BFS, DP with memoization), the solution structure is 70% of the work. The templates in this section are the vehicle for building that recognition.

For each template, the practice protocol is: read the template once, close the file, write it from memory, check it, fix what you missed, repeat the next day. After five repetitions spread over a week, the template becomes reflexive. At that point, you can focus cognitive load on the problem-specific parts rather than the structural parts.

Prerequisite gap: many junior candidates do not have a solid BFS/DFS template because they solved each graph problem differently. Standardize your templates and stick to them. An interviewer who sees you consistently structure the same class of problem the same way interprets this as engineering discipline, not rigidity.

### Senior @ FAANG: Meta-Skills as a Measure of Engineering Judgment Under Pressure

For senior candidates, meta-skills are not supplemental to technical knowledge. They are the primary differentiator at L5 and above, where all candidates have solid algorithmic foundations. The meta-skill that matters most at senior level is managing cognitive load under constraint: knowing when to use a suboptimal but quickly implementable solution to buy time for analysis, versus when to invest in finding the optimal approach.

Concretely: a senior candidate who recognizes that an O(n log n) solution will fit within the time limit for the stated constraints, codes it correctly, and has three minutes left to discuss an O(n) optimization, outperforms the candidate who spent 35 minutes on the O(n) solution and submitted it with two minutes left and no time to test. Speed calibration against the problem's requirements is a senior meta-skill.

Bar-raiser signal: the ability to estimate time and communicate about it during the interview. "I think the brute-force solution will take me about 10 minutes to implement correctly. I want to use the first 5 minutes to think about whether there is a better approach. Is that okay?" This kind of explicit time management communication demonstrates the same project management instincts that FAANG expects from L6 engineers leading technical efforts.
