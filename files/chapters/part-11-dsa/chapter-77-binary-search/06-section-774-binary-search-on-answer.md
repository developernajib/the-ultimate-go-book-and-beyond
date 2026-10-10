## 77.4 Binary Search on Answer

Many problems can be solved by binary searching on the answer space rather than on the data.

### Split Array Largest Sum

Binary search on the answer space is applicable when the decision function "is it possible to achieve a result of at most X?" is monotone: if X is feasible, then any larger value is also feasible. The range is bounded below by `max(nums)`, since no split can produce a part smaller than the largest single element, and above by `sum(nums)`, which is the one-part split. Checking feasibility greedily costs O(n), so the whole search is O(n log(sum)). The direct dynamic programming solution to this problem is O(n^2 * m), so the win here is real but it is a better polynomial, not a rescue from intractability.

```go
// SplitArray minimizes the largest sum when splitting into m parts
// LeetCode 410: Split Array Largest Sum
// Time: O(n * log(sum)), Space: O(1)
func SplitArray(nums []int, m int) int {
    // Answer is between max element and sum of all elements
    low, high := 0, 0
    for _, num := range nums {
        if num > low {
            low = num
        }
        high += num
    }

    for low < high {
        mid := low + (high-low)/2

        if canSplit(nums, m, mid) {
            high = mid
        } else {
            low = mid + 1
        }
    }

    return low
}

// canSplit checks if we can split into m parts with max sum <= maxSum
func canSplit(nums []int, m, maxSum int) bool {
    count := 1
    currentSum := 0

    for _, num := range nums {
        if currentSum+num > maxSum {
            count++
            currentSum = num
            if count > m {
                return false
            }
        } else {
            currentSum += num
        }
    }

    return true
}

// MinDays to make m bouquets of k adjacent flowers
// LeetCode 1482: Minimum Number of Days to Make m Bouquets
func MinDays(bloomDay []int, m int, k int) int {
    n := len(bloomDay)
    if m*k > n {
        return -1
    }

    low, high := 1, 0
    for _, day := range bloomDay {
        if day > high {
            high = day
        }
    }

    for low < high {
        mid := low + (high-low)/2

        if canMakeBouquets(bloomDay, m, k, mid) {
            high = mid
        } else {
            low = mid + 1
        }
    }

    return low
}

func canMakeBouquets(bloomDay []int, m, k, day int) bool {
    bouquets := 0
    consecutive := 0

    for _, d := range bloomDay {
        if d <= day {
            consecutive++
            if consecutive == k {
                bouquets++
                consecutive = 0
            }
        } else {
            consecutive = 0
        }
    }

    return bouquets >= m
}
```

### Capacity To Ship Packages

This problem has the same structural shape as `SplitArray`: the answer lies in `[max(weights), sum(weights)]` and the feasibility check is monotone. A ship that can deliver in `days` days at capacity `C` can certainly do so at capacity `C+1`. The greedy `canShip` function simulates loading packages in order (no reordering allowed, since packages must ship in sequence), starting a new day whenever the current load would be exceeded.

```go
// ShipWithinDays finds minimum capacity to ship within days
// LeetCode 1011: Capacity To Ship Packages Within D Days
func ShipWithinDays(weights []int, days int) int {
    low, high := 0, 0
    for _, w := range weights {
        if w > low {
            low = w
        }
        high += w
    }

    for low < high {
        mid := low + (high-low)/2

        if canShip(weights, days, mid) {
            high = mid
        } else {
            low = mid + 1
        }
    }

    return low
}

func canShip(weights []int, days, capacity int) bool {
    daysNeeded := 1
    currentLoad := 0

    for _, w := range weights {
        if currentLoad+w > capacity {
            daysNeeded++
            currentLoad = w
        } else {
            currentLoad += w
        }
    }

    return daysNeeded <= days
}
```

### Koko Eating Bananas

The minimum viable eating speed is 1 banana/hour and the maximum needed is `max(piles)`. At that speed every pile is finished in exactly one hour. The ceiling division `(pile + speed - 1) / speed` is the integer arithmetic equivalent of `ceil(pile / speed)` and avoids floating-point entirely, which matters for correctness when `pile` is not evenly divisible by `speed`.

```go
// MinEatingSpeed finds minimum eating speed to finish within h hours
// LeetCode 875: Koko Eating Bananas
func MinEatingSpeed(piles []int, h int) int {
    low, high := 1, 0
    for _, pile := range piles {
        if pile > high {
            high = pile
        }
    }

    for low < high {
        mid := low + (high-low)/2

        if canFinish(piles, h, mid) {
            high = mid
        } else {
            low = mid + 1
        }
    }

    return low
}

func canFinish(piles []int, h, speed int) bool {
    hours := 0
    for _, pile := range piles {
        hours += (pile + speed - 1) / speed // Ceiling division
    }
    return hours <= h
}
```

### Junior -> FAANG: Identifying Binary Search on Answer Opportunities

The three problems in this section share a shape: "find the minimum/maximum value of parameter X such that some greedy condition holds." The trigger words in problem statements are: "minimum," "maximum," "at most," "at least," "within," "capacity," and "speed." When you see these combined with a constraint on a discrete or continuous parameter, ask immediately: "is the feasibility check monotone in the parameter?"

All three checks are monotone non-decreasing in their parameter, which is the property the search needs. For `SplitArray`, raising `maxSum` only ever lets a greedy part absorb more elements, so it can never turn a feasible split infeasible. For `Koko`, raising the speed can only lower the hours each pile takes. For `MinDays`, raising the day limit only adds bloomed flowers and never removes one. State the argument in that form, "increasing the parameter cannot break a solution that already worked", because that is the shape of the proof an interviewer is listening for. Once monotonicity is established, the binary search setup is mechanical.

The ceiling division `(pile + speed - 1) / speed` is the canonical integer ceiling formula. Know it cold. It avoids floating-point entirely and works correctly for all positive integer inputs.

### Senior @ FAANG: Binary Search on Answer in System Design

Binary search on answer is not limited to algorithmic problems. It appears directly in system design: capacity planning (minimum fleet size to handle load), database index tuning (minimum index granularity for target query latency), and distributed rate limiting (minimum token bucket refill rate to satisfy SLA under peak traffic).

In each case, the design question is "what is the minimum resource level such that the system meets its SLA?" The feasibility check is a simulation or a closed-form model, and the answer space is bounded by physics or economics. The binary search structure is the same: binary search over the answer range, evaluate feasibility at each midpoint, converge to the minimum viable level.

A staff engineer at FAANG who presents a capacity plan should be able to explain whether their model's feasibility function is monotone in the resource parameter and what happens at the boundaries (at minimum resource, the system clearly fails - at maximum resource, it clearly succeeds). If the function is not monotone (for example, adding more servers initially helps but eventually hurts due to coordination overhead), binary search is inapplicable and the analysis requires a different approach. Identifying this nuance in a design review is the difference between a thorough analysis and a flawed one.
