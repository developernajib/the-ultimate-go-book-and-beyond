## Exercises

### Exercise 1: Generic MinMax

Write a function template `MinMax` that takes a `std::vector<T>` and returns a `std::pair<T, T>` containing the minimum and maximum values. Constrain it (using concepts or `enable_if`) so it only works with types that support `<`.

**Bonus:** Make it work with empty vectors by returning `std::optional<std::pair<T, T>>`.

### Exercise 2: Tuple Printer

Write a variadic template function `PrintTuple` that takes a `std::tuple` and prints each element separated by commas. Use `std::index_sequence` and fold expressions.

```cpp
auto t = std::make_tuple(1, "hello", 3.14, 'x');
PrintTuple(t);  // Output: 1, hello, 3.14, x
```

### Exercise 3: CRTP Logging Mixin

Create a CRTP mixin `Loggable<Derived>` that adds `LogInfo()`, `LogWarning()`, and `LogError()` methods. Each method should print the class name (obtained from `Derived::ClassName()` which the derived class must implement) along with the message and severity level.

### Exercise 4: Type-Safe Unit System

Extend the dimensional analysis example to support:
- Conversion between units (e.g., meters to kilometers)
- Named unit printing (e.g., `std::cout << force` prints `"750.0 N"`)
- Compile-time validation that prevents adding incompatible units

### Exercise 5: Concept-Constrained Container Adaptor

Write a class template `SortedContainer<T, Container>` where:
- `T` must satisfy `std::totally_ordered`
- `Container` must satisfy a custom `InsertableContainer` concept (has `push_back`, `begin`, `end`, `size`)
- Elements are automatically kept in sorted order
- Provide `Insert`, `Contains`, `Remove`, and range-for support

### Exercise 6: Compile-Time String Hashing

Write a `constexpr` function that computes a hash of a string literal at compile time. Then write a template that maps string hashes to types, enabling a compile-time string-to-type registry.

### Exercise 7: Policy-Based Smart Pointer

Design a smart pointer with these policy parameters:
- **Ownership policy:** unique, shared, or intrusive reference counting
- **Checking policy:** no check, null check on dereference, or checked access with logging
- **Threading policy:** single-threaded or multi-threaded (atomic reference count)

Implement at least two variations of each policy.

### Exercise 8: Variadic Tuple Transform

Write a function template `TransformAll` that takes a tuple and a callable, applies the callable to each element, and returns a new tuple with the results. Handle elements of different types correctly.

```cpp
auto input = std::make_tuple(1, 2.5, std::string("hello"));
auto output = TransformAll(input, [](auto x) {
    if constexpr (std::is_arithmetic_v<decltype(x)>) {
        return x * 2;
    } else {
        return x + x;  // string concatenation
    }
});
// output == std::tuple(2, 5.0, "hellohello")
```

---

### Junior → FAANG: Template Exercises as Compiler Error Reading Practice

Template exercises are unique because the most important skill they build is reading compiler error messages, not just writing code. When a template constraint is violated, the error message (especially with concepts) tells you exactly which requirement was not met. Without concepts, SFINAE errors can span hundreds of lines.

Practice: write each exercise first without concepts (using plain templates), read the error when you pass an incorrect type, then add concept constraints and compare the error messages. The improvement in diagnostic quality motivates the concepts adoption.

### Senior @ FAANG: Template Exercise Results as Hiring Calibration

At the L6 level, template exercises calibrate senior candidates accurately. The CRTP exercise specifically separates L5 from L6: an L5 candidate implements CRTP correctly with a worked example. An L6 candidate additionally discusses: when CRTP's zero-overhead dispatch is measurably better than virtual dispatch (tight loops, devirtualization failure), when CRTP's compile-time coupling makes the codebase harder to maintain than virtual dispatch, and how concepts constrain CRTP base classes to prevent misuse. This three-dimensional answer is the L6 signal.

