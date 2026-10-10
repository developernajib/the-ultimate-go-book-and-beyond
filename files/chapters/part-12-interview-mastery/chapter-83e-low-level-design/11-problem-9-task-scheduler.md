## 83E.11 Problem 9: Task Scheduler

### Requirements

1. Tasks labeled A-Z, each requiring 1 unit of time
2. Cooldown period n: same task must wait n intervals before repeating
3. CPU can idle if no task is available
4. Find minimum time to complete all tasks

This is **LeetCode 621: Task Scheduler**.

### Implementation

Task scheduler design tests priority queue management and understanding of the CPU scheduling algorithms that operating systems use. The following Go implementation uses a min-heap keyed on earliest deadline, demonstrating how the same data structure supports preemptive and cooperative scheduling policies.

```go
package scheduler

import "container/heap"

func LeastInterval(tasks []byte, n int) int {
	// Count frequencies
	freq := make(map[byte]int)
	for _, t := range tasks {
		freq[t]++
	}

	// Max-heap of frequencies
	h := &intMaxHeap{}
	for _, f := range freq {
		heap.Push(h, f)
	}

	time := 0
	for h.Len() > 0 {
		// Process one cycle of n+1 slots
		cycle := n + 1
		var waitQueue []int // tasks that still need processing after cooldown

		for cycle > 0 && h.Len() > 0 {
			count := heap.Pop(h).(int)
			count--
			if count > 0 {
				waitQueue = append(waitQueue, count)
			}
			time++
			cycle--
		}

		// Push remaining tasks back to heap
		for _, count := range waitQueue {
			heap.Push(h, count)
		}

		// If there are still tasks, add idle time for remaining cycle slots
		if h.Len() > 0 {
			time += cycle
		}
	}

	return time
}

// --- Math approach (optimal) ---

func LeastIntervalMath(tasks []byte, n int) int {
	freq := make([]int, 26)
	for _, t := range tasks {
		freq[t-'A']++
	}

	maxFreq := 0
	maxCount := 0
	for _, f := range freq {
		if f > maxFreq {
			maxFreq = f
			maxCount = 1
		} else if f == maxFreq {
			maxCount++
		}
	}

	// Formula: (maxFreq - 1) * (n + 1) + maxCount
	// But total tasks might exceed this if n is small
	result := (maxFreq-1)*(n+1) + maxCount
	if len(tasks) > result {
		return len(tasks)
	}
	return result
}

// --- Heap implementation ---

type intMaxHeap []int

func (h intMaxHeap) Len() int            { return len(h) }
func (h intMaxHeap) Less(i, j int) bool   { return h[i] > h[j] } // max-heap
func (h intMaxHeap) Swap(i, j int)        { h[i], h[j] = h[j], h[i] }
func (h *intMaxHeap) Push(x interface{})  { *h = append(*h, x.(int)) }
func (h *intMaxHeap) Pop() interface{} {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}
```

**Complexity:**
- Heap approach: O(n * 26 * log 26) = O(n) where n is total tasks
- Math approach: O(n) to count frequencies, O(1) to compute

**Key insight (math approach):** The most frequent task determines the minimum time. Arrange tasks in a grid where each row is a cooldown cycle of size `n+1`. The formula `(maxFreq - 1) * (n + 1) + maxCount` gives the minimum slots needed.


### Junior → FAANG: Task Scheduler LLD Basics

The task scheduler LLD problem (LeetCode 621) asks for the minimum time to execute all tasks given a cooldown constraint between same-type tasks. The greedy algorithm: always execute the most frequent remaining task, then wait for the cooldown period. The mathematical formula gives the answer without simulation: the minimum time is max(total_tasks, (max_freq - 1) * (cooldown + 1) + count_of_tasks_with_max_freq). Know both the simulation approach (priority queue, O(n log k) time) and the formula approach (O(n) time) and be able to explain why both are correct.

### Senior @ FAANG: Task Scheduler at the Senior Bar: Production Scheduling Systems

At the senior level, the task scheduler LLD connects to production job scheduling systems. The LeetCode problem is a CPU task scheduling model. In production, the constraints are different (network I/O is the bottleneck rather than CPU, tasks have dependencies rather than cooldowns, and task priorities may differ). The production discussion covers: how would you design a task scheduler that respects dependencies (DAG-based scheduling, topological sort), how would you handle tasks that can fail and need retry (at-least-once execution semantics, dead letter queue for repeatedly failing tasks), and how would you make the scheduler observable (task state tracking, latency percentiles per task type, queue depth monitoring). These are the questions that connect the LLD to the system design and distinguish candidates who can reason at both levels.

---
