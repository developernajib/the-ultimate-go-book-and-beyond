## 66.1 Two Pointer Techniques

### Opposite Direction Pointers

Opposite-direction pointers work by placing one pointer at each end of a sorted array and converging them toward the center. Because the array is sorted, moving the left pointer right increases the sum while moving the right pointer left decreases it. This eliminates the need for a nested loop and reduces O(n²) brute force to O(n). The key insight is that at any point, every pair outside the current window has already been proven impossible, so no candidate is ever skipped.

```go
// Two Sum II - Input Array Is Sorted (LeetCode 167)
// Given sorted array, find two numbers that sum to target
// Time: O(n), Space: O(1)
func twoSum(numbers []int, target int) []int {
    left, right := 0, len(numbers)-1

    for left < right {
        sum := numbers[left] + numbers[right]
        if sum == target {
            return []int{left + 1, right + 1} // 1-indexed
        }
        if sum < target {
            left++
        } else {
            right--
        }
    }
    return nil
}

// Container With Most Water (LeetCode 11)
// Find two lines that form container with most water
// Time: O(n), Space: O(1)
func maxArea(height []int) int {
    left, right := 0, len(height)-1
    maxWater := 0

    for left < right {
        width := right - left
        h := min(height[left], height[right])
        water := width * h

        if water > maxWater {
            maxWater = water
        }

        // Move the shorter line inward
        if height[left] < height[right] {
            left++
        } else {
            right--
        }
    }
    return maxWater
}

// 3Sum (LeetCode 15)
// Find all unique triplets that sum to zero
// Time: O(n²), Space: O(1) excluding output
func threeSum(nums []int) [][]int {
    slices.Sort(nums)
    result := [][]int{}

    for i := 0; i < len(nums)-2; i++ {
        // Skip duplicates for first number
        if i > 0 && nums[i] == nums[i-1] {
            continue
        }

        // Two-pointer for remaining two numbers
        left, right := i+1, len(nums)-1
        target := -nums[i]

        for left < right {
            sum := nums[left] + nums[right]
            if sum == target {
                result = append(result, []int{nums[i], nums[left], nums[right]})

                // Skip duplicates
                for left < right && nums[left] == nums[left+1] {
                    left++
                }
                for left < right && nums[right] == nums[right-1] {
                    right--
                }
                left++
                right--
            } else if sum < target {
                left++
            } else {
                right--
            }
        }
    }
    return result
}

// Trapping Rain Water (LeetCode 42)
// Calculate trapped water between bars
// Time: O(n), Space: O(1)
func trap(height []int) int {
    if len(height) == 0 {
        return 0
    }

    left, right := 0, len(height)-1
    leftMax, rightMax := 0, 0
    water := 0

    for left < right {
        if height[left] < height[right] {
            if height[left] >= leftMax {
                leftMax = height[left]
            } else {
                water += leftMax - height[left]
            }
            left++
        } else {
            if height[right] >= rightMax {
                rightMax = height[right]
            } else {
                water += rightMax - height[right]
            }
            right--
        }
    }
    return water
}
```

### Same Direction Pointers (Fast-Slow)

Same-direction pointers solve in-place mutation problems by maintaining two positions within a single pass: a `fast` pointer that scans every element and a `slow` pointer that marks the boundary of the valid result. When `fast` finds a value that belongs in the output, it is written to the `slow` position and `slow` advances. This avoids allocating a second array while preserving the relative order of kept elements, which is why it is the standard pattern for problems like removing duplicates or filtering values in-place.

```go
// Remove Duplicates from Sorted Array (LeetCode 26)
// Remove duplicates in-place, return new length
// Time: O(n), Space: O(1)
func removeDuplicates(nums []int) int {
    if len(nums) == 0 {
        return 0
    }

    slow := 0
    for fast := 1; fast < len(nums); fast++ {
        if nums[fast] != nums[slow] {
            slow++
            nums[slow] = nums[fast]
        }
    }
    return slow + 1
}

// Move Zeroes (LeetCode 283)
// Move all zeroes to end while maintaining relative order
// Time: O(n), Space: O(1)
func moveZeroes(nums []int) {
    slow := 0
    for fast := 0; fast < len(nums); fast++ {
        if nums[fast] != 0 {
            nums[slow], nums[fast] = nums[fast], nums[slow]
            slow++
        }
    }
}

// Remove Element (LeetCode 27)
// Remove all occurrences of val in-place
// Time: O(n), Space: O(1)
func removeElement(nums []int, val int) int {
    slow := 0
    for fast := 0; fast < len(nums); fast++ {
        if nums[fast] != val {
            nums[slow] = nums[fast]
            slow++
        }
    }
    return slow
}
```

### Junior → FAANG: Building Two-Pointer Intuition

The key insight for opposite-direction pointers is the elimination argument: at any state, every pair involving both pointers can be evaluated by comparing their sum to the target. Moving the pointer with the smaller value inward eliminates all pairs between the current left pointer and every other position, because none of those pairs could produce a larger sum than what we already have. This invariant is what makes the algorithm correct and what you should be able to articulate when an interviewer asks "why does moving the left pointer preserve correctness?"

For same-direction (fast-slow) pointers, the invariant is: everything before `slow` satisfies the output condition, and `fast` has advanced further to find the next valid element. The critical mental model is that `fast` reads and `slow` writes, and they never "cross" in a way that corrupts data.

For Trapping Rain Water, the two-pointer solution's correctness rests on the observation that if `height[left] < height[right]`, then the water at `left` is limited by `leftMax` regardless of what is on the right side, because there is something at least as tall as `rightMax` to the right. If you cannot derive this reasoning on demand, the problem will feel like magic. Derive it until it feels mechanical.

### Senior @ FAANG: Two-Pointer Patterns in System Code

Two-pointer techniques appear outside of interviews in parser implementations, network packet processing, and buffer management. A tokenizer that maintains a `start` pointer to the beginning of the current token and advances an `end` pointer to find the token boundary is a same-direction two-pointer algorithm. A merge step in an external merge sort that reads from two sorted input buffers and writes to an output buffer is a two-pointer algorithm across separate arrays, with both pointers advancing forward.

In production Go code, the equivalent of the "fast-slow" pointer pattern appears when using `io.Reader`: one goroutine reads from the network into a buffer, advancing the write position, while another consumes from the beginning of the buffer, advancing the read position. The correctness invariant is the same as the in-place fast-slow pattern: the read position never advances past the write position.

For a bar-raiser interview at staff level, the Trapping Rain Water problem becomes a system design question: "How would you compute the maximum water storage capacity of a terrain described by a stream of elevation readings that arrives in real time, where the terrain can change as readings arrive?" The two-pointer approach does not directly apply because the data is streaming. The correct answer involves maintaining a monotonic stack or a segment tree that supports point updates and range maximum queries, each at O(log n) per update. Recognizing that the static two-pointer solution needs to be redesigned for the streaming variant, and knowing how to redesign it, is the bar-raiser signal.

---
