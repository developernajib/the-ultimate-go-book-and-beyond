## Exercises

### Exercise 1: Parallel Map-Reduce

Implement a parallel `map_reduce` function template that:
1. Takes a vector, a map function, a reduce function, and a number of threads.
2. Partitions the vector across threads.
3. Each thread maps its partition.
4. Results are reduced to a single value.

Test it by computing the sum of squares of 100 million integers.

### Exercise 2: Read-Write Lock with Writer Priority

Implement a reader-writer lock where writers have priority over readers. When a writer is waiting, new readers must wait even if the lock is currently read-held. This prevents writer starvation.

### Exercise 3: Bounded Concurrent Hash Map

Build a thread-safe hash map with the following requirements:
- Fixed number of buckets, each with its own `shared_mutex`.
- `get()` takes a shared lock on the relevant bucket.
- `put()` takes an exclusive lock on the relevant bucket.
- No global lock - different buckets can be accessed concurrently.
- Test with 8 writer threads and 32 reader threads.

### Exercise 4: Pipeline Pattern

Create a 4-stage processing pipeline using your `Channel` class:
1. Stage 1: Generate integers 1 to N.
2. Stage 2: Filter out odd numbers.
3. Stage 3: Square each remaining number.
4. Stage 4: Accumulate the sum.

Each stage runs on its own thread, connected by channels.

### Exercise 5: Dining Philosophers

Implement the dining philosophers problem with 5 philosophers. Demonstrate:
1. A version that deadlocks (all pick up left fork simultaneously).
2. A fix using `std::scoped_lock`.
3. A fix using a resource hierarchy (odd philosophers pick up left first, even pick up right first).
4. A fix using `try_lock` with random backoff.

### Exercise 6: Compare Parallel STL vs Manual Threading

Take a `std::vector<double>` of 10 million elements. Compute the standard deviation using:
1. Sequential `std::accumulate`.
2. `std::reduce` with `std::execution::par`.
3. Manual thread pool with 4 threads, each computing partial sums.

Benchmark all three and explain the results.

---

### Junior → FAANG: Concurrency Exercises as TSan-Verified Practice

Each exercise here should be completed under TSan verification (`-fsanitize=thread`). A correct concurrent implementation produces no TSan findings. If TSan finds a race condition in your solution, fix it before moving to the next exercise. This is the same discipline you should apply to production code.

### Senior @ FAANG: Concurrency Exercises as Team Onboarding Baseline

At the staff level, these exercises serve as the C++ concurrency onboarding baseline for your team. A new engineer who can complete exercises 1 through 4 with no TSan findings and can explain the benchmark results for exercise 5 is ready for concurrent C++ work on the team. This is a more objective measure than "has N years of C++ experience."

