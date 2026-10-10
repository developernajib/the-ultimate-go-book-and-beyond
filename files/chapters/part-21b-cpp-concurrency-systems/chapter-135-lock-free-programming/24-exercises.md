## Exercises

### Exercise 1: Lock-Free Counter with Max

Implement a lock-free `fetch_add_capped` function that atomically increments a counter but never exceeds a maximum value. Return the old value if the increment succeeded, or `-1` if the cap was reached.

```cpp
// Skeleton
int fetch_add_capped(std::atomic<int>& counter, int max_val) {
    // Your CAS loop here
}
```

### Exercise 2: Lock-Free Singly-Linked Set

Implement a lock-free sorted linked list that supports `insert(int)`, `remove(int)`, and `contains(int)`. Use marked pointers (steal the lowest bit of next-pointers) to handle concurrent deletion without ABA issues. This is the Harris linked list algorithm.

### Exercise 3: MPMC Bounded Queue

Implement a multi-producer, multi-consumer bounded queue using an array and two atomic indices. Avoid false sharing. Handle the full/empty conditions without locks.

Hint: Use a sequence number per slot to distinguish between "slot is ready to write" and "slot is ready to read."

### Exercise 4: Wait-Free Register

Implement a wait-free single-writer, multi-reader register using the technique from Section 4. Verify that readers always see a consistent value, even under extreme contention.

### Exercise 5: RCU Configuration Store

Build an RCU-protected configuration store in C++ using the `SimpleRCU` pattern from Section 5. Support:
- `get(key)`, lock-free read.
- `set(key, value)`, copy-on-write update.
- `snapshot()`, return an immutable copy of the entire config.

Write a stress test with 8 reader threads and 1 writer thread.

### Junior → FAANG: Exercise Approach for Lock-Free Correctness

For exercise 1 (lock-free stack with hazard pointers): do not start with the hazard pointer implementation. Start with the CAS loop for push/pop assuming no reclamation (use a node pool that never frees). Verify correctness under TSan. Then add hazard pointer reclamation. This incremental approach isolates correctness bugs from reclamation bugs.

For exercise 4 (config store with RCU): start with `std::atomic<std::shared_ptr<Config>>` for the simplest correct implementation. Only optimize to Folly RCU if benchmarks show the `shared_ptr` atomic load is a bottleneck. The stress test with 8 readers and 1 writer should include a correctness assertion: readers should never see a partially-updated config.

The TSan run is not optional. Run every exercise under TSan with at least 4 threads for 10 seconds minimum. A clean single-threaded test is necessary but not sufficient.

### Senior @ FAANG: Exercise Extensions for Staff Preparation

Extend exercise 1 to benchmark the hazard pointer implementation against: (a) a mutex-based stack, (b) a lock-free stack without reclamation (to measure reclamation overhead), and (c) Folly's `hazptr`-based implementation. Plot throughput at 1, 4, 16, 32 threads. Understand where each implementation wins and why.

Extend exercise 4 to simulate a write-heavy scenario (10% writes, 90% reads vs. the inverse) and measure how RCU degrades under write pressure (copy-on-write cost) compared to a reader-writer lock. Document the crossover point.

For staff-level preparation: implement the litmus test for exercise 1's CAS loop using `herd7`. The litmus test validates that the acquire/release ordering on the CAS is necessary and correct. Running it on both x86 and ARM memory models confirms the implementation is portable. This is the kind of artifact that distinguishes L6 candidates in a systems interview.

---
