## 75.2 Jump Game Problems

Jump game problems give you an array where each element tells you the maximum distance you can jump forward from that position. The goal is either to determine whether you can reach the last index (Jump Game I) or to find the minimum number of jumps to get there (Jump Game II). The greedy approach tracks the farthest index reachable so far as you scan left to right. If at any position you have not been reached yet, the answer is impossible. For the minimum-jumps variant, you treat each "level" of reachable positions like BFS layers, incrementing your jump count each time you exhaust the current layer and move to the next farthest boundary.

```go
// CanJump determines if you can reach the last index
// LeetCode 55: Jump Game
// Time: O(n), Space: O(1)
func CanJump(nums []int) bool {
    maxReach := 0

    for i := 0; i < len(nums); i++ {
        if i > maxReach {
            return false
        }
        if i+nums[i] > maxReach {
            maxReach = i + nums[i]
        }
        if maxReach >= len(nums)-1 {
            return true
        }
    }

    return true
}

// Jump returns minimum jumps to reach end
// LeetCode 45: Jump Game II
// Time: O(n), Space: O(1)
func Jump(nums []int) int {
    if len(nums) <= 1 {
        return 0
    }

    jumps := 0
    currentEnd := 0
    farthest := 0

    for i := 0; i < len(nums)-1; i++ {
        if i+nums[i] > farthest {
            farthest = i + nums[i]
        }

        if i == currentEnd {
            jumps++
            currentEnd = farthest
            if currentEnd >= len(nums)-1 {
                break
            }
        }
    }

    return jumps
}

// CanReach determines if you can reach any index holding value 0.
// LeetCode 1306: Jump Game III
//
// This one is BFS, not greedy. Jumps go both directions, so there is no
// monotone "farthest reachable" frontier to exploit: reaching the target may
// require moving backward first. Reach for greedy only when progress is
// one-directional.
// Time: O(n), Space: O(n)
func CanReach(arr []int, start int) bool {
    n := len(arr)
    visited := make([]bool, n)
    queue := []int{start}

    for len(queue) > 0 {
        i := queue[0]
        queue = queue[1:]

        if arr[i] == 0 {
            return true
        }

        if visited[i] {
            continue
        }
        visited[i] = true

        // Jump forward
        if i+arr[i] < n && !visited[i+arr[i]] {
            queue = append(queue, i+arr[i])
        }
        // Jump backward
        if i-arr[i] >= 0 && !visited[i-arr[i]] {
            queue = append(queue, i-arr[i])
        }
    }

    return false
}
```

### Junior → FAANG: Getting Jump Game Right Under Pressure

Jump Game I and II are among the most common greedy problems in phone screens. The key insight for Jump Game I is maintaining `maxReach` and checking `i > maxReach`: if you are at a position you cannot reach, return false immediately. Do not wait until the loop ends. This early exit is both correct and demonstrates clean thinking.

For Jump Game II, the mental model is BFS layers. `currentEnd` is the boundary of the current layer, and `farthest` is the boundary of the next layer. Every time you reach `currentEnd`, you "jump" by incrementing `jumps` and extending the boundary to `farthest`. Practice drawing this on a whiteboard with a small array like `[2,3,1,1,4]` until the layer boundaries are intuitive.

Common mistakes to avoid: modifying the input array, using DP instead of the O(n) greedy pass, and forgetting the `len(nums) <= 1` base case for Jump Game II. In Go, also remember that `nums[i]` is the maximum jump, not a fixed jump, so some elements might be zero (which is the source of many wrong solutions).

### Senior @ FAANG: Jump Game as a Model for Reachability Analysis

The jump game's greedy insight generalizes to a broad class of reachability problems: given a set of reachable states and a transition function, what is the minimum number of transitions to reach a target? This framing appears in network hop analysis, deployment rollout planning, and feature flag propagation tracking.

**Production application: deployment wave planning.** Large infrastructure changes are commonly rolled out in waves across regions, where each wave unlocks the next set once health signals come back clean. Model this as a jump game, with each wave a position and the jump distance the number of regions it unlocks, and you can estimate the minimum number of wave cycles to full rollout with the same linear pass. The estimate is only trustworthy while the reach of a wave is fixed in advance and independent of which waves ran before it, which is exactly the assumption the next paragraph breaks.

**When the greedy breaks: correlated failures.** The jump game greedy fails when jumps are not independent. If activating position `i` reduces the effective reach of position `j` (correlated resource contention), `maxReach` is no longer a valid bound and the greedy gives an optimistic answer. In distributed systems, this is the "cascading failure" scenario: a deployment wave that consumes too much capacity reduces the reach of subsequent waves. The staff-level response is to add a capacity model to the reach calculation rather than using the raw jump value.

**Interview bar-raiser extension.** A strong L6 candidate, when asked "extend Jump Game II to minimize jumps subject to a cost per jump," immediately recognizes this moves from greedy to DP (or Dijkstra), states the reason (future jump costs depend on which position you land on, breaking the greedy choice property), and provides the DP formulation in under two minutes. The ability to recognize the boundary where greedy breaks and pivot cleanly to the correct algorithm is a top-band differentiator.
