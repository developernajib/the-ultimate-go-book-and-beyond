## Exercises

### Exercise 1: Fibonacci Generator with Limit
Write a generator that yields Fibonacci numbers but stops when the value exceeds a given limit. The generator should accept the limit as a parameter and cleanly terminate.

### Exercise 2: Async Retry with Backoff
Create an async task that wraps another async operation with retry logic. It should retry up to N times with exponential backoff (doubling the wait each time). Use a timer awaitable to implement the delay.

```cpp
// Signature:
template <typename T>
AsyncTask<T> with_retry(
    std::function<AsyncTask<T>()> operation,
    int max_retries,
    std::chrono::milliseconds initial_delay
);
```

### Exercise 3: Merge Two Generators
Write a function that takes two sorted `Generator<int>` instances and produces a single sorted `Generator<int>` by merging them (like merge sort's merge step).

```cpp
Generator<int> merge_sorted(Generator<int> a, Generator<int> b);
```

### Exercise 4: Round-Robin Scheduler
Build a scheduler that runs multiple coroutines in round-robin order. Each coroutine should yield control after doing a unit of work, and the scheduler should fairly alternate between them. Track how many times each coroutine was resumed.

### Exercise 5: Pipeline Processing
Create a coroutine pipeline that chains three stages: (1) a generator that reads integers, (2) a filter coroutine that passes only even numbers, (3) a transform coroutine that squares each value. The pipeline should be lazy, pulling one value through the entire chain on demand.

```cpp
Generator<int> source();
Generator<int> filter_even(Generator<int> input);
Generator<int> square(Generator<int> input);

// Usage: for (int val : square(filter_even(source()))) { ... }
```

---
