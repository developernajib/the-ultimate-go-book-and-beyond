## Interview Questions

### Conceptual Questions

**Q1: What is the difference between an lvalue and an rvalue? Give three examples of each.**

An lvalue is an expression that has identity (a memory address) and persists beyond the expression. Examples: a named variable (`int x`), a dereference (`*ptr`), a subscript (`arr[0]`). An rvalue is an expression that can be moved from, typically a temporary. Examples: a literal (`42`), an arithmetic result (`x + y`), a function call returning by value (`make_string()`). The key binding rule: lvalues bind to `T&`, rvalues bind to `T&&`, and both bind to `const T&`.

**Q2: What does `std::move` actually do? Does it move anything?**

No, `std::move` does not move anything. It is an unconditional cast to an rvalue reference (`T&&`). Specifically, it calls `static_cast<std::remove_reference_t<T>&&>(arg)`. The actual resource transfer happens when the rvalue reference binds to a move constructor or move assignment operator. If the destination does not have a move constructor (or the source is `const`), the copy constructor is called instead and nothing is moved.

**Q3: Why should move constructors be marked `noexcept`? What happens if they are not?**

`std::vector` and other containers provide the strong exception guarantee during reallocation: if an exception is thrown while moving elements to a new buffer, the old buffer must still be valid. If move constructors can throw, the container cannot guarantee this (moved-from elements in the old buffer are in an unspecified state). So the container falls back to copying, which can be restored if an exception occurs. Marking move constructors `noexcept` lets the container safely use moves, which can be orders of magnitude faster.

**Q4: Explain reference collapsing rules. How do they enable perfect forwarding?**

When references are layered, they collapse: `& &` becomes `&`, `& &&` becomes `&`, `&& &` becomes `&`, and `&& &&` becomes `&&`. In a template `void f(T&& arg)`, when an lvalue of type `X` is passed, `T` is deduced as `X&`, making the parameter `X& &&` which collapses to `X&`. When an rvalue is passed, `T` is deduced as `X`, keeping the parameter as `X&&`. `std::forward<T>(arg)` then uses `T` to decide whether to cast to lvalue or rvalue reference, preserving the original value category.

**Q5: What is the difference between RVO and NRVO? Which is guaranteed by the standard?**

RVO (Return Value Optimization) applies when returning an unnamed temporary (prvalue). The compiler constructs the object directly in the caller's memory. Since C++17, this is mandatory. NRVO (Named Return Value Optimization) applies when returning a named local variable. The compiler may construct it directly in the caller's return slot. NRVO is permitted but not mandatory even in C++17. Both avoid copy and move constructors entirely.

### Coding Questions

**Q6: What is wrong with this code?**

```cpp
class Widget {
    std::vector<int> data_;
public:
    std::vector<int> getData() const {
        return std::move(data_);
    }
};
```

**Answer**: Two problems. (1) `data_` is a member variable, not a local variable, so NRVO does not apply, `std::move` is potentially appropriate here but... (2) The function is `const`, so `std::move(data_)` produces a `const std::vector<int>&&`. The move constructor takes `vector<int>&&` (non-const), so overload resolution selects the copy constructor instead. The `std::move` is misleading because it silently copies. Fix: either remove `const` to allow a genuine move, or remove `std::move` to make the copy intentional.

**Q7: Implement a function `make_vector` that constructs a vector from any number of arguments, perfectly forwarding each one.**

```cpp
template<typename T, typename... Args>
std::vector<T> make_vector(Args&&... args) {
    std::vector<T> result;
    result.reserve(sizeof...(args));
    (result.emplace_back(std::forward<Args>(args)), ...);
    return result;  // NRVO
}

// Usage:
std::string name = "Alice";
auto vec = make_vector<std::string>(name, "Bob", std::string("Charlie"));
// name is copied (lvalue), "Bob" is constructed in place, "Charlie" is moved
```

**Q8: What happens when you call `std::move` on a `const std::unique_ptr<T>`? Will this compile?**

```cpp
const std::unique_ptr<int> ptr = std::make_unique<int>(42);
auto other = std::move(ptr);  // Does this compile?
```

**Answer**: This does **not** compile. `std::move(ptr)` produces `const std::unique_ptr<int>&&`. `unique_ptr` has a deleted copy constructor and a move constructor that takes `unique_ptr&&` (non-const). Neither overload matches `const unique_ptr&&`, so the compiler emits an error. This is unlike `std::string` where `const string&&` silently falls back to copy. `unique_ptr` has no copy constructor to fall back to.

**Q9: In a FAANG codebase, you see this pattern. Is it correct?**

```cpp
class EventQueue {
    std::queue<Event> events_;
    std::mutex mutex_;
public:
    void push(Event event) {
        std::lock_guard<std::mutex> lock(mutex_);
        events_.push(std::move(event));
    }
};
```

**Answer**: This is correct and idiomatic. The `push` function takes `Event` by value. If the caller passes an rvalue (`queue.push(Event{...})`), the parameter is move-constructed. If the caller passes an lvalue, the parameter is copy-constructed. Inside the function, the parameter `event` is an lvalue, so `std::move` is needed to move it into the queue. The alternative is two overloads (`const Event&` and `Event&&`), but the by-value approach is simpler and equally efficient (one copy/move to create the parameter, one move into the container). This is the "sink parameter" pattern recommended by Herb Sutter and the C++ Core Guidelines.

**Q10: How would you implement `std::swap` using move semantics?**

```cpp
template<typename T>
void my_swap(T& a, T& b) noexcept(
    std::is_nothrow_move_constructible_v<T> &&
    std::is_nothrow_move_assignable_v<T>
) {
    T temp = std::move(a);   // Move a into temp (a is now empty)
    a = std::move(b);        // Move b into a (b is now empty)
    b = std::move(temp);     // Move temp into b
}
// Total: 3 moves, 0 copies, 0 allocations.
// Pre-C++11: 3 copies, 3 allocations for any type with heap data.
```

---

### Junior → FAANG: Move Semantics Questions as a Complete Study Set

These questions cover every concept in the chapter. Work through them in writing, not just in your head. Written answers reveal gaps that mental answers hide. A complete written answer to "what does `std::move` actually do?" should mention: it is a cast to `T&&`, it does not move anything at runtime, it enables move constructor overload selection, and using a variable after `std::move` leaves it in a valid-but-unspecified state.

### Senior @ FAANG: Move Semantics at the Bar-Raiser Level

At the L6 bar-raiser level, move semantics questions are followed by "how would you enforce correct usage across a 5M LOC codebase?" The expected answer: (1) clang-tidy checks for the common mistakes (move-const-arg, use-after-move), (2) `[[nodiscard]]` on move-only return types, (3) `noexcept` static assertions for hot-path types, (4) a code review policy requiring explicit justification for `std::move` in return statements. This answer demonstrates that the candidate thinks about institutional correctness, not just individual code quality.

