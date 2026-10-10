## 77.12 Interview Pitfalls

### Pitfall 1: Infinite Loop from Wrong Midpoint or Update

**Incident Report**: A candidate's binary search ran forever because they wrote `left = mid` instead of `left = mid + 1` in a left-boundary search. Integer division rounds down, so when `right == left + 1` the midpoint is `left` itself. Assigning `left = mid` writes `left` back onto itself, nothing shrinks, and the next iteration recomputes the same `mid`. The loop spins on a two-element window forever.

The midpoint form is not what breaks here. Both versions below compute `mid` identically. The only difference is the update rule, which is the point: this pitfall is about progress, not overflow.

```go
// ❌ WRONG: Infinite loop when searching left boundary
func searchLeftBad(nums []int, target int) int {
    left, right := 0, len(nums)-1

    for left < right {
        mid := left + (right-left)/2  // Rounds down: mid == left when right == left+1
        if nums[mid] < target {
            left = mid  // BUG: When left=mid, we don't progress!
        } else {
            right = mid
        }
    }
    return left
}

// ✅ CORRECT: Use mid+1 when moving left
func searchLeftGood(nums []int, target int) int {
    left, right := 0, len(nums)-1

    for left < right {
        mid := left + (right-left)/2
        if nums[mid] < target {
            left = mid + 1  // MUST move past mid
        } else {
            right = mid
        }
    }

    if left < len(nums) && nums[left] == target {
        return left
    }
    return -1
}
```

### Pitfall 2: Integer Overflow in Midpoint Calculation

**Incident Report**: A candidate wrote `(left + right) / 2` and was asked what happens when the sum exceeds the index type's maximum. They did not have an answer.

This is the pitfall most likely to be discussed and least likely to fire. The wrap is real where indices are 32-bit, and it is what broke `java.util.Arrays.binarySearch` for years. On 64-bit Go it takes about 2^62 elements to reach, so no slice can trigger it. Write `left + (right - left) / 2` regardless: it is free, it is what a reviewer expects, and it survives a port to a narrower index type. What earns the point in an interview is describing the bound accurately rather than reciting a danger you have not checked.

```go
// ❌ WRONG: Overflow when left + right > MaxInt
func searchBad(nums []int, target int) int {
    left, right := 0, len(nums)-1

    for left <= right {
        mid := (left + right) / 2  // Overflows if both are large!
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

// ✅ CORRECT: Overflow-safe midpoint
func searchGood(nums []int, target int) int {
    left, right := 0, len(nums)-1

    for left <= right {
        mid := left + (right-left)/2  // Never overflows!
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

### Pitfall 3: Off-by-One in Boundary Conditions

**Incident Report**: A candidate's "find first occurrence" panicked because they used the half-open bound `right = len(nums)` and then indexed `nums[left]` after the loop without a bounds check. When the target is larger than every element, the loop converges on `left == len(nums)`, which is a valid answer for a lower bound and an invalid index.

The half-open bound is not the mistake. It is correct here and is what `sort.Search` uses. The mistake is forgetting that a lower bound is allowed to return "one past the end", which is precisely how it reports "everything is smaller than the target".

```go
// ❌ WRONG: Off-by-one accessing nums[right]
func findFirstBad(nums []int, target int) int {
    left, right := 0, len(nums)  // right = len, not len-1

    for left < right {
        mid := left + (right-left)/2
        if nums[mid] >= target {
            right = mid
        } else {
            left = mid + 1
        }
    }

    // BUG: left could equal len(nums), need bounds check!
    if nums[left] == target {  // Panic if left == len
        return left
    }
    return -1
}

// ✅ CORRECT: Always check bounds before access
func findFirstGood(nums []int, target int) int {
    left, right := 0, len(nums)

    for left < right {
        mid := left + (right-left)/2
        if nums[mid] >= target {
            right = mid
        } else {
            left = mid + 1
        }
    }

    // Bounds check before access!
    if left < len(nums) && nums[left] == target {
        return left
    }
    return -1
}
```

### Pitfall 4: Wrong Template for the Problem Type

**Incident Report**: A candidate used the `left <= right` exact-match template for "find peak element". Peak finding has no target to compare against and needs `left < right`, which converges the window onto the answer itself. The wrong template does not merely return a wrong index here, it panics: the loop lets `mid` reach `len(nums)-1`, and `nums[mid] > nums[mid+1]` then reads one past the end.

What makes this one nasty is that it does not fail on the obvious test. `findPeakBad([]int{1, 2, 3, 1})` returns 2, the correct answer, because the window never drives `left` to the last index. Feed it an ascending array, where the peak is the final element, and it dies: `[1]`, `[1, 2]`, and `[1, 2, 3]` all panic. A candidate who tests only the textbook mountain array ships this bug and never sees it.

```go
// ❌ WRONG: Using exact match template for peak finding
func findPeakBad(nums []int) int {
    left, right := 0, len(nums)-1

    for left <= right {  // Wrong template!
        mid := left + (right-left)/2

        if nums[mid] > nums[mid+1] {  // Crashes when mid = len-1
            right = mid - 1
        } else {
            left = mid + 1
        }
    }
    return left  // May be wrong
}

// ✅ CORRECT: Use left < right for convergence problems
func findPeakGood(nums []int) int {
    left, right := 0, len(nums)-1

    for left < right {  // Converges to single element
        mid := left + (right-left)/2

        if nums[mid] > nums[mid+1] {
            // Peak is at mid or to the left
            right = mid
        } else {
            // Peak is to the right
            left = mid + 1
        }
    }
    return left  // left == right, both point to peak
}
```

### Pitfall 5: Binary Search on Answer Without Proper Bounds

**Incident Report**: A candidate's "capacity to ship packages" solution started the search at `left = 0` instead of `left = max(weights)`. A ship must be able to carry the heaviest single package, so any capacity below that is not merely suboptimal, it is impossible. The search happily returned one anyway.

Be clear about which bound is at fault, because the instinct is to suspect the wrong one. `right = sum(weights)` is correct: it is the capacity that ships everything in a single day, so the answer can never exceed it. An upper bound that is loose costs only a few extra iterations and never costs correctness. The lower bound is different. Starting below `max(weights)` puts values into the search space that no valid answer can occupy, and whether the search returns one depends entirely on whether the feasibility check rejects them.

Here it does not, which is the second half of the bug. Look at `canShip` below: when a package is heavier than `capacity`, it starts a new day and loads the package anyway, never reporting failure. So `canShip([5], days=3, capacity=0)` returns true, and `shipWithinDaysBad([5], 3)` returns a capacity of 0 for a 5kg package.

The two halves depend on each other, and that is the part worth taking away. `canShip` is not wrong on its own: it is written against the precondition `capacity >= max(weights)`, and it is correct whenever the bounds honor that. The lower bound is what was supposed to establish the precondition, and it did not. Neither piece is independently broken. The contract between them is.

So there are two repairs at different levels. Setting `left = max(weights)` fixes this instance. Making the check reject `w > capacity`, as `canShipStrict` does below, fixes the class: the search then converges correctly even from a sloppy lower bound, because infeasible capacities are actually reported infeasible. Prefer the second when the check is exported or reused, since the next caller will not know the precondition existed. The general rule for binary search on the answer: the search is only ever as sound as its feasibility check, and a check that silently accepts impossible inputs converts a bad bound into a confident wrong answer.

```go
// ❌ WRONG: Incorrect lower bound
func shipWithinDaysBad(weights []int, days int) int {
    left, right := 0, 0
    for _, w := range weights {
        right += w
    }
    // BUG: left should be max(weights), not 0!
    // A ship must hold at least the heaviest package.
    // right = sum(weights) is fine: that is the one-day capacity.

    for left < right {
        mid := left + (right-left)/2
        if canShip(weights, days, mid) {
            right = mid
        } else {
            left = mid + 1
        }
    }
    // shipWithinDaysBad([]int{5}, 3) returns 0. A capacity of zero
    // cannot carry a 5kg package, but canShip below never says so.
    return left
}

// ✅ CORRECT: Proper bounds for binary search on answer
func shipWithinDaysGood(weights []int, days int) int {
    left, right := 0, 0
    for _, w := range weights {
        if w > left {
            left = w  // Min capacity = heaviest package
        }
        right += w  // Max capacity = all packages
    }

    for left < right {
        mid := left + (right-left)/2
        if canShip(weights, days, mid) {
            right = mid
        } else {
            left = mid + 1
        }
    }
    return left
}

// canShip assumes capacity >= max(weights). Note what it does NOT do:
// when a package is heavier than capacity it starts a new day and loads
// it anyway, rather than reporting failure. That is why the lower bound
// in shipWithinDaysBad is not a harmless inefficiency but a wrong answer.
func canShip(weights []int, days, capacity int) bool {
    dayCount, currentLoad := 1, 0
    for _, w := range weights {
        if currentLoad+w > capacity {
            dayCount++
            currentLoad = w
        } else {
            currentLoad += w
        }
    }
    return dayCount <= days
}

// canShipStrict is the defensive version. It validates the precondition
// instead of assuming it, so a caller with a bad lower bound gets a
// correct answer rather than a plausible-looking wrong one.
func canShipStrict(weights []int, days, capacity int) bool {
    dayCount, currentLoad := 1, 0
    for _, w := range weights {
        if w > capacity {
            return false // no single day can carry this package
        }
        if currentLoad+w > capacity {
            dayCount++
            currentLoad = w
        } else {
            currentLoad += w
        }
    }
    return dayCount <= days
}
```

### Interview Pitfalls Quick Reference

| Pitfall | Symptom | Prevention |
|---------|---------|------------|
| Infinite loop | Program hangs | Ensure left or right changes each iteration |
| Integer overflow | Wrong midpoint | Use left + (right-left)/2 |
| Off-by-one | Wrong result, panic | Check bounds before array access |
| Wrong template | Wrong answer | Match template to problem type |
| Bad search bounds | Answer out of range | Think carefully about min/max possible values |
| left=mid without +1 | Infinite loop | When using mid, ensure convergence |

---

### Junior -> FAANG: Recognizing Pitfall Symptoms in Live Coding

The quick reference table above maps symptoms to causes. In a live coding session, if your test case runs longer than expected, the symptom is "infinite loop" and the cause is almost certainly "left = mid without +1" or "wrong loop condition." Stop immediately, check whether your update rule guarantees progress, and fix it before running more tests.

If your result is off by one (returning index 3 when the answer is 4, or returning -1 when the element is at the last position), the symptom is "wrong answer on boundary" and the cause is likely "wrong loop condition" or "wrong boundary" (right = len vs right = len-1). Trace through your algorithm for the boundary case: target at first position, target at last position, single-element array.

Pitfall 5 (wrong initial bounds) is the most dangerous of the set, because it does not announce itself. The search returns a plausible answer for most test cases and is wrong only at the extreme where the true answer sits at the lower bound. Always test an input whose answer is exactly the lower bound. For Capacity to Ship, that is the case where every package ships on its own day and the capacity equals the heaviest package.

### Senior @ FAANG: Pitfall Prevention in Framework Design

The five pitfalls above are five separate footguns in a raw binary search loop. Writing the loop once, correctly, behind an interface removes four of them from every call site:

```go
// BinarySearch finds the smallest index in [lo, hi) where pred returns true.
// pred must be monotone: false for all indices before the answer, true for all after.
// Returns hi if pred is false for all indices in [lo, hi).
func BinarySearch(lo, hi int, pred func(int) bool) int {
    for lo < hi {
        mid := lo + (hi-lo)/2 // safe midpoint form: pitfall 2
        if pred(mid) {
            hi = mid // hi strictly shrinks, since mid < hi
        } else {
            lo = mid + 1 // lo strictly advances: pitfall 1
        }
    }
    return lo // the boundary, computed once and correctly: pitfalls 3 and 4
}
```

Map that against the list. Pitfall 1 (infinite loop from `lo = mid`) is gone, since `lo = mid + 1` is the only update in the body. Pitfall 2 (midpoint form) is gone for the same reason: there is one midpoint expression in the codebase now, not one per call site. Pitfall 3 (off-by-one, reading past the end) is gone because the function returns an index and never dereferences anything, leaving the bounds check where it belongs, at the caller. Pitfall 4 (wrong template) is gone because there is only one template left to choose.

Pitfall 5 (wrong bounds for a search on the answer) is the one that survives, and it is worth understanding why: `lo` and `hi` are the caller's arguments, and no API can know that a ship must hold the heaviest package. The same is true of the predicate's monotonicity, which this function requires and cannot verify. Checking monotonicity exhaustively is O(n) and defeats the entire point of searching, while sampling a couple of indices is close to worthless, since a predicate that flips once in the middle will pass a random spot check almost every time. Put the guarantee where it is affordable: assert monotonicity in tests over generated inputs, and derive the bounds in one reviewed helper rather than by hand at each call site.

Building this utility with generics and a test suite covering each pitfall is solid infrastructure work. It is worth doing on its merits: it removes a recurring bug class from a shared library permanently.
