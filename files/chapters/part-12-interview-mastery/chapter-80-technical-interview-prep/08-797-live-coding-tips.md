## 80.7 Live Coding Tips

### Whiteboard/Live Coding Strategies

Whiteboard and live coding sessions evaluate not just correctness but the candidate's ability to communicate their thought process clearly while writing code under observation. The following framework demonstrates the narration pattern, stating assumptions, explaining the approach, then implementing incrementally, that separates candidates who perform well under pressure from those who think silently.

```go
// 1. CLARIFY FIRST
/*
- Ask about input constraints (size, range, edge cases)
- Ask about expected output format
- Confirm assumptions before coding
- Ask: "Can I use the standard library?"
*/

// 2. START WITH SIGNATURE
func Solution(input []int) []int {
    // Start with clear function signature
    // Return type, parameter types
    return nil
}

// 3. WRITE SKELETON FIRST
func Solution(nums []int) int {
    // Edge cases
    if len(nums) == 0 {
        return 0
    }

    // Main logic (to be filled)
    result := 0

    // Process
    for i := range nums {
        _ = i  // Process element
    }

    return result
}

// 4. HANDLE EDGE CASES FIRST
func SafeDivide(a, b int) (int, error) {
    if b == 0 {
        return 0, errors.New("division by zero")
    }
    return a / b, nil
}

// 5. USE MEANINGFUL VARIABLE NAMES
// Bad: for i, v := range arr { if v > x { r = append(r, v) } }
// Good:
for _, num := range numbers {
    if num > threshold {
        result = append(result, num)
    }
}

// 6. WRITE TEST CASES
func TestSolution(t *testing.T) {
    tests := []struct {
        name     string
        input    []int
        expected int
    }{
        {"empty", []int{}, 0},
        {"single", []int{1}, 1},
        {"normal", []int{1, 2, 3}, 6},
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            got := Solution(tt.input)
            if got != tt.expected {
                t.Errorf("got %d, want %d", got, tt.expected)
            }
        })
    }
}
```

### Common Interview Code Patterns

Design patterns encode proven solutions to recurring problems, and Go's use of interfaces and first-class functions shapes how they are implemented. The following example adapts the pattern to idiomatic Go, using interfaces and closures rather than class hierarchies.

```go
// Two Pointer
func twoSum(nums []int, target int) []int {
    left, right := 0, len(nums)-1
    for left < right {
        sum := nums[left] + nums[right]
        if sum == target {
            return []int{left, right}
        } else if sum < target {
            left++
        } else {
            right--
        }
    }
    return nil
}

// Sliding Window
func maxSum(nums []int, k int) int {
    if len(nums) < k {
        return 0
    }

    windowSum := 0
    for i := 0; i < k; i++ {
        windowSum += nums[i]
    }

    maxSum := windowSum
    for i := k; i < len(nums); i++ {
        windowSum = windowSum - nums[i-k] + nums[i]
        maxSum = max(maxSum, windowSum)
    }

    return maxSum
}

// HashMap for O(1) lookup
func twoSumMap(nums []int, target int) []int {
    seen := make(map[int]int)  // value -> index
    for i, num := range nums {
        complement := target - num
        if j, ok := seen[complement]; ok {
            return []int{j, i}
        }
        seen[num] = i
    }
    return nil
}

// BFS template
func bfs(graph [][]int, start int) []int {
    visited := make([]bool, len(graph))
    queue := []int{start}
    visited[start] = true
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

// DFS template
func dfs(graph [][]int, node int, visited []bool) {
    visited[node] = true

    for _, neighbor := range graph[node] {
        if !visited[neighbor] {
            dfs(graph, neighbor, visited)
        }
    }
}
```

---

### Junior → FAANG: Turning Live Coding from Terror into Process

Live coding is a skill distinct from problem-solving ability. Many junior candidates who can solve hard LeetCode problems alone freeze when asked to code on a shared screen. The fix is deliberate practice of the performance, not just the solution.

Three habits that address the most common junior failures: first, narrate everything you write, not after the fact but as you write it ("I am initializing a visited set here because the graph may have cycles"). Second, write test cases before touching the algorithm, which forces you to understand the problem before coding and impresses interviewers regardless of seniority level. Third, leave time to test your solution by tracing through your example by hand before claiming it is correct.

Prerequisite gap: if you have never coded in a shared environment (CoderPad, HackerRank, or a Google Doc), do at least three practice sessions in exactly those environments. Syntax highlighting, autocomplete, and familiar layouts reduce cognitive load, and their absence in interview environments increases error rates.

### Senior @ FAANG: Live Coding as Technical Communication, Not Just Execution

For senior candidates, live coding rounds are as much a communication assessment as a technical one. The interviewer at L5/L6 level expects you to drive the problem space before driving to a solution. This means explicitly scoping the problem ("I am going to assume single-threaded access for now and add locking if you want to discuss concurrent usage"), proposing multiple approaches before choosing one ("I see a recursive DFS solution and an iterative BFS solution, I will go with BFS to avoid stack overflow on deep graphs"), and flagging trade-offs as you code.

Bar-raiser live coding patterns: a bar-raiser candidate produces code that a stranger could review without verbal explanation. Variable names reflect domain concepts, function decomposition follows single responsibility, and comments appear only where the algorithm needs explanation. When the interviewer says "can you make this more efficient," a bar-raiser candidate already knows the answer because they articulated the complexity before writing the first line.

Staff-level live coding signal: the ability to backtrack cleanly. When a senior engineer realizes mid-implementation that their approach has a flaw, they stop, acknowledge the flaw explicitly, explain why the current approach does not work, and pivot. This is not a failure signal. It is a maturity signal. The L6 bar is not writing the perfect solution in one pass. It is demonstrating clear thinking under uncertainty, which is the daily reality of staff engineering.
