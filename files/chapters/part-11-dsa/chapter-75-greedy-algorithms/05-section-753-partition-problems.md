## 75.3 Partition Problems

Partition problems ask you to split a collection into groups that satisfy certain constraints. In the "Partition Labels" problem, for example, you must divide a string into as many parts as possible such that each letter appears in at most one part. The greedy strategy records the last occurrence of every character, then sweeps left to right, extending the current partition's boundary whenever a character's last occurrence is farther ahead. When you reach the boundary, you close that partition and start a new one. Some partition problems (like partitioning into k equal-sum subsets) do not have the greedy choice property and require backtracking instead.

```go
// PartitionLabels partitions string so each letter appears in at most one part
// LeetCode 763: Partition Labels
// Time: O(n), Space: O(1)
func PartitionLabels(s string) []int {
    // Find last occurrence of each character
    lastIndex := make(map[byte]int)
    for i := 0; i < len(s); i++ {
        lastIndex[s[i]] = i
    }

    result := []int{}
    start, end := 0, 0

    for i := 0; i < len(s); i++ {
        if lastIndex[s[i]] > end {
            end = lastIndex[s[i]]
        }

        if i == end {
            result = append(result, end-start+1)
            start = i + 1
        }
    }

    return result
}

// CanPartitionKSubsets reports whether nums can be split into k subsets of
// equal sum.
// LeetCode 698: Partition to K Equal Sum Subsets
//
// Backtracking with pruning, not greedy. Greedy fails here: committing a
// number to the current subset now can starve a later subset, and no local
// rule tells you which commitment is safe. Sorting descending is only a
// pruning heuristic (large items fail fast), never a correctness argument.
// Time: exponential in the worst case, Space: O(n).
func CanPartitionKSubsets(nums []int, k int) bool {
    if k <= 0 || k > len(nums) {
        return false
    }

    sum := 0
    for _, num := range nums {
        sum += num
    }

    if sum%k != 0 {
        return false
    }

    target := sum / k

    // Sort descending: place the most constrained items first.
    slices.SortFunc(nums, func(a, b int) int {
        return cmp.Compare(b, a)
    })

    if nums[0] > target {
        return false
    }

    used := make([]bool, len(nums))

    var backtrack func(index, currentSum, subsetsRemaining int) bool
    backtrack = func(index, currentSum, subsetsRemaining int) bool {
        if subsetsRemaining == 0 {
            return true
        }

        if currentSum == target {
            return backtrack(0, 0, subsetsRemaining-1)
        }

        for i := index; i < len(nums); i++ {
            if used[i] || currentSum+nums[i] > target {
                continue
            }

            // Skip duplicates
            if i > 0 && nums[i] == nums[i-1] && !used[i-1] {
                continue
            }

            used[i] = true
            if backtrack(i+1, currentSum+nums[i], subsetsRemaining) {
                return true
            }
            used[i] = false
        }

        return false
    }

    return backtrack(0, 0, k)
}
```

### Junior → FAANG: Recognizing the Partition Label Pattern

Partition Labels (LeetCode 763) is a favorite phone screen problem because the greedy insight is non-obvious and clean once understood. The prerequisite is recognizing that "each letter appears in at most one part" means each part must contain every occurrence of its characters. That leads directly to tracking the last occurrence of each character and extending the current partition boundary whenever a new character's last occurrence is farther out.

Practice this problem until you can write it from scratch in under 8 minutes. Common mistakes: using a frequency count instead of a last-index map, incrementing `start` by 1 instead of `i + 1`, and forgetting that the partition size is `end - start + 1`, not just `end`.

The Partition to K Equal Sum Subsets problem is included as a contrast: it looks like a partition problem but requires backtracking. In an interview, if you correctly identify that this one needs backtracking and articulate why greedy fails (choosing a number to add to a subset now can prevent later subsets from reaching the target), you demonstrate exactly the greedy-vs-backtracking judgment interviewers are testing.

### Senior @ FAANG: Partition Algorithms in Data Pipeline Design

Partition algorithms are a core primitive in data engineering. Kafka topic partitioning, Spark RDD partitioning, BigQuery table sharding, and S3 key prefix distribution all involve partition decisions that affect downstream throughput and correctness. Understanding the algorithmic properties of different partition strategies is a staff-level concern.

**Range partitioning versus hash partitioning.** Range partitioning groups data by contiguous key ranges, choosing boundaries that minimize the largest partition. Worth being precise about the algorithm here, because it is a common interview follow-up: picking those boundaries greedily (fill the current partition until it exceeds a quota, then cut) does not minimize the maximum. Greedy is only the feasibility check. The standard solution binary searches on the answer, asking "can I cover everything in k partitions with no partition exceeding M?" and answers each probe with exactly that greedy sweep. This is the same structure as Split Array Largest Sum, and it is a good example of greedy serving as a subroutine inside a non-greedy algorithm rather than as the algorithm itself.

Range partitioning works well when keys are uniformly distributed but produces hot partitions when data is skewed. Hash partitioning avoids hot partitions but gives up efficient range queries. The staff engineer choosing between these is applying the same analysis as choosing between greedy selection and search: does the local choice ever prevent a better global arrangement? For hash partitioning, no, because the placement of one key does not constrain any other. For range partitioning with skewed data, yes, and a feedback-driven adaptive repartitioning strategy is needed.

**Governance of partition decisions.** At scale, partition decisions have performance SLA implications that span teams. A data platform team that decides to repartition a 10 PB table must coordinate with all downstream consumers, update dependency tracking systems, and ensure the partition key change does not break downstream join semantics. The ADR for this decision includes: the current partition key and its distribution, the new partition key and its expected distribution, the correctness argument for why the new strategy dominates for the expected query pattern, the rollback plan, and the monitoring metrics that validate the decision post-deployment.

**Maturity model for partition strategies.** A mature data platform does not choose a partition strategy once and freeze it. It monitors partition size distribution, detects skew automatically, and rebalances partitions using a greedy heuristic (assign the largest partition to the least-loaded node) on a scheduled basis. Building this feedback loop is a staff-level infrastructure investment with a well-defined ROI argument: reduced query latency, fewer hot partitions, and more predictable SLA compliance.
