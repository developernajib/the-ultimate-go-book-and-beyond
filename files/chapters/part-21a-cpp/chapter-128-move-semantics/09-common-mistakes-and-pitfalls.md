## Common Mistakes and Pitfalls

### Mistake 1: Returning `std::move` From a Function

We covered this above, but it deserves repetition because it is the most common move-related mistake in production code:

```cpp
// WRONG: Prevents NRVO
std::vector<int> get_data() {
    std::vector<int> result = compute();
    return std::move(result);  // Pessimization!
}

// RIGHT: Let the compiler do its job
std::vector<int> get_data() {
    std::vector<int> result = compute();
    return result;  // NRVO or implicit move
}
```

### Mistake 2: Moving Shared Resources

Moving a `shared_ptr` member transfers ownership to the caller and leaves the member as `nullptr`. Any other code that holds a reference to this `Connection` object and later calls a method that uses `socket_` will dereference a null pointer. Return a copy (which increments the reference count) instead of stealing the member.
```cpp
class Connection {
    std::shared_ptr<Socket> socket_;
public:
    // DANGEROUS: Moves the shared_ptr, leaving this object with a null socket.
    // Other code that holds a reference to this Connection may crash.
    std::shared_ptr<Socket> steal_socket() {
        return std::move(socket_);
    }

    // BETTER: Share the socket, or return a copy.
    std::shared_ptr<Socket> get_socket() const {
        return socket_;  // Increments reference count - safe
    }
};
```

### Mistake 3: Forgetting `noexcept`

As covered earlier, omitting `noexcept` from move operations causes `std::vector` (and other containers) to fall back to copying during reallocation. This can be a 100x performance regression.

```cpp
class Widget {
public:
    Widget(Widget&&);           // BAD: missing noexcept
    Widget(Widget&&) noexcept;  // GOOD: vector will use moves
};
```

### Mistake 4: Self-Move Assignment

Without a self-assignment guard, `b = std::move(b)` executes `delete[] data_` and then reads `other.data_`, which points to the same now-freed memory. The `if (this != &other)` check prevents this undefined behavior. Self-move is unusual but legal code and arises naturally when moving elements within a container.
```cpp
class Buffer {
    int* data_;
    size_t size_;
public:
    Buffer& operator=(Buffer&& other) noexcept {
        // Without the self-assignment check, self-move would delete
        // our own data and then read from deleted memory.
        if (this != &other) {
            delete[] data_;
            data_ = other.data_;
            size_ = other.size_;
            other.data_ = nullptr;
            other.size_ = 0;
        }
        return *this;
    }
};

// Self-move can happen with:
Buffer b(100);
b = std::move(b);  // Undefined behavior without the check
```

### Mistake 5: Moving in a Loop

The first `std::move(source)` inside the loop steals `source`'s internal buffer, leaving it valid but unspecified (empty on the major implementations). All subsequent iterations pass an empty string. Since the loop intends to process the same data ten times, a copy (not a move) is the correct operation here.
```cpp
std::string source = "important data";

for (int i = 0; i < 10; ++i) {
    // BUG: After the first iteration, 'source' is empty.
    // All subsequent iterations process an empty string.
    process(std::move(source));
}

// FIX: Copy in the loop, or reassign 'source' each iteration.
for (int i = 0; i < 10; ++i) {
    process(source);  // Copy is intentional here
}
```

### Mistake 6: Assuming Moved-From State

The C++ standard only requires moved-from objects to be in a "valid but unspecified" state, they can be destroyed or assigned to, but all other operations have unspecified results. Standard library types (`unique_ptr`, `shared_ptr`, `string`, containers) additionally guarantee they are left empty or null, but user-defined types have no such obligation unless explicitly documented.
```cpp
// The standard only guarantees "valid but unspecified" for moved-from objects.
// Do NOT assume the object is empty, zeroed, or in any particular state.

std::vector<int> v = {1, 2, 3};
std::vector<int> w = std::move(v);

// These are the ONLY safe operations on moved-from v:
v = {4, 5, 6};       // Assign new value: safe
v.clear();            // Destructive operations: safe (but pointless)
// v[0];              // DANGEROUS: state is unspecified, may be empty

// Exception: The standard library guarantees specific moved-from states for
// some types (unique_ptr is null, shared_ptr is null, string is empty,
// containers are empty). But your own types should not rely on this pattern.
```

---

### Junior → FAANG: The Top Three Pitfalls to Memorize Before Your First C++ PR

These three mistakes appear most frequently in early C++ code from Go engineers: (1) `return std::move(local)` which prevents NRVO, (2) using a moved-from object after the move, (3) capturing a move-only type by value in a lambda that is then copied. Write each mistake in a 5-line example, compile it, observe the behavior (or ASan report), and write the fix next to it. This exercise builds the pattern-matching that prevents these in production.

For mistake 3: `std::unique_ptr` cannot be copied. A lambda that captures `unique_ptr` by value is itself not copyable. If you then try to store that lambda in `std::function` (which requires copyability), you get a compile error. The fix: use `std::move`-capture (`[ptr = std::move(ptr)]`), and store the lambda in `absl::AnyInvocable` or `std::move_only_function` (C++23) instead of `std::function`.

### Senior @ FAANG: Systematic Pitfall Prevention Through Tooling

At the staff level, common mistakes are prevented by tooling, not by individual vigilance.

**Clang-tidy checks for move pitfalls.** `performance-move-const-arg` catches `std::move` on a `const` object. `performance-move-constructor-init` catches initializing members via assignment instead of initializer list (which prevents move construction). `bugprone-use-after-move` catches use of objects after they have been moved from. A staff engineer enables these checks in CI and resolves all existing violations before enabling them as errors.

**Static analysis for moved-from object use.** Clang's Static Analyzer includes a checker for use-after-move bugs. Running it on every PR (not just in nightly analysis) catches this class of bug before it reaches production. The checker reports are integrated into the code review tool so reviewers see the findings inline with the diff.

