## Exercises

### Exercise 1: Implement a Movable String Class

Write a `MyString` class that:
- Manages a dynamically allocated `char*` buffer
- Implements all five special member functions (Rule of Five)
- Move constructor and move assignment must be `noexcept`
- Provides `size()`, `c_str()`, and `operator<<` for printing
- Include a static counter that tracks total allocations and deallocations

Test it by inserting 10,000 `MyString` objects into a `std::vector` and verify that moves happen during reallocation (not copies).

### Exercise 2: Perfect Forwarding Factory

Write a `create<T>` factory function template that:
- Takes any number of arguments
- Perfectly forwards all arguments to `T`'s constructor
- Returns a `std::unique_ptr<T>`
- Add logging to show which constructor (copy or move) is called

Test with a class that has both copy and move constructors, passing lvalues and rvalues.

### Exercise 3: Move-Aware Container

Implement a `SmallVector<T, N>` class that:
- Stores the first `N` elements on the stack (no heap allocation)
- Falls back to heap allocation when `size() > N`
- Supports move construction and move assignment
- When moving, the heap-allocated buffer is transferred (not copied), but stack-allocated elements must be moved individually

Benchmark your container against `std::vector` for small sizes (N=8, 16).

### Exercise 4: Detect Value Categories

Write a set of overloaded functions that print the value category of their argument:

```cpp
template<typename T>
void detect(T& x)  { std::cout << "lvalue\n"; }

template<typename T>
void detect(T&& x) { std::cout << "rvalue\n"; }
```

Use them to verify the value category of:
- A local variable
- `std::move(variable)`
- A literal `42`
- A function call returning by value
- A function call returning by reference
- `static_cast<int&&>(variable)`

### Exercise 5: Benchmark Copy Elision

Write a program that:
1. Defines a class with instrumented copy/move constructors (print when called)
2. Returns an instance from a function (should trigger NRVO)
3. Returns an instance with `std::move` (should prevent NRVO)
4. Returns a conditional instance (may or may not trigger NRVO)
5. Compile with `-fno-elide-constructors` (GCC/Clang) to see what happens without RVO

Compare constructor call counts for each case.

### Exercise 6: Thread-Safe Move

Design a `ThreadSafeQueue<T>` that:
- Uses `std::mutex` for thread safety
- `push(T&& item)` moves the item into the queue
- `push(const T& item)` copies the item into the queue
- `pop()` returns `std::optional<T>`, moving the front element out
- Demonstrate that large objects are moved, not copied, through the queue

---

### Junior → FAANG: Exercise Progression as a Readiness Check

Complete the exercises in order. The move-only string exercise tests Rule of Five + move semantics. The lock-free queue exercise introduces concurrency. If you cannot complete the string exercise without ASan findings, do not proceed to the queue exercise. Each exercise is a prerequisite for the next in terms of C++ proficiency.

### Senior @ FAANG: Move Semantics Exercises as Interview Design Templates

The movable string class exercise is a classic FAANG C++ interview problem (L4/L5 level). The expected solution covers: the Rule of Five, `noexcept` move constructor, correct null-termination after move, and correct self-assignment handling. A candidate who completes this in 30 minutes with zero ASan findings and can explain every decision is L4-ready. A candidate who also discusses small string optimization (SSO) and explains when a `noexcept` move constructor enables `std::vector` reallocation to use moves is L5-ready.

Use this exercise as a calibration anchor when designing your team's technical screen. Define what a passing solution looks like, what a passing-with-distinction solution looks like, and what a failing solution looks like. Write it down before the interview, not after.

