## Exercises

### Exercise 1: Safe Configuration Parser

Write a configuration parser using `std::expected`, `std::optional`, and `std::variant`. The parser reads key-value pairs where values can be integers, doubles, booleans, or strings. Return `std::expected<Config, ParseError>` from the parse function. Use `std::variant<int, double, bool, std::string>` for values.

### Exercise 2: Pipeline Processing with Ranges

Given a vector of `Employee` structs (name, department, salary_cents, years_experience), use C++20 ranges to:
- Filter employees with salary_cents > 100'000'00LL
- Group by department (hint: sort then chunk_by)
- Transform to compute average salary_cents per department
- Sort departments by average salary_cents descending

### Exercise 3: Producer-Consumer with Coroutines

Implement a producer-consumer system using C++20 coroutines. The producer generates items (use `co_yield`), and the consumer processes them lazily. Add a filter coroutine in between that only passes items matching a predicate. Compose the three stages.

### Exercise 4: Thread Pool with Synchronization Primitives

Build a simple thread pool using `std::jthread`, `std::counting_semaphore`, and `std::latch`. The pool should:
- Accept a maximum concurrency level (semaphore)
- Wait for all submitted tasks to complete (latch)
- Support cooperative cancellation via stop tokens

### Exercise 5: Compile-Time Lookup Table

Use `consteval` and `constexpr` to build a compile-time lookup table that maps HTTP status codes to their string descriptions. The table should be fully constructed at compile time. Write a `consteval` function that validates all entries are unique.

### Exercise 6: Filesystem Analyzer

Using `<filesystem>` and parallel algorithms, write a directory analyzer that:
- Recursively scans a directory tree
- Groups files by extension
- Computes total size per extension
- Identifies the 10 largest files
- Reports duplicate files (same size + name)
Use execution policies to parallelize the analysis.

### Exercise 7: Variant-Based Expression Evaluator

Build a simple arithmetic expression evaluator using `std::variant` and visitor pattern. Define an `Expr` variant that can be a `Number`, `Add`, `Subtract`, `Multiply`, or `Divide` node. Implement `evaluate(const Expr&)` using `std::visit`. Handle division by zero using `std::expected<double, std::string>`.

### Exercise 8: Concept-Constrained Generic Logger

Design a logging framework using C++20 concepts. Define concepts for `Serializable`, `Loggable`, and `Formattable`. Write a `Logger` class that accepts any type satisfying `Loggable`, formats it using `std::format` if it satisfies `Formattable`, and falls back to a default representation otherwise. Use `if constexpr` to choose the path at compile time.

### Junior → FAANG: Modern C++ Exercises as Feature Fluency Tests

Each exercise here isolates one C++17/20 feature and forces you to use it correctly. The configuration parser tests `std::optional` and `std::variant`. The logging framework tests concepts and `if constexpr`. Complete each exercise before reading the next chapter, because the concepts chain: move semantics enables efficient optional, optional enables safe API design, concepts enable constrained templates that use both.

### Senior @ FAANG: Using These Exercises to Calibrate C++20 Readiness Across a Team

At the staff level, these exercises are calibration tools for assessing a team's C++20 readiness before a standard adoption project. Run the exercises as a team workshop: each engineer completes them independently, then the team reviews solutions together. Patterns in the solutions reveal: which features are well understood (likely already in use informally), which features are misused (a specific training target), and which features are unknown (requires dedicated study time before adoption).

The output of this workshop informs the standard adoption ADR: which C++20 features can be adopted immediately (strong baseline), which need a training period first, and which should be deferred to a later phase.


---
