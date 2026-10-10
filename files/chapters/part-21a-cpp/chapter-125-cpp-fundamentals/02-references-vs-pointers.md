## References vs Pointers

This is one of the most important conceptual hurdles for Go developers. Go has only pointers. C++ has both pointers and references, and they serve different purposes.

### Pointers in C++ (Familiar Territory)

C++ pointers work almost identically to Go pointers, with one critical difference: C++ pointers support arithmetic.

**In Go:**

```go
func main() {
    x := 42
    p := &x       // p is *int, points to x
    fmt.Println(*p) // dereference: prints 42
    *p = 100
    fmt.Println(x)  // prints 100

    // Go does NOT support pointer arithmetic
    // p++ // COMPILE ERROR
}
```

**In C++:**

```cpp
#include <iostream>

int main() {
    int x = 42;
    int* p = &x;       // p is int*, points to x
    std::cout << *p;    // dereference: prints 42
    *p = 100;
    std::cout << x;     // prints 100

    // C++ DOES support pointer arithmetic
    int arr[5] = {10, 20, 30, 40, 50};
    int* q = arr;       // points to arr[0]
    q++;                // now points to arr[1]
    std::cout << *q;    // prints 20
    q += 2;             // now points to arr[3]
    std::cout << *q;    // prints 40

    // nullptr is the C++ equivalent of Go's nil
    int* null_ptr = nullptr;
    if (null_ptr == nullptr) {
        std::cout << "null pointer\n";
    }

    return 0;
}
```

### References in C++ (No Go Equivalent)

A reference is an alias for an existing variable. It is NOT a separate object in memory. Think of it as a compile-time guarantee that "this name refers to that variable." Once bound, a reference cannot be reseated to refer to something else.

```cpp
#include <iostream>

int main() {
    int x = 42;
    int& ref = x;      // ref IS x (not a copy, not a pointer)

    std::cout << ref;   // prints 42 (no dereferencing needed)
    ref = 100;          // modifies x directly
    std::cout << x;     // prints 100

    // References MUST be initialized
    // int& bad; // COMPILE ERROR: uninitialized reference

    // References CANNOT be null
    // int& bad = nullptr; // COMPILE ERROR

    // References CANNOT be reseated
    int y = 200;
    ref = y;            // This does NOT make ref point to y!
                        // It copies y's value into x.
    std::cout << x;     // prints 200 (x was modified)
    std::cout << &ref;  // same address as &x, NOT &y

    return 0;
}
```

### When to Use References vs Pointers

| Scenario | Use Reference | Use Pointer |
|---|---|---|
| Can be null | No | Yes |
| Can be reseated | No | Yes |
| Function parameter (no null) | `const T&` or `T&` | Not ideal |
| Function parameter (optional) | Not possible | `T*` |
| Ownership transfer | Not possible | `std::unique_ptr<T>` |
| Shared ownership | Not possible | `std::shared_ptr<T>` |
| Container element | Reference wrapper needed | Yes |

### Function Parameters: Go vs C++

This is where references shine. In Go, you pass by value or pass a pointer. In C++, you have more options.

**In Go:**

```go
// Pass by value (copies the struct)
func processValue(s MyStruct) {
    // s is a copy, modifications don't affect caller
}

// Pass by pointer (share the struct)
func processPointer(s *MyStruct) {
    s.Field = 42 // modifies the original
}
```

**In C++:**

```cpp
struct MyStruct {
    int field;
};

// Pass by value (copies the struct - same as Go)
void processValue(MyStruct s) {
    s.field = 42; // modifies copy only
}

// Pass by pointer (same as Go's pointer parameter)
void processPointer(MyStruct* s) {
    if (s == nullptr) return; // must check for null
    s->field = 42;           // -> operator for pointer member access
}

// Pass by reference (C++ exclusive - no null possible)
void processRef(MyStruct& s) {
    s.field = 42; // modifies original, no null check needed
}

// Pass by const reference (read-only access, no copy)
void processConstRef(const MyStruct& s) {
    // s.field = 42; // COMPILE ERROR: s is const
    std::cout << s.field; // OK: reading is allowed
}
```

**The idiomatic C++ rule of thumb:**
- Small types (int, double, bool): pass by value
- Large types you only read: pass by `const T&`
- Large types you modify: pass by `T&`
- Optional parameters: pass by `T*` (pointer, can be null)

In Go, the equivalent decision is simpler: value types by value, large structs by pointer. C++ references eliminate the null-check overhead of pointers while still avoiding copies.

### Rvalue References and Move Semantics (Brief Introduction)

C++11 introduced rvalue references (`T&&`), which enable move semantics. This has no Go equivalent because Go's garbage collector handles object lifetimes.

```cpp
#include <string>
#include <iostream>
#include <utility> // std::move

void takeOwnership(std::string&& s) {
    // s is an rvalue reference: the caller promises they
    // no longer need the original string's data
    std::string local = std::move(s); // "steal" s's internal buffer
    std::cout << local << "\n";
    // s is now in a "moved-from" state (valid but unspecified)
}

int main() {
    std::string greeting = "hello, world";
    takeOwnership(std::move(greeting)); // explicitly transfer ownership
    // greeting is now empty (moved-from)
    std::cout << "After move: '" << greeting << "'\n"; // prints empty
    return 0;
}
```

We will explore move semantics in depth in the chapter on memory management. For now, understand that rvalue references (`&&`) exist to enable efficient transfer of resources without copying.

---

### Junior → FAANG: The Reference vs Pointer Decision Tree

Go engineers are accustomed to a single decision: "do I need a pointer?" C++ has two separate decisions: "do I need indirection?" and "does the binding need to be nullable or rebindable?" The answers determine whether to use a reference or a pointer.

Practical decision tree: use a `const T&` parameter when the function only reads the object and the object is guaranteed to outlive the call. Use a `T*` parameter when the argument is optional (may be null) or when the function stores the pointer for later use. Use a `T&` parameter (non-const) only when the function must mutate the caller's object and the object is guaranteed non-null. Avoid raw owning pointers. Use `unique_ptr` or `shared_ptr` for those.

Interview pitfall: "can a reference be null?" The answer is formally no, but creating a null reference through UB is possible (dereferencing a null pointer to form a reference). The correct answer is that well-formed C++ cannot produce a null reference, but UB can, and any code path that could create one is already broken.

### Senior @ FAANG: Reference Safety in Large Codebases and Code Review Policy

At the staff level, dangling references are one of the top sources of production memory safety bugs in C++ codebases. The policy question is: how does the team prevent dangling references systematically?

**Lifetime annotation conventions.** Google's Abseil uses comment annotations like `// Unowned, must outlive this` to document pointer and reference lifetimes that are not enforced by the type system. A staff engineer defines the convention for their codebase: which lifetime relationships are documented in comments, which are enforced by RAII (and thus self-documenting), and which are candidates for lifetime-annotated smart pointers. The Clang Lifetime Safety profile (part of the C++ Core Guidelines) can enforce some of these automatically.

**Code review checklist for references.** A staff engineer's review of any API that returns references (iterators, `operator[]`, getters) should check: (1) does the returned reference have a shorter lifetime than the object it refers to? (2) does any API that invalidates iterators clearly document which operations cause invalidation? (3) are there any `std::string_view` or `std::span` return values that could be bound to a temporary? Each of these is a class of dangling reference bug. Systematic review catches them before production.

**ASan as the runtime safety net.** For any reference lifetime bug that escapes code review, AddressSanitizer (ASan) catches the use-after-free or stack-use-after-return at runtime in tests. A staff engineer ensures that the CI test suite runs with ASan enabled (at minimum, all unit tests and integration tests) so that dangling references in any code path exercised by tests are caught before deployment.

