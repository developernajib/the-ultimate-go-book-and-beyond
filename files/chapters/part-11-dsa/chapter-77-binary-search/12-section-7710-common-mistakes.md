## 77.10 Common Mistakes

### Mistake 1: Integer Overflow in Mid Calculation

When `left + right` exceeds the largest value the index type can hold, the sum wraps to a negative number and `(left + right) / 2` produces a negative mid, which panics on the next index. The alternative `left + (right-left)/2` computes the same midpoint and never forms a value above `right`, so it cannot wrap.

Be precise about when this actually bites, because this mistake is more often recited than understood. It is a live bug in Java and C, where indices are 32-bit and a few billion elements are enough to overflow. It is what broke `java.util.Arrays.binarySearch`. In Go, `int` is 64-bit on every 64-bit platform, and a slice large enough to overflow `left + right` would need roughly 2^62 elements, which no machine can hold. So the buggy line below is not reachable in ordinary 64-bit Go.

Write the safe form regardless. It costs nothing, it survives a port to a 32-bit target or a narrowing to `int32`, and reviewers expect it. Just describe it accurately: it is a habit that protects against a class of bug, not a defect you are patching in your Go code today.

```go
// BAD: overflows if left+right exceeds the index type's range.
// Unreachable for a real slice on 64-bit Go, fatal in 32-bit code.
func badBinarySearch(nums []int, target int) int {
    left, right := 0, len(nums)-1
    for left <= right {
        mid := (left + right) / 2 // wraps negative when left+right > MaxInt
        if nums[mid] == target {
            return mid
        } else if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }
    return -1
}

// GOOD: Safe mid calculation
func goodBinarySearch(nums []int, target int) int {
    left, right := 0, len(nums)-1
    for left <= right {
        mid := left + (right-left)/2 // Safe from overflow
        if nums[mid] == target {
            return mid
        } else if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }
    return -1
}
```

### Mistake 2: Wrong Loop Termination Condition

In an exact-match search over the closed range `[left, right]`, using `left < right` exits one iteration too early. When the window narrows to a single candidate, `left == right`, the condition is already false and that last element is never compared, so the function reports "not found" for a target that is present. Searching for 5 in `[5]` returns -1. The condition `left <= right` examines the single-element window before terminating.

To be clear about what is being claimed: `left < right` is not a bug on its own, it is the correct condition for Template 2, where the loop converges on a boundary and returns `left` without ever needing to inspect a final candidate. The mistake is using it with Template 1's structure, where the answer is found by comparison inside the loop. The condition has to match the invariant, and neither condition is universally right.

```go
// BAD: Using < instead of <= can miss elements
func badTermination(nums []int, target int) int {
    left, right := 0, len(nums)-1
    for left < right { // Wrong! Misses case when target is at single element
        mid := left + (right-left)/2
        if nums[mid] == target {
            return mid
        } else if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }
    return -1
}

// GOOD: Correct termination
func goodTermination(nums []int, target int) int {
    left, right := 0, len(nums)-1
    for left <= right { // Correct: processes all elements
        mid := left + (right-left)/2
        if nums[mid] == target {
            return mid
        } else if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }
    return -1
}
```

### Mistake 3: Infinite Loop with Wrong Update

When using the `left < right` template for boundary-finding searches, assigning `left = mid` instead of `left = mid + 1` can create an infinite loop. This happens when `left` and `right` are adjacent: `mid` equals `left`, and the assignment `left = mid` makes no progress. The fix is to always ensure `left` strictly advances by writing `left = mid + 1`, guaranteeing the search space shrinks every iteration.

```go
// BAD: Infinite loop when mid doesn't change
func badUpdate(nums []int, target int) int {
    left, right := 0, len(nums)-1
    for left < right {
        mid := left + (right-left)/2
        if nums[mid] < target {
            left = mid // Wrong! Can cause infinite loop when left = mid = right - 1
        } else {
            right = mid
        }
    }
    return left
}

// GOOD: Ensure progress in each iteration
func goodUpdate(nums []int, target int) int {
    left, right := 0, len(nums)-1
    for left < right {
        mid := left + (right-left)/2
        if nums[mid] < target {
            left = mid + 1 // Correct: always moves forward
        } else {
            right = mid
        }
    }
    return left
}
```

### Mistake 4: Off-by-One in Boundary Search

Finding the first or last occurrence of a target requires narrowing the search space toward the boundary rather than stopping at the first match. Setting `right = mid` when a match is found keeps the match inside the search space instead of excluding it, and inside a `left <= right` loop that does not merely bias the answer, it hangs. Once `left == right == mid` and `nums[mid] == target`, the assignment `right = mid` changes nothing, the loop condition still holds, and the next iteration recomputes the identical `mid` forever. Searching for 5 in `[5]` never terminates. The correct update is `right = mid - 1`, which records the match and forces the loop to continue strictly to the left, shrinking the window every time.

Note that this is the mirror image of Mistake 3. Both are the same underlying error, a bound that does not move, and both fail the check "does the window strictly shrink on every path?" Mistake 3 fails it on the `left` side inside a half-open loop, this one fails it on the `right` side inside a closed loop.

```go
// BAD: Wrong boundary for finding first occurrence
func badFirstOccurrence(nums []int, target int) int {
    left, right := 0, len(nums)-1
    result := -1
    for left <= right {
        mid := left + (right-left)/2
        if nums[mid] == target {
            result = mid
            right = mid // Wrong! Hangs: mid never moves. Use mid - 1.
        } else if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }
    return result
}

// GOOD: Correct boundary update
func goodFirstOccurrence(nums []int, target int) int {
    left, right := 0, len(nums)-1
    result := -1
    for left <= right {
        mid := left + (right-left)/2
        if nums[mid] == target {
            result = mid
            right = mid - 1 // Correct: continue searching left
        } else if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }
    return result
}
```

### Mistake 5: Wrong Initial Right Bound

Initializing `right` to `len(nums)` instead of `len(nums)-1` sets the upper bound to one past the last valid index. Combined with `left <= right`, the loop can reach `left == right == len(nums)`, and `nums[mid]` then panics. The panic is not immediate, which is what makes this one nasty: the first few iterations compute a mid safely inside the slice, so the function passes casual testing and only dies when the target is absent and greater than every element, driving `left` all the way up. Use `right = len(nums)-1` for a closed range, and guard the empty slice before the loop.

The half-open range `right = len(nums)` is not wrong in itself. It is exactly what `LowerBound` and `sort.Search` use. What is wrong is pairing it with `left <= right` and an unguarded `nums[mid]`. The bound and the loop condition are a matched pair: closed range with `<=`, half-open range with `<`. Mixing them is what breaks.

```go
// BAD: Off-by-one initial bounds
func badBounds(nums []int, target int) int {
    left, right := 0, len(nums) // Wrong! Right should be len(nums)-1 for valid index
    for left <= right {
        mid := left + (right-left)/2
        // nums[mid] can cause index out of bounds when right = len(nums)
        if nums[mid] == target {
            return mid
        }
        // ...
    }
    return -1
}

// GOOD: Correct initial bounds
func goodBounds(nums []int, target int) int {
    if len(nums) == 0 {
        return -1
    }
    left, right := 0, len(nums)-1 // Correct bounds
    for left <= right {
        mid := left + (right-left)/2
        if nums[mid] == target {
            return mid
        } else if nums[mid] < target {
            left = mid + 1
        } else {
            right = mid - 1
        }
    }
    return -1
}
```

### Junior -> FAANG: Making Error Prevention Automatic

The five mistakes above correspond to five mechanical checks you should verbalize at the end of every binary search implementation. Say out loud: "midpoint: I used `lo + (hi-lo)/2`. Loop condition: I chose `<=` for exact match and `<` for boundary. Left update: I wrote `left = mid + 1` not `left = mid`. First/last occurrence: I set `right = mid - 1` not `right = mid` when recording a match. Initial right: I used `len(nums)-1` for closed range and checked bounds before accessing."

These five checks take under 15 seconds and catch the majority of binary search bugs before the interviewer sees them. Interviewers at FAANG are watching whether you self-review or need to be prompted. Self-reviewing is a strong positive signal.

For the initial bounds mistake (Mistake 5), the edge case that exposes it is an empty array. Always add `if len(nums) == 0 { return -1 }` before entering the loop. This is also correct behavior for the algorithm, not just a safety check: an empty array has no valid indices, and the result is trivially "not found."

### Senior @ FAANG: Turning Recurring Mistakes into Tooling

These five mistakes are well-known enough that they have been analyzed at FAANG scale. The midpoint overflow bug (Mistake 1) famously existed in Java's built-in `Arrays.binarySearch` for approximately 9 years before being fixed in 2006, and was documented in a Google Research blog post. At FAANG, the response to a known bug class is not better education but better tooling.

For Go teams, a static analysis pass that detects `(left + right) / 2` where `left` and `right` are integer indices is straightforward to write using `go/analysis`. The analyzer flags the expression and suggests the safe alternative. This type of domain-specific linter, written once, catches the bug for every engineer on the team forever.

For the "wrong update causes infinite loop" bug (Mistake 3), a fuzz test that runs the binary search on random sorted arrays and detects execution that exceeds a logarithmic number of iterations is another effective tool. Fuzz testing binary search implementations is fast (O(log n) iterations per input) and covers edge cases that property-based tests miss. At FAANG, requiring fuzz tests for all binary search implementations in shared infrastructure libraries is a reasonable engineering standard.
