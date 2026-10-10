## Value Categories: The Foundation

Every expression in C++ has two independent properties: a **type** (like `int` or `std::string`) and a **value category**. The value category determines whether an expression can appear on the left side of an assignment, whether it can be moved from, and how it binds to references. Understanding value categories is prerequisite to understanding move semantics.

### The C++11 Value Category Taxonomy

C++11 reorganized value categories into a taxonomy with five categories arranged in a tree:

```
        expression
       /          \
    glvalue      rvalue
    /    \       /    \
 lvalue  xvalue     prvalue
```

Every expression is exactly one of: **lvalue**, **xvalue**, or **prvalue**. The categories **glvalue** and **rvalue** are unions: a glvalue is either an lvalue or xvalue, and an rvalue is either an xvalue or prvalue.

Two fundamental properties distinguish them:

1. **Has identity**: The expression refers to an object with a memory address you can take. You can compare addresses of two identity-bearing expressions.
2. **Can be moved from**: The expression's resources can be stolen because no one else needs the object afterward.

| Category | Has identity | Can be moved from | Examples |
|----------|:---:|:---:|---------|
| lvalue   | Yes | No  | Variables, function calls returning `T&` |
| xvalue   | Yes | Yes | `std::move(x)`, function calls returning `T&&` |
| prvalue  | No  | Yes | Literals, function calls returning `T` |
| glvalue  | Yes | -   | Union of lvalue and xvalue |
| rvalue   | -   | Yes | Union of xvalue and prvalue |

### Lvalues: Things With Names and Addresses

An lvalue ("left value", historically because it can appear on the left side of assignment) is an expression that refers to a persistent object. You can take its address with `&`.

```cpp
#include <iostream>
#include <string>

int global = 42;

int& get_ref() {
    return global;
}

int main() {
    int x = 10;                  // 'x' is an lvalue
    std::string name = "Alice";  // 'name' is an lvalue
    int* ptr = &x;               // '&x' is valid - x has identity

    // Function calls returning lvalue references produce lvalues
    get_ref() = 100;             // 'get_ref()' is an lvalue
    std::cout << global << "\n"; // prints 100

    // String subscript returns lvalue reference
    name[0] = 'B';              // 'name[0]' is an lvalue
    std::cout << name << "\n";  // prints "Blice"

    // Dereferencing a pointer produces an lvalue
    *ptr = 20;                  // '*ptr' is an lvalue
    std::cout << x << "\n";    // prints 20

    // Array elements are lvalues
    int arr[3] = {1, 2, 3};
    arr[1] = 42;                // 'arr[1]' is an lvalue

    return 0;
}
```

Key rule: **Lvalues bind to lvalue references (`T&`) but not to rvalue references (`T&&`)**.

### Prvalues: Pure Temporaries

A prvalue ("pure rvalue") is a temporary that has no identity. It is the result of a computation that does not persist in a named variable. You cannot take its address.

```cpp
#include <iostream>
#include <string>

std::string make_greeting(const std::string& name) {
    return "Hello, " + name;  // return value is a prvalue
}

int main() {
    // Literals are prvalues
    // &42;           // ERROR: cannot take address of literal
    // &3.14;         // ERROR: same
    // &true;         // ERROR: same

    // Arithmetic results are prvalues
    int x = 5, y = 10;
    // &(x + y);      // ERROR: cannot take address of temporary

    // Function calls returning by value produce prvalues
    std::string greeting = make_greeting("World");
    // &make_greeting("World"); // ERROR: cannot take address

    // Casts to non-reference types produce prvalues
    double d = 3.14;
    // &(static_cast<int>(d));  // ERROR

    // Lambda expressions are prvalues
    auto fn = []{ return 42; };  // the lambda itself is a prvalue
                                  // 'fn' (the variable) is an lvalue

    std::cout << greeting << "\n";
    return 0;
}
```

Key rule: **Prvalues bind to rvalue references (`T&&`) and to `const` lvalue references (`const T&`), but not to non-const lvalue references (`T&`)**.

The ability to bind to `const T&` is why pre-C++11 code could pass temporaries to functions taking `const T&`. This was the only way to extend the lifetime of a temporary.

### Xvalues: Expiring Values

An xvalue ("expiring value") is the trickiest category. It has identity (it refers to a real object with an address) but has been explicitly marked as safe to move from. The canonical way to create an xvalue is `std::move`:

```cpp
#include <iostream>
#include <string>
#include <utility>

int main() {
    std::string original = "This is a long string that causes heap allocation";

    // std::move does NOT move anything. It casts 'original' to an xvalue.
    // 'std::move(original)' is an xvalue - it has identity (it still refers
    // to the same object as 'original') but signals it can be moved from.
    std::string stolen = std::move(original);

    // After the move, 'original' is in a valid but unspecified state.
    // For std::string, it is guaranteed to be empty.
    std::cout << "stolen: " << stolen << "\n";
    std::cout << "original: '" << original << "'\n";
    std::cout << "original.size(): " << original.size() << "\n";

    // Other xvalue examples:
    // - Function returning T&&
    // - std::move(x)
    // - static_cast<T&&>(x)
    // - a member access on an rvalue: std::move(obj).member

    return 0;
}
```

Output:
```
stolen: This is a long string that causes heap allocation
original: ''
original.size(): 0
```

### Glvalues and Rvalues: The Union Categories

**glvalue** (generalized lvalue) = lvalue or xvalue. Anything with identity. You can take its address, you can refer to it through a reference, and it occupies memory.

**rvalue** = xvalue or prvalue. Anything that can be moved from. This is the category that binds to `T&&`.

```cpp
#include <string>
#include <utility>

void takes_lvalue_ref(std::string& s)        { /* binds lvalues */ }
void takes_const_ref(const std::string& s)   { /* binds anything */ }
void takes_rvalue_ref(std::string&& s)       { /* binds rvalues */ }

int main() {
    std::string name = "Alice";

    // Lvalue: binds to T& and const T&
    takes_lvalue_ref(name);           // OK: lvalue
    takes_const_ref(name);            // OK: lvalue binds to const&
    // takes_rvalue_ref(name);        // ERROR: lvalue cannot bind to T&&

    // Prvalue: binds to T&& and const T&
    // takes_lvalue_ref(std::string("Bob")); // ERROR: prvalue cannot bind to T&
    takes_const_ref(std::string("Bob"));     // OK: prvalue binds to const&
    takes_rvalue_ref(std::string("Bob"));    // OK: prvalue binds to T&&

    // Xvalue: binds to T&& and const T&
    // takes_lvalue_ref(std::move(name));    // ERROR: xvalue cannot bind to T&
    takes_const_ref(std::move(name));        // OK: xvalue binds to const&
    takes_rvalue_ref(std::move(name));       // OK: xvalue binds to T&&

    return 0;
}
```

### Determining Value Category at Compile Time

You can use `decltype` to inspect value categories. The rules are:

- If the expression is an lvalue, `decltype` yields `T&`
- If the expression is an xvalue, `decltype` yields `T&&`
- If the expression is a prvalue, `decltype` yields `T`

```cpp
#include <iostream>
#include <string>
#include <type_traits>
#include <utility>

template<typename T>
constexpr const char* category() {
    if constexpr (std::is_lvalue_reference_v<T>)
        return "lvalue";
    else if constexpr (std::is_rvalue_reference_v<T>)
        return "xvalue";
    else
        return "prvalue";
}

int main() {
    int x = 42;
    int& ref = x;

    std::cout << "x:              " << category<decltype((x))>() << "\n";
    std::cout << "ref:            " << category<decltype((ref))>() << "\n";
    std::cout << "std::move(x):   " << category<decltype((std::move(x)))>() << "\n";
    std::cout << "42:             " << category<decltype((42))>() << "\n";
    std::cout << "x + 1:          " << category<decltype((x + 1))>() << "\n";

    return 0;
}
```

Output:
```
x:              lvalue
ref:            lvalue
std::move(x):   xvalue
42:             prvalue
x + 1:          prvalue
```

Note the double parentheses `decltype((x))`. Without them, `decltype(x)` gives the declared type of the variable (`int`). With them, `decltype((x))` treats `x` as an expression and gives the value category.

---

### Junior → FAANG: The Three Categories to Internalize First

The full value category taxonomy (lvalue, rvalue, xvalue, glvalue, prvalue) is necessary for understanding the standard, but for daily C++ work, three categories cover 95% of cases: lvalue (has a name, has an address, can be on the left of `=`), prvalue (unnamed temporary, the source of most implicit conversions), and xvalue (named variable cast to rvalue reference via `std::move`).

Practice identifying these in code: in `std::vector<int> v = {1, 2, 3};`, the `{1, 2, 3}` is a prvalue. In `auto&& ref = std::move(v);`, the `std::move(v)` is an xvalue. In `ref.push_back(4);`, `ref` is an lvalue.

Interview pitfall: "is `std::move(x)` an lvalue or an rvalue?" The answer: it is an xvalue (a type of rvalue). But "what does it enable?" is more important: it enables the move constructor to be called instead of the copy constructor.

### Senior @ FAANG: Value Category Precision in Template and API Design

At the staff level, value category precision is required when writing generic code. Template deduction rules, universal references, and perfect forwarding all depend on correct value category reasoning.

**The "forwarding reference" confusion.** `T&&` in a template function is not an rvalue reference. It is a forwarding reference (universal reference in Scott Meyers' terminology). It deduces to `T&` if an lvalue is passed and to `T&&` if an rvalue is passed. This is the mechanism that makes `std::forward` possible. A staff engineer reviewing template code checks that `std::forward` is used (not `std::move`) when forwarding template parameters, because `std::move` unconditionally casts to rvalue, losing the original value category.

**Value category in API documentation.** When designing a function that takes `T&&`, the API documentation must state: "takes ownership, do not use the argument after this call" if the function moves from it. This is the same ownership contract as Go's `io.ReadCloser.Close()`, but C++ has no language-level enforcement. A staff engineer adds this documentation in the function comment and in the team's API style guide as a required annotation for any function that takes ownership via `T&&`.

