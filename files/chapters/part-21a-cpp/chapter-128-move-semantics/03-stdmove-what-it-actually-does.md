## `std::move`: What It Actually Does

This is the single most misunderstood function in modern C++. **`std::move` does not move anything**. It is a cast. It converts an lvalue into an xvalue (an rvalue reference), which signals to overload resolution that the move constructor or move assignment operator should be selected.

### The Implementation

Here is a simplified implementation of `std::move`:

```cpp
template<typename T>
constexpr std::remove_reference_t<T>&& my_move(T&& t) noexcept {
    return static_cast<std::remove_reference_t<T>&&>(t);
}
```

That is it. It strips any reference from `T`, then casts to `T&&`. No resources are transferred. The actual transfer happens when the resulting rvalue reference binds to a move constructor or move assignment operator parameter.

### Demonstrating That `std::move` Is Just a Cast

Binding `std::move(s)` to `std::string&& ref` performs only the cast, no data is transferred because nothing consumed the rvalue reference. Only when `std::string t(std::move(s))` is called does the move constructor fire, stealing `s`'s internal buffer. After that, `s` is in a valid-but-unspecified state (empty on all major standard library implementations) and `t` holds the original data.
```cpp
#include <iostream>
#include <string>
#include <utility>

int main() {
    std::string s = "Hello, World!";

    // std::move just casts - nothing happens until something binds to it
    std::string&& ref = std::move(s);

    // 's' is still intact because no move constructor was called
    std::cout << "s after std::move but no construction: " << s << "\n";
    std::cout << "ref: " << ref << "\n";

    // NOW construct from the rvalue reference - this triggers the move
    std::string t(std::move(s));
    std::cout << "s after actual move: '" << s << "'\n";
    std::cout << "t: " << t << "\n";

    return 0;
}
```

Output:
```
s after std::move but no construction: Hello, World!
ref: Hello, World!
s after actual move: ''
t: Hello, World!
```

### Common Mistakes With `std::move`

**Mistake 1: Moving from `const` objects**

```cpp
#include <iostream>
#include <string>
#include <utility>

void process(std::string s) {
    std::cout << "Processed: " << s << "\n";
}

int main() {
    const std::string name = "Alice";

    // std::move on a const object produces 'const std::string&&'.
    // There is no move constructor that takes 'const T&&'.
    // Overload resolution falls back to the copy constructor.
    // This compiles but SILENTLY COPIES instead of moving.
    process(std::move(name));  // COPIES, does NOT move

    std::cout << "name is still: " << name << "\n";  // "Alice"
    return 0;
}
```

This compiles without warning on most compilers. The `const` prevents the move constructor (`T&&`) from matching, so the copy constructor (`const T&`) is selected instead. You think you are getting a move, but you are paying for a full copy.

**Mistake 2: Using an object after moving from it**

```cpp
#include <iostream>
#include <vector>
#include <utility>

int main() {
    std::vector<int> data = {1, 2, 3, 4, 5};
    std::vector<int> other = std::move(data);

    // BUG: using 'data' after move. It is in a "valid but unspecified" state.
    // For std::vector, it is guaranteed to be empty after move, but this
    // is a standard library guarantee, not a language guarantee.
    // For user-defined types, the state could be anything valid.

    // This is technically safe for vector (it will be empty), but is bad practice:
    std::cout << "data.size(): " << data.size() << "\n";  // 0, but don't rely on this

    // The ONLY safe operations on a moved-from object are:
    // 1. Destruction
    // 2. Assignment (giving it a new value)
    data = {10, 20, 30};  // Safe: assigning a new value
    std::cout << "data after reassignment: " << data.size() << "\n";

    return 0;
}
```

**Mistake 3: Unnecessary moves (pessimizing moves)**

```cpp
#include <string>
#include <utility>

std::string create_greeting() {
    std::string result = "Hello, World!";
    // DON'T DO THIS - it prevents Return Value Optimization (RVO):
    return std::move(result);  // BAD: prevents NRVO
}

std::string create_greeting_correct() {
    std::string result = "Hello, World!";
    return result;  // GOOD: eligible for NRVO, or implicit move
}

// When the return expression is a local variable of the same type as the
// function return type, the compiler will either:
// 1. Apply NRVO (elide the copy/move entirely), or
// 2. Implicitly treat it as an rvalue (implicit move)
// Using std::move explicitly DISABLES option 1.
```

**Mistake 4: Moving fundamental types**

```cpp
int x = 42;
int y = std::move(x);  // Legal but pointless. 'int' has no move constructor.
                        // This is just a copy. x is still 42.
```

Moving fundamental types (`int`, `double`, `bool`, pointers) is always a copy. There is no optimization to be had because these types have no internal resources to transfer.

---

### Junior → FAANG: The Three Most Common `std::move` Mistakes

The three mistakes Go engineers make most often when learning `std::move`: (1) using `std::move` on a variable that is then used again after the move (moved-from objects are in a valid-but-unspecified state), (2) using `std::move` in a return statement when NRVO would have eliminated the copy entirely (this actually prevents NRVO), (3) using `std::move` on a `const` object (silently degrades to a copy because `const T&&` cannot bind to a move constructor that takes `T&&`).

Concrete drill: write `std::move` in 10 different contexts and trace what actually happens in each. Which ones move, which ones copy, which ones break NRVO?

### Senior @ FAANG: `std::move` in Code Review and `[[nodiscard]]` for Move-Only Returns

At the staff level, incorrect `std::move` usage in code review is a common finding. The most impactful pattern to catch: `return std::move(local_var)` which prevents NRVO and forces a move where no operation was needed. A clang-tidy check (`performance-move-const-arg`, `performance-unnecessary-value-param`) catches some of these automatically.

**`[[nodiscard]]` on move-only return types.** When a function returns a `unique_ptr` or other move-only type, `[[nodiscard]]` ensures the caller does not accidentally discard it (which would immediately destroy the resource). A staff engineer applies `[[nodiscard]]` to all factory functions and any function whose return value represents a resource that must be managed. This makes resource leak bugs compile errors rather than silent runtime bugs.

