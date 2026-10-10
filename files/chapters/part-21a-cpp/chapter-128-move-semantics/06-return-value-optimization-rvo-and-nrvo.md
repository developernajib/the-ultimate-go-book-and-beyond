## Return Value Optimization (RVO and NRVO)

Move semantics improved performance dramatically, but the compiler can do even better: it can **eliminate the copy or move entirely**. This is called **copy elision**, and its most common form is Return Value Optimization.

### RVO: Returning Unnamed Temporaries

When a function returns a prvalue (unnamed temporary) of the same type as the return type, the compiler constructs the object directly in the caller's memory. No copy, no move, no constructor call beyond the initial construction.

```cpp
#include <iostream>

class Heavy {
public:
    Heavy() { std::cout << "  Default constructor\n"; }
    Heavy(const Heavy&) { std::cout << "  Copy constructor\n"; }
    Heavy(Heavy&&) noexcept { std::cout << "  Move constructor\n"; }
    ~Heavy() { std::cout << "  Destructor\n"; }
};

Heavy create_rvo() {
    return Heavy();  // RVO: constructs directly in caller's space
}

int main() {
    std::cout << "--- RVO ---\n";
    Heavy h = create_rvo();
    std::cout << "--- End ---\n";
    return 0;
}
```

Output (with RVO, guaranteed since C++17):
```
--- RVO ---
  Default constructor
--- End ---
  Destructor
```

No copy constructor, no move constructor. The object is constructed exactly once. Since C++17, this is **mandatory**, the compiler is required to elide the copy/move for prvalues. This is not an optimization. It is a language guarantee.

### NRVO: Returning Named Local Variables

Named Return Value Optimization (NRVO) is similar but applies to named local variables:

```cpp
Heavy create_nrvo() {
    Heavy h;          // Named variable
    // ... do work with h ...
    return h;         // NRVO: may construct directly in caller's space
}

int main() {
    std::cout << "--- NRVO ---\n";
    Heavy h = create_nrvo();
    std::cout << "--- End ---\n";
    return 0;
}
```

Output (with NRVO, not guaranteed, but almost always applied):
```
--- NRVO ---
  Default constructor
--- End ---
  Destructor
```

Unlike RVO, NRVO is **not mandatory** even in C++17. It is permitted but not required. In practice, every major compiler (GCC, Clang, MSVC) applies NRVO in straightforward cases.

### When NRVO Fails

NRVO cannot be applied when the compiler cannot determine which local variable will be returned:

```cpp
Heavy create_conditional(bool flag) {
    Heavy a;
    Heavy b;
    if (flag) {
        return a;  // NRVO cannot apply: two possible return objects
    }
    return b;      // Compiler uses implicit move instead
}

Heavy create_different_type() {
    struct Derived : Heavy {};
    Derived d;
    return d;  // Different type: no NRVO, but implicit move applies
}
```

### Implicit Move on Return

When NRVO does not apply, C++ still tries to help. If the return expression is a local variable or parameter, the compiler treats it as an rvalue for overload resolution purposes. This means the move constructor is called, not the copy constructor.

```cpp
// Even without NRVO, this calls the MOVE constructor, not copy:
Heavy create_no_nrvo(bool flag) {
    Heavy a;
    Heavy b;
    return flag ? a : b;  // Implicit move (C++11 and later)
}
```

### Why `std::move` on Return Is Almost Always Wrong

Applying `std::move` to a returned local variable explicitly produces an rvalue reference, which prevents the compiler from applying NRVO. The function then pays the cost of a move constructor instead of the zero-cost copy elision NRVO would have provided. Simply writing `return h` lets the compiler construct the object directly in the caller's stack frame.
```cpp
Heavy bad_return() {
    Heavy h;
    return std::move(h);  // BAD: disables NRVO, forces move constructor
}

Heavy good_return() {
    Heavy h;
    return h;             // GOOD: NRVO eliminates copy/move entirely,
                          //       or implicit move kicks in as fallback
}
```

The only case where `std::move` on return is correct is when you are returning a member variable or a variable whose type differs from the return type:

```cpp
class Container {
    std::vector<int> data_;
public:
    // Moving a member out - std::move IS correct here
    std::vector<int> take_data() {
        return std::move(data_);  // Correct: member, not local variable
    }
};
```

---

### Junior → FAANG: Trusting the Compiler on RVO

The single most important rule for Go engineers learning C++ return semantics: return local objects by value and trust the compiler to apply RVO/NRVO. Do not return by pointer to avoid copies, and do not add `std::move` to return statements (both prevent RVO). Modern compilers with C++17 mandatory copy elision eliminate the copy for prvalue returns with zero overhead.

The exception: NRVO is not guaranteed. If a function has two different return paths that return different named objects, NRVO may not apply, but the compiler will automatically fall back to an implicit move, so manual `std::move` remains unnecessary. If there is only one return path with one named object, NRVO eliminates even the move.

Interview note: "what is NRVO and when does it not apply?" Common cases where NRVO fails: returning different named variables on different code paths, returning a variable that is a function parameter (parameters are constructed by the caller, not in the local frame), and returning a global or static variable.

### Senior @ FAANG: RVO, NRVO, and API Design for Zero-Copy Returns

At the staff level, RVO and NRVO interact with API design in ways that require deliberate choices.

**Output parameters vs. return by value.** Pre-C++11 C++ APIs often used output parameters (`void fn(T* out)`) to avoid copies. With C++11 move semantics and C++17 mandatory copy elision, this pattern is obsolete for most uses. A staff engineer migrates output parameter APIs to return-by-value when the returned type supports efficient move, and documents the change as a readability improvement with no performance regression.

**`std::optional` and RVO.** `std::optional<T>` is a return type that communicates "may not have a value" without separate error types. With C++17, returning `std::optional<T>{value}` benefits from mandatory copy elision. A staff engineer designs APIs that fail or succeed to return `std::optional<T>` rather than using out-parameters or sentinel values, which improves readability and keeps value management automatic.

**Benchmark before and after.** Any claim that "avoiding RVO prevents a copy and improves performance" must be validated with a benchmark. In practice, compilers apply RVO aggressively and the "prevented copy" is often already eliminated. A staff engineer requires a benchmark demonstrating the actual copy in the baseline before accepting code that adds complexity to avoid it.

