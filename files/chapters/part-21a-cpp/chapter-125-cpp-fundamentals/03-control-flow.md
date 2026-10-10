## Control Flow

C++ control flow will feel familiar to Go developers, but there are important differences in syntax and additional constructs that Go lacks.

### If Statements

**In Go:**

```go
x := 42

// No parentheses required, braces required
if x > 0 {
    fmt.Println("positive")
} else if x == 0 {
    fmt.Println("zero")
} else {
    fmt.Println("negative")
}

// Init statement in if
if err := doSomething(); err != nil {
    fmt.Println(err)
}
```

**In C++:**

```cpp
int x = 42;

// Parentheses required, braces optional (but always use them!)
if (x > 0) {
    std::cout << "positive\n";
} else if (x == 0) {
    std::cout << "zero\n";
} else {
    std::cout << "negative\n";
}

// C++17 init statement in if (same concept as Go!)
if (auto result = doSomething(); result.has_value()) {
    std::cout << result.value() << "\n";
}

// Constexpr if (C++17) - compile-time branching
template<typename T>
void print(T value) {
    if constexpr (std::is_integral_v<T>) {
        std::cout << "integer: " << value << "\n";
    } else if constexpr (std::is_floating_point_v<T>) {
        std::cout << "float: " << value << "\n";
    } else {
        std::cout << "other: " << value << "\n";
    }
}
```

**Warning for Go developers:** C++ if conditions can use any expression that converts to `bool`. Integers are truthy if non-zero. This means `if (x = 5)` (assignment, not comparison) compiles and is always true. Go rejects this because `=` does not return a value. Always use `==` in C++ conditions, and enable compiler warnings (`-Wall -Wextra`) to catch this mistake.

### Switch Statements

**In Go:**

```go
switch day {
case "Monday":
    fmt.Println("Start of week")
case "Friday":
    fmt.Println("Almost weekend")
case "Saturday", "Sunday":
    fmt.Println("Weekend")
default:
    fmt.Println("Midweek")
}
// Go switches do NOT fall through by default
```

**In C++:**

```cpp
// C++ switch works on integral and enum types (not strings!)
switch (day) {
    case 1:
        std::cout << "Monday\n";
        break;  // MUST break or it falls through!
    case 5:
        std::cout << "Friday\n";
        break;
    case 6:
    case 7:                       // stacking cases (like Go's comma list)
        std::cout << "Weekend\n";
        break;
    default:
        std::cout << "Midweek\n";
        break;
}

// WARNING: Without break, execution falls through to next case!
switch (x) {
    case 1:
        doA();
        // no break here: FALLS THROUGH to case 2!
        [[fallthrough]]; // C++17 attribute to mark intentional fallthrough
    case 2:
        doB(); // executes for BOTH x==1 and x==2
        break;
}

// C++17 init statement in switch
switch (auto val = compute(); val) {
    case 0: std::cout << "zero\n"; break;
    case 1: std::cout << "one\n";  break;
    default: std::cout << "other\n"; break;
}
```

**Critical difference:** Go switches do NOT fall through by default (you need explicit `fallthrough`). C++ switches DO fall through by default (you need explicit `break`). This is one of the most common sources of bugs in C++ code.

### Loops: for, while, do-while, range-based for

Go has only `for`. C++ has four loop constructs.

**In Go:**

```go
// Traditional for loop
for i := 0; i < 10; i++ {
    fmt.Println(i)
}

// While-style loop
for condition {
    doWork()
}

// Infinite loop
for {
    if done() { break }
}

// Range loop over collection
nums := []int{1, 2, 3, 4, 5}
for index, value := range nums {
    fmt.Printf("%d: %d\n", index, value)
}

// Range loop, index only
for i := range nums {
    fmt.Println(i)
}
```

**In C++:**

```cpp
// Traditional for loop (identical syntax to Go's)
for (int i = 0; i < 10; i++) {
    std::cout << i << "\n";
}

// While loop (Go uses for - C++ has a dedicated keyword)
while (condition) {
    doWork();
}

// Do-while loop (NO Go equivalent - body executes at least once)
do {
    result = tryOperation();
} while (!result.success);  // condition checked AFTER body

// Infinite loop
while (true) {
    if (done()) break;
}
// or
for (;;) {
    if (done()) break;
}

// Range-based for loop (C++11) - similar to Go's range
std::vector<int> nums = {1, 2, 3, 4, 5};

for (int n : nums) {            // by value (copies each element)
    std::cout << n << "\n";
}

for (const auto& n : nums) {   // by const reference (no copy, read-only)
    std::cout << n << "\n";
}

for (auto& n : nums) {         // by mutable reference
    n *= 2;                     // modifies the vector
}

// C++20 range-based for with initializer
for (auto v = getValues(); const auto& elem : v) {
    std::cout << elem << "\n";
}
```

**The do-while** loop is useful when you need to execute the loop body at least once before checking the condition. This pattern appears in retry logic, menu systems, and input validation. Go developers achieve this with an infinite loop and a break at the bottom, but `do-while` makes the intent clearer.

**No built-in range with index.** Unlike Go's `for i, v := range`, C++ range-based for does not give you an index. You need to either use a traditional for loop, maintain a separate counter, or use `std::views::enumerate` (C++23).

```cpp
// Getting index in C++ range-based for (workarounds)

// Option 1: separate counter
int i = 0;
for (const auto& n : nums) {
    std::cout << i << ": " << n << "\n";
    i++;
}

// Option 2: traditional for loop
for (size_t i = 0; i < nums.size(); i++) {
    std::cout << i << ": " << nums[i] << "\n";
}

// Option 3: C++23 enumerate
// for (auto [i, n] : std::views::enumerate(nums)) {
//     std::cout << i << ": " << n << "\n";
// }
```

---

### Junior → FAANG: Control Flow Gotchas That Bite Go Engineers First

The two most common control flow bugs for Go engineers in C++: falling through switch cases (C++ falls through by default, Go does not), and missing the range-for-loop reference distinction. In Go, `for _, v := range slice` always copies `v`. In C++, `for (auto v : container)` copies, but `for (auto& v : container)` does not. Using value semantics when you intend reference semantics, or vice versa, is a source of both bugs and unnecessary copies.

Practice: rewrite three Go switch statements as C++ switch statements with explicit `break` statements. Then rewrite three Go range loops as C++ range-for loops, choosing value vs. reference correctly for each.

Interview note: if asked to trace through a switch statement with intentional fallthrough, explain that C++ requires `[[fallthrough]]` as an explicit annotation in modern code (C++17), and that falling through without it triggers a warning with `-Wswitch-fallthrough`. This shows awareness of both the language and the tooling.

### Senior @ FAANG: Structured Bindings, Pattern Matching Maturity, and Code Review for Control Flow Complexity

At the staff level, control flow complexity is a code quality metric. Cyclomatic complexity and nesting depth are measurable. High values predict bugs and maintenance difficulty.

**Structured bindings as readability tools.** C++17 structured bindings (`auto [key, value] = *it`) reduce the visual noise of accessing tuple or pair elements. A staff engineer's style guide position on structured bindings: encourage them for pairs and simple structs, discourage them when the binding names are uninformative (`auto [a, b, c]` for a three-element struct is worse than accessing named fields). The goal is readability, not feature adoption.

**`std::visit` as a control flow alternative.** For variant-typed data (discriminated unions), `std::visit` with a visitor replaces chains of `if/else` with a single overload set that the compiler verifies for completeness. A staff engineer introduces this pattern in code reviews when they see a growing `if (holds_alternative<A>)... else if (holds_alternative<B>)...` chain, because `std::visit` makes adding a new variant type a compile-time error rather than a missed branch.

**Complexity budgets in code review.** At L6, you set and enforce a complexity budget: no function exceeds cyclomatic complexity 10, no nesting depth exceeds 4 levels. These are enforced by clang-tidy (`readability-function-cognitive-complexity`). When a PR violates the budget, the review asks for refactoring rather than accepting the complexity. The compounding effect of this policy over 12 months is a codebase where every function fits in a screenful and every branch is obvious.

