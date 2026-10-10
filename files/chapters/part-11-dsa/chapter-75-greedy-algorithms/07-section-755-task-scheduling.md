## 75.5 Task Scheduling

Task scheduling problems ask you to execute a set of tasks subject to cooldown or spacing constraints and find the minimum total time. The classic CPU task scheduler (LeetCode 621) requires a cooldown of n intervals between two executions of the same task type. The greedy/math approach focuses on the most frequent task: it determines how many idle slots are forced by the cooldown, then fills those slots with less frequent tasks. The formula `(maxFreq - 1) * (n + 1) + maxCount` captures the minimum intervals, where `maxCount` is the number of tasks sharing the highest frequency.

```go
// LeastInterval finds the minimum number of intervals to run every task, given
// that identical tasks must be separated by at least cooldown idle-or-other
// slots.
// LeetCode 621: Task Scheduler
// Time: O(len(tasks)), Space: O(1) (the frequency table is a fixed 26 entries).
func LeastInterval(tasks []byte, cooldown int) int {
    if len(tasks) == 0 {
        return 0
    }

    freq := make([]int, 26)
    maxFreq := 0

    for _, task := range tasks {
        freq[task-'A']++
        if freq[task-'A'] > maxFreq {
            maxFreq = freq[task-'A']
        }
    }

    // Count how many task types tie for the maximum frequency. The maxFreq > 0
    // test matters: without it an empty input would make every one of the 26
    // zeroed buckets "tie" at zero and the formula would return garbage.
    maxCount := 0
    for _, f := range freq {
        if f == maxFreq && maxFreq > 0 {
            maxCount++
        }
    }

    // Minimum intervals forced by the cooldown.
    intervals := (maxFreq-1)*(cooldown+1) + maxCount

    // If there are more tasks than the forced schedule has slots, the extra
    // tasks fill the idle gaps and the task count itself is the answer.
    return max(intervals, len(tasks))
}

// TaskSchedulerII finds the minimum number of days to complete all tasks, where
// the same task type must be separated by at least space days.
// LeetCode 2365: Task Scheduler II
// Time: O(len(tasks)), Space: O(distinct task types)
func TaskSchedulerII(tasks []int, space int) int64 {
    lastDay := make(map[int]int64)
    day := int64(0)

    for _, task := range tasks {
        day++
        if last, ok := lastDay[task]; ok {
            if day <= last+int64(space) {
                day = last + int64(space) + 1
            }
        }
        lastDay[task] = day
    }

    return day
}
```

### Junior → FAANG: Understanding the Task Scheduler Formula Deeply

The CPU task scheduler formula `(maxFreq - 1) * (n + 1) + maxCount` is frequently memorized without being understood, and interviewers can always tell. The derivation: the most frequent task forces `(maxFreq - 1)` cooling blocks, each of size `(n + 1)` (one execution plus n idle or other-task slots). After all blocks, you add the `maxCount` tasks that share the maximum frequency (they all go in the final position). The answer is `max(this formula, len(tasks))` because if there are enough other tasks to fill all idle slots, no idle time is needed.

Trace through a specific example: tasks = [A,A,A,B,B,C], cooldown = 2. maxFreq = 3 (A appears 3 times), maxCount = 1. Formula: (3-1)*(2+1) + 1 = 7. len(tasks) = 6. Answer: 7. Draw the schedule, writing `_` for an idle slot:

```
A B C | A B _ | A
```

Seven slots. Each A is three positions after the previous one, satisfying the cooldown of 2. Only one idle slot is needed, because B and C are available to fill the others. Now check that 6 is impossible: any 6-slot arrangement must place three A's among six positions with two gaps of at least two between them, which needs at least 1 + 3 + 3 = 7 positions. That lower bound is exactly what the formula computes.

Also confirm the guard on the other side. With tasks = [A,A,A,B,B,B,C,C,C,D,D,E] and cooldown = 2, the formula gives (3-1)*3 + 3 = 9, but there are 12 tasks. There is no way to run 12 tasks in 9 slots, so the answer is `max(9, 12) = 12` and no idling is required at all. That `max` is not a defensive nicety, it is load-bearing.

For Task Scheduler II, the approach is simpler: track the last day each task was done and skip forward if the cooldown has not expired. The `int64` return type is there because `space` can be up to 1e9 and the task list can be long, so the day counter can exceed the range you would get away with in a smaller type.

### Senior @ FAANG: Task Scheduling in Real Compute Infrastructure

The CPU task scheduler problem is a simplified model of real workload scheduling, and the gap between the simplified model and production reality is where senior engineers add value.

**Real CPU schedulers.** Linux's Completely Fair Scheduler (CFS) picks the runnable task with the smallest virtual runtime, a quantity that advances in proportion to real time scaled by the task's weight. It keeps tasks in a red-black tree so that selection and reinsertion are O(log n). Linux has since replaced CFS with EEVDF (Earliest Eligible Virtual Deadline First) as the default in kernel 6.6, which adds a latency-sensitive deadline to the same virtual-time accounting. Borg, whose design Google published, schedules by priority with preemption and quota accounting. None of these is greedy in the interview sense of "provably optimal by an exchange argument." They are greedy in the weaker, more practical sense: each decision picks the local extremum of a maintained priority metric, with no lookahead and no backtracking. That distinction is worth stating precisely, because production schedulers optimize for fairness and latency rather than makespan, and they carry no optimality proof at all. Where a proven bound does exist, it is for the classic offline formulations: LPT (Longest Processing Time first) schedules on m identical machines within a factor of 4/3 - 1/(3m) of the optimal makespan.

**Cooldown scheduling in distributed systems.** The task scheduler problem maps directly to distributed rate limiting with per-key cooldowns. In a recommendation serving system, the same recommendation should not be shown to a user within a 30-minute window (cooldown n = 30 minutes). A greedy approach tracks the last-shown timestamp per item per user and skips items in cooldown. At scale (millions of users, thousands of items), this requires a distributed cache (Redis sorted sets work well) and careful TTL management. Resist the temptation to carry the interview problem's optimality proof across. LeetCode 621 is offline: the whole multiset of tasks is known up front, which is precisely what licenses the counting formula. A serving system is online, deciding without knowing what requests arrive next, and "always serve the highest-priority item not in cooldown" minimizes nothing in particular. It is a reasonable heuristic whose value has to be measured with an experiment rather than proved. Confusing the offline bound for an online guarantee is the exact error the rest of this chapter is training you to catch.

**ADR framing.** A staff engineer proposing to replace a round-robin serving policy with cooldown-aware greedy scheduling writes an ADR that includes: the current serving distribution, the expected impact on repeat-impression rate, the correctness argument (greedy minimizes idle slots, maximizing throughput), the performance cost of the Redis lookup per request, and the monitoring metrics (repeat impression rate, cache hit rate, p99 serving latency) that validate the change post-deployment.
