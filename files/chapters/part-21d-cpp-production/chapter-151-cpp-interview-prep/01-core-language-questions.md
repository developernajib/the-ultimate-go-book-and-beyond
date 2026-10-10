## Core Language Questions

These 25 questions appear repeatedly across every FAANG C++ interview. Short answers disqualify candidates, the interviewer is testing whether you understand the mechanism, not whether you can recite the definition. Each answer here goes to the depth expected at a senior engineer level.

---

### Q1. What is undefined behavior? Give three examples.

Undefined behavior (UB) means the C++ standard places no requirements on what the program does. The compiler is free to assume UB never occurs, which means it can and does optimize code in ways that eliminate, reorder, or corrupt logic around UB.

**Example 1, Signed integer overflow:**
```cpp
int x = INT_MAX;
int y = x + 1;  // UB: signed overflow
// Compiler may assume x + 1 > x is always true, eliminating overflow checks
```

**Example 2, Dereferencing a null pointer:**
```cpp
int* p = nullptr;
int val = *p;  // UB: null dereference
// The compiler may hoist code past this assuming p is never null
```

**Example 3, Use after free:**
```cpp
int* p = new int(42);
delete p;
int val = *p;  // UB: accessing freed memory
// May work "by accident" until the allocator reuses that memory
```

The key insight: UB is not a runtime error that crashes your program, it is a compile-time contract violation that can corrupt your program in any way, including appearing to work correctly until production load exposes it.

---

### Q2. What is the difference between `const int*`, `int* const`, and `const int* const`?

Read the declaration right-to-left, inserting "pointer to" when you hit `*`:

```cpp
const int* p;       // pointer to const int, the int cannot be modified through p
                    // p itself can be reseated to point elsewhere

int* const p;       // const pointer to int, p cannot be reseated
                    // the int CAN be modified through p

const int* const p; // const pointer to const int, neither p nor *p can be changed
```

```cpp
int a = 10, b = 20;

const int* p1 = &a;
// *p1 = 5 - // ERROR: cannot modify through p1
p1 = &b;            // OK: p1 can be reseated

int* const p2 = &a;
*p2 = 5;            // OK: a is now 5
// p2 = &b;         // ERROR: p2 cannot be reseated

const int* const p3 = &a;
// *p3 = 5 - // ERROR
// p3 = &b;         // ERROR
```

In Go terms: `const int*` is roughly equivalent to a pointer to a value you've promised not to mutate. Go has no equivalent of `int* const` because pointers in Go are always re-assignable.

---

### Q3. Explain RAII with a concrete example.

Resource Acquisition Is Initialization means tying a resource's lifetime to a C++ object's lifetime. When the object is constructed, it acquires the resource. When the object is destroyed (its destructor runs), it releases the resource. Because destructors run deterministically, at the end of scope or when `delete` is called, you cannot leak the resource even when exceptions are thrown.

```cpp
#include <fstream>
#include <string>
#include <stdexcept>

class FileReader {
    std::ifstream file_;
public:
    explicit FileReader(const std::string& path) : file_(path) {
        if (!file_.is_open()) {
            throw std::runtime_error("Cannot open: " + path);
        }
    }
    // Destructor closes the file automatically, no explicit cleanup needed
    ~FileReader() = default;  // file_'s destructor does the work

    std::string read_line() {
        std::string line;
        std::getline(file_, line);
        return line;
    }
};

void process() {
    FileReader reader("/etc/hosts");  // file opened here
    auto line = reader.read_line();
    if (line.empty()) throw std::runtime_error("empty file");
    // Even if exception is thrown, reader's destructor closes the file
}   // reader destroyed here, file closed
```

RAII is why `std::unique_ptr`, `std::lock_guard`, and `std::fstream` all work without explicit cleanup calls. Go's `defer` approximates this but runs at function exit rather than scope exit, and does not run on panic across goroutine boundaries without a recover.

---

### Q4. What are lvalues and rvalues? What is an xvalue?

An **lvalue** is an expression that has a persistent identity, you can take its address. Variables, array elements, dereferenced pointers, and function calls returning references are lvalues.

An **rvalue** is an expression whose value is temporary, it is about to be discarded. Literals, arithmetic expressions, and function calls returning non-references are rvalues.

An **xvalue** ("expiring value") is a specific category of rvalue that *has* an identity but *will* be moved from. The result of `std::move(x)` is an xvalue. Xvalues are the key to move semantics: you can bind an rvalue reference to an xvalue, enabling the move constructor to steal its resources.

```cpp
int a = 10;           // a is an lvalue
int b = a + 5;        // (a + 5) is a prvalue (pure rvalue), b is an lvalue
int&& r = std::move(a);  // std::move(a) is an xvalue; r binds to it

void consume(int&& x);
consume(std::move(a));  // std::move(a) is an xvalue, passes ownership intent
```

The full value category taxonomy: every expression is either a glvalue (lvalue or xvalue) or a prvalue. The distinction matters for overload resolution, move semantics, and RVO eligibility.

---

### Q5. When is the copy constructor called vs the move constructor?

The **copy constructor** is called when an object is initialized from an lvalue. The **move constructor** is called when initialized from an rvalue (temporary or `std::move`d value).

```cpp
#include <vector>
#include <string>

std::vector<int> make_vec() { return {1, 2, 3}; }

std::vector<int> v1 = {4, 5, 6};
std::vector<int> v2 = v1;             // copy constructor: v1 is an lvalue
std::vector<int> v3 = std::move(v1); // move constructor: std::move(v1) is xvalue
std::vector<int> v4 = make_vec();     // move constructor (or NRVO, no copy at all)
```

The move constructor is also chosen in:
- Return statements where NRVO cannot apply
- `emplace_back` when a temporary is pushed
- Exception propagation (thrown objects are moved if possible)

When you write a class with dynamic resources and need a move constructor, remember: after the move, the source object must be in a valid but unspecified state, typically null pointers for heap resources.

---

### Q6. What is the Rule of Five? When do you need it?

If a class manages a resource (heap memory, file descriptor, mutex, socket), you must explicitly define all five special member functions, or mark them deleted, because the compiler-generated versions will do the wrong thing:

1. **Destructor**, release the resource
2. **Copy constructor**, deep copy the resource
3. **Copy assignment operator**, release old resource, deep copy new one
4. **Move constructor**, steal the resource, null out the source
5. **Move assignment operator**, release old, steal new, null source

```cpp
class Buffer {
    uint8_t* data_;
    size_t   size_;
public:
    explicit Buffer(size_t n) : data_(new uint8_t[n]), size_(n) {}

    ~Buffer() { delete[] data_; }

    Buffer(const Buffer& o) : data_(new uint8_t[o.size_]), size_(o.size_) {
        std::memcpy(data_, o.data_, size_);
    }

    Buffer& operator=(const Buffer& o) {
        if (this != &o) {
            delete[] data_;
            data_ = new uint8_t[o.size_];
            size_ = o.size_;
            std::memcpy(data_, o.data_, size_);
        }
        return *this;
    }

    Buffer(Buffer&& o) noexcept : data_(o.data_), size_(o.size_) {
        o.data_ = nullptr;
        o.size_ = 0;
    }

    Buffer& operator=(Buffer&& o) noexcept {
        if (this != &o) {
            delete[] data_;
            data_ = o.data_;
            size_ = o.size_;
            o.data_ = nullptr;
            o.size_ = 0;
        }
        return *this;
    }
};
```

Classes that use only RAII members (`std::unique_ptr`, `std::vector`, etc.) typically need zero of the five, the compiler-generated ones delegate correctly. The Rule of Five only applies when you hold a raw resource.

---

### Q7. What does `explicit` do on a constructor?

`explicit` prevents the constructor from being used for implicit conversions. Without it, single-argument constructors act as implicit conversion operators, which can cause subtle bugs.

```cpp
class Widget {
public:
    Widget(int size);         // implicit: Widget w = 42; compiles
    explicit Widget(int size); // explicit: Widget w = 42; is an ERROR
                               //           Widget w(42);   is OK
                               //           Widget w{42} - is OK
};

void process(Widget w);

process(42);       // compiles if constructor is not explicit, dangerous
process(Widget{42}); // always clear and intentional
```

`explicit` should be the default for any constructor callable with a single argument unless you explicitly intend conversion semantics (e.g., `std::string` from `const char*` is intentionally implicit). C++11 extended `explicit` to conversion operators as well.

---

### Q8. What is virtual dispatch? How does the vtable work?

Virtual dispatch allows a call through a base-class pointer or reference to invoke the correct derived-class method at runtime.

When a class has any virtual function, the compiler creates a **vtable** (virtual function table): a static array of function pointers, one per virtual function. Each instance of that class contains a hidden `__vptr` pointer to its class's vtable.

```
Layout of a Derived object:
+----------+
| __vptr   |  → Derived::vtable → [&Derived::foo, &Derived::bar, ...]
+----------+
| base data|
+----------+
| derived  |
| data     |
+----------+
```

```cpp
struct Base {
    virtual void foo() { std::cout << "Base::foo\n"; }
    virtual ~Base() = default;
};

struct Derived : Base {
    void foo() override { std::cout << "Derived::foo\n"; }
};

Base* p = new Derived();
p->foo();  // loads p->__vptr, indexes into vtable, calls Derived::foo
```

The cost of virtual dispatch is: one extra pointer dereference for `__vptr`, one load of the function pointer from the vtable, and an indirect call. More importantly, it prevents inlining and can cause instruction cache misses when many different derived types are called through the same virtual pointer. This is why hot paths in game engines and trading systems often replace virtual dispatch with static polymorphism (CRTP) or type erasure.

---

### Q9. What is object slicing and how do you prevent it?

Object slicing occurs when a derived-class object is assigned or passed by value to a base-class variable. The derived portion is silently discarded.

```cpp
struct Animal {
    std::string name;
    virtual std::string sound() const { return "..."; }
};

struct Dog : Animal {
    std::string breed;
    std::string sound() const override { return "Woof"; }
};

Dog rex;
rex.name  = "Rex";
rex.breed = "Labrador";

Animal a = rex;  // SLICING: breed is gone, sound() now calls Animal::sound()
a.sound();       // returns "..." not "Woof"
```

Prevention:
1. **Pass and store polymorphic objects by pointer or reference**, never by value.
2. **Mark base class copy constructor and assignment `= delete`** if the class is meant to be used polymorphically.
3. **Use `std::unique_ptr<Base>`** in containers instead of `std::vector<Base>`.

```cpp
// Safe polymorphic container
std::vector<std::unique_ptr<Animal>> animals;
animals.push_back(std::make_unique<Dog>());
animals[0]->sound();  // "Woof", no slicing
```

---

### Q10. What is `std::move`? Does it actually move anything?

`std::move` does **not** move anything. It is a cast, it converts an lvalue expression to an rvalue reference, which enables the compiler to select move overloads instead of copy overloads.

```cpp
#include <utility>
#include <vector>

// std::move implementation (simplified):
template<typename T>
std::remove_reference_t<T>&& move(T&& t) noexcept {
    return static_cast<std::remove_reference_t<T>&&>(t);
}
```

The actual moving happens in the move constructor or move assignment operator that is called as a result. If a type has no move constructor (or if it is marked `noexcept(false)` in some contexts), `std::move` will silently fall back to a copy.

```cpp
std::vector<int> a = {1, 2, 3, 4, 5};
std::vector<int> b = std::move(a);
// a is now empty (moved-from state: valid but unspecified)
// b owns the data
// No heap allocation happened, the internal pointer was transferred
```

A critical interview point: calling `std::move` on a `const` object does nothing useful, because a `const T&&` will bind the copy constructor, not the move constructor (which takes `T&&`).

---

### Q11. What is perfect forwarding? What problem does it solve?

Perfect forwarding preserves the value category (lvalue vs rvalue) of arguments when passing them through a generic function. Without it, every argument becomes an lvalue inside the wrapper.

```cpp
#include <utility>

// Without perfect forwarding, always copies
template<typename T, typename Arg>
T* create_bad(Arg arg) {
    return new T(arg);  // arg is always an lvalue here
}

// With perfect forwarding
template<typename T, typename... Args>
T* create(Args&&... args) {
    return new T(std::forward<Args>(args)...);  // preserves lvalue/rvalue nature
}

std::string s = "hello";
auto* p1 = create<std::string>(s);            // copy constructor called (s is lvalue)
auto* p2 = create<std::string>(std::move(s)); // move constructor called (rvalue)
```

`std::forward<T>(arg)` is a conditional cast: if `T` was deduced as an lvalue reference, it casts to lvalue reference. If `T` was deduced as a non-reference, it casts to rvalue reference. This is why universal references (`T&&` in a template) and `std::forward` always appear together. `emplace_back`, `make_unique`, and `make_shared` all use this pattern.

---

### Q12. What is `constexpr`? What is `consteval`?

`constexpr` marks a function or variable as potentially evaluable at compile time. It can also be evaluated at runtime if called with non-constant arguments.

`consteval` (C++20) marks a function as *always* evaluated at compile time. Calling it with a runtime value is a compile error.

```cpp
constexpr int square(int x) { return x * x; }

constexpr int a = square(5);   // computed at compile time: a = 25
int b = 3;
int c = square(b);             // computed at runtime (b is not constexpr)

consteval int cube(int x) { return x * x * x; }

constexpr int d = cube(4);    // OK: 4 is a compile-time constant
int e = 5;
// int f = cube(e);            // ERROR: cube requires compile-time argument
```

`constexpr` functions in C++14+ can contain loops, local variables, and most control flow. C++20 relaxed this further to allow `try`/`catch` and `constexpr` dynamic allocation. Use `constexpr` for lookup tables, hash functions, string parsing, and any computation that can be done once at compile time to eliminate runtime overhead.

---

### Q13. What is `std::optional`? When would you use it over a pointer?

`std::optional<T>` is a value wrapper that either contains a `T` or is empty. It makes the "no value" case explicit in the type system without heap allocation.

```cpp
#include <optional>
#include <string>

std::optional<std::string> find_user(int id) {
    if (id == 42) return std::string("Alice");
    return std::nullopt;
}

auto user = find_user(99);
if (user.has_value()) {
    std::cout << *user << "\n";
}

// Or with value_or:
std::cout << find_user(99).value_or("unknown") << "\n";
```

**Use `optional` over a pointer when:**
- The value is a value type (not polymorphic), so a pointer would require heap allocation
- You want to express "absent" semantics without raw nullable pointers
- The contained type is small (optional has no heap overhead, value is stored inline)

**Use a pointer when:**
- You need polymorphism
- The object is large and already heap-allocated
- You need shared ownership

In Go, the closest equivalent is returning `(T, bool)` or `(T, error)`. `optional` is cleaner when the absence is a normal case (not an error).

---

### Q14. What is structured binding (C++17)?

Structured bindings let you decompose a struct, pair, tuple, or array into named variables in one declaration.

```cpp
#include <map>
#include <tuple>

// Pair decomposition
std::pair<int, std::string> p = {42, "hello"};
auto [id, name] = p;  // id = 42, name = "hello"

// Map iteration
std::map<std::string, int> scores = {{"alice", 95}, {"bob", 87}};
for (auto& [key, value] : scores) {
    std::cout << key << ": " << value << "\n";
}

// Tuple decomposition
auto [x, y, z] = std::make_tuple(1.0, 2.0, 3.0);

// Struct decomposition (aggregate types)
struct Point { int x, y; };
Point pt{3, 4};
auto [px, py] = pt;
```

Structured bindings are implemented via `std::tuple_size`, `std::tuple_element`, and `get<N>()`, you can make your own types support them by specializing these templates. In Go, multiple return values serve a similar purpose, but they cannot be captured by a single declaration that names each element.

---

### Q15. What is `if constexpr` and when is it useful?

`if constexpr` evaluates the condition at compile time and discards the branch that is false, including its syntax checking in most contexts. This is the primary tool for compile-time branching in templates.

```cpp
#include <type_traits>
#include <string>

template<typename T>
std::string to_string(T val) {
    if constexpr (std::is_integral_v<T>) {
        return std::to_string(val);
    } else if constexpr (std::is_floating_point_v<T>) {
        return std::to_string(val);
    } else {
        // This branch is only instantiated for non-numeric T
        return std::string(val);  // would not compile for int, and that's fine
    }
}
```

Without `if constexpr`, you would need SFINAE or explicit template specialization to achieve the same effect. `if constexpr` is cleaner and easier to read. The key difference from `#ifdef`: `if constexpr` branches must still be syntactically valid, only template-dependent expressions that cannot be checked until instantiation are allowed to "not compile" in the dead branch.

---

### Q16. What is ADL (Argument-Dependent Lookup)?

ADL (also called Koenig lookup) is a rule that extends name lookup to include the namespaces of a function call's arguments. It is why `operator<<` and `swap` work without explicit namespace qualification.

```cpp
namespace geometry {
    struct Point { double x, y; };
    void print(const Point& p) { /* ... */ }
    void swap(Point& a, Point& b) { /* ... */ }
}

geometry::Point p1{1.0, 2.0}, p2{3.0, 4.0};
print(p1);   // ADL finds geometry::print because p1 is in geometry namespace
swap(p1, p2); // ADL finds geometry::swap, critical for std::sort and algorithms
```

ADL is why you write `using std::swap; swap(a, b);` in generic code rather than `std::swap(a, b)`, the `using` declaration puts `std::swap` in scope as a fallback, and ADL will prefer a custom `swap` in the argument's namespace if one exists.

The interview trap: ADL can cause unexpected functions to be found. Always understand what namespaces your argument types live in.

---

### Q17. What is the difference between `override` and `final`?

`override` tells the compiler that a virtual function is intended to override a base-class virtual function. If no such base function exists (wrong signature, spelling mistake), the compiler errors.

`final` prevents further overriding of that virtual function in derived classes. On a class, it prevents the class from being derived from at all.

```cpp
struct Base {
    virtual void process(int x);
    virtual void render();
};

struct Derived : Base {
    void process(int x) override;   // OK: matches Base::process
    // void process(float x) override; // ERROR: no such base function

    void render() final;  // no further class can override render()
};

struct Concrete final : Derived {  // no class can inherit from Concrete
    // void render() override;  // ERROR: render is final in Derived
};
```

Both keywords also enable **devirtualization**: when the compiler can prove at compile time which function will be called, it replaces the virtual dispatch with a direct call (or even inlines it). This is a meaningful performance win in tight loops.

---

### Q18. What is `[[nodiscard]]`?

`[[nodiscard]]` is an attribute that causes the compiler to warn if the return value of a function is discarded without being used. It is essential for functions where ignoring the return value is almost certainly a bug.

```cpp
[[nodiscard]] int open_file(const char* path);
[[nodiscard]] bool try_lock();

[[nodiscard("error must be handled")]] std::error_code write(const void* buf, size_t n);

open_file("/etc/hosts");  // WARNING: discarding nodiscard return value
bool locked = try_lock(); // OK
```

C++20 added a reason string to the attribute. Common uses: error codes, `[[nodiscard]]` on `empty()` (which many beginners call instead of `clear()`), and factory functions that return owning pointers.

The `[[nodiscard]]` attribute can also be applied to a class or struct, any function returning that type triggers the warning.

---

### Q19. What are `std::byte` and `std::span`?

**`std::byte`** (C++17) is a type for representing raw memory. Unlike `char` or `unsigned char`, it has no arithmetic operations, you cannot accidentally do math on raw bytes. It signals intent: "this is memory, not a character or integer."

```cpp
#include <cstddef>
std::byte buf[64];
buf[0] = std::byte{0xFF};
auto val = std::to_integer<int>(buf[0]);  // explicit conversion required
```

**`std::span<T>`** (C++20) is a non-owning view over a contiguous sequence of `T`. It replaces the `(pointer, length)` pair convention with a type-safe abstraction.

```cpp
#include <span>
#include <vector>

void process(std::span<const int> data) {
    for (int x : data) { /* ... */ }
}

std::vector<int> v = {1, 2, 3, 4};
process(v);              // vector → span: automatic
process({v.data(), 2});  // only first 2 elements

int arr[4] = {5, 6, 7, 8};
process(arr);            // C array → span: automatic
```

`std::span` is the C++ equivalent of Go's slices in their role as function parameter types: you pass a view, not a copy. Unlike Go slices, `std::span` does not own memory and cannot grow.

---

### Q20. When does copy elision (NRVO) occur?

**NRVO** (Named Return Value Optimization) eliminates the copy/move when a function returns a named local variable. The compiler constructs the return value directly in the caller's storage.

```cpp
std::vector<int> make_data() {
    std::vector<int> result;  // NRVO candidate: named local
    result.reserve(1000);
    for (int i = 0; i < 1000; ++i) result.push_back(i);
    return result;            // no copy or move, constructed in caller's location
}

auto data = make_data();  // zero copies
```

NRVO is **mandatory** in C++17 for prvalue returns (RVO). NRVO for named variables is optional (the standard permits but does not require it), but all major compilers (GCC, Clang, MSVC) perform it in release builds.

NRVO does not apply when:
- There are multiple return points returning different variables
- The return variable's address is taken
- Exception handling complicates the analysis

The practical rule: return local values by value. Trust the compiler. Do not `std::move` a return value, that *disables* NRVO.

---

### Q21. What is the difference between the four C++ casts?

**`static_cast`**, compile-time checked conversion between related types. The default safe cast.
```cpp
double d = 3.7;
int i = static_cast<int>(d);           // truncates to 3
Base* b = static_cast<Base*>(derived); // upcast: always safe
```

**`dynamic_cast`**, runtime-checked downcast through an inheritance hierarchy. Returns `nullptr` for pointer casts or throws `std::bad_cast` for reference casts if the type is wrong. Requires RTTI.
```cpp
Base* b = get_some_object();
Derived* d = dynamic_cast<Derived*>(b);  // null if b is not actually a Derived
if (d) { /* safe to use */ }
```

**`reinterpret_cast`**, bit-level reinterpretation. No safety checks. Only use for hardware interfaces, serialization, or when you truly need to treat memory as a different type.
```cpp
uintptr_t addr = reinterpret_cast<uintptr_t>(ptr);  // pointer → integer
```

**`const_cast`**, adds or removes `const`/`volatile`. Only valid if the underlying object is truly non-const. Casting away const from a genuinely const object is UB.
```cpp
void legacy_api(char* p);
const char* s = "hello";
legacy_api(const_cast<char*>(s));  // risky: only safe if legacy_api does not write
```

The interview rule: if you reach for `reinterpret_cast` or `const_cast`, write a comment explaining exactly why it is safe.

---

### Q22. What is a `friend` function or class?

A `friend` declaration grants another function or class access to the private and protected members of a class, without that function/class being a member.

```cpp
class Matrix {
    double data_[4][4];

    // Grant operator<< access to private data_
    friend std::ostream& operator<<(std::ostream& os, const Matrix& m);

    // Grant MatrixFactory full access
    friend class MatrixFactory;
};

std::ostream& operator<<(std::ostream& os, const Matrix& m) {
    for (int i = 0; i < 4; ++i)
        for (int j = 0; j < 4; ++j)
            os << m.data_[i][j] << " ";  // accesses private data_
    return os;
}
```

`friend` is appropriate for operators that cannot be members (binary operators where the left-hand side is not the class type) and for tightly coupled helper classes (factory, builder, serializer) where accessor functions would add overhead with no encapsulation benefit.

The interview caution: overuse of `friend` is a design smell. If many classes are friends, the class's encapsulation has effectively broken down.

---

### Q23. What is a deleted function (`= delete`)?

`= delete` explicitly prevents a function from being used. Attempting to call it results in a compile-time error with a clear message, rather than a subtle runtime failure.

```cpp
class NonCopyable {
public:
    NonCopyable() = default;
    NonCopyable(const NonCopyable&) = delete;             // no copy
    NonCopyable& operator=(const NonCopyable&) = delete;  // no copy-assign
};

// Can delete any function, not just special members:
void process(int x);
void process(double x) = delete;  // prevents implicit double→int conversion

process(3.14);   // ERROR: process(double) is deleted
process(3);      // OK: calls process(int)
```

Before C++11, the idiom was to declare these functions `private` and not define them. `= delete` is cleaner, produces better error messages, and works for non-member functions and template specializations.

---

### Q24. What is `decltype` and auto return type deduction?

`decltype(expr)` yields the declared type of an expression without evaluating it. It is the compile-time equivalent of "what type does this expression have?"

```cpp
int x = 5;
decltype(x) y = 10;         // y is int
decltype(x + 0.0) z = 1.5; // z is double (int + double → double)

// decltype((x)) is int&, parenthesized variable = lvalue reference
```

**Auto return type deduction** lets the compiler infer the return type from the return statement:

```cpp
auto add(int a, int b) { return a + b; }  // return type is int

// decltype(auto): preserves references (auto would strip them)
int& get_ref(std::vector<int>& v, int i) { return v[i]; }

auto        f1(std::vector<int>& v) { return get_ref(v, 0); }  // returns int (copy)
decltype(auto) f2(std::vector<int>& v) { return get_ref(v, 0); }  // returns int&
```

`decltype(auto)` is critical in generic forwarding wrappers where you need to propagate the exact return type (including reference qualifiers) of the function you are wrapping.

---

### Q25. What is the One Definition Rule (ODR)?

The ODR states that every symbol (variable, function, class, template) must have exactly one definition in the entire program. It has two parts:

1. **Within a translation unit**: no entity may be defined more than once.
2. **Across translation units**: class types, inline functions, and templates may appear in multiple translation units but all definitions must be token-for-token identical.

```cpp
// header.h
inline int square(int x) { return x * x; }  // OK: inline allows multiple defs
                                              // but all must be identical

// In two .cpp files that include header.h:
// Both see square, both definitions are identical → ODR satisfied

// ODR violation (hard to detect, UB):
// file1.cpp: struct Foo { int x; };
// file2.cpp: struct Foo { int x; double y; };  // different definition!
// Linking these is UB, the linker may not catch it
```

ODR violations are among the most insidious bugs in C++: they produce undefined behavior that the linker does not diagnose. Link-time optimization (LTO) and sanitizers like `-fsanitize=undefined` can sometimes expose them. The fix is always to have exactly one definition, typically in a single `.cpp` file, with only a declaration in headers.

---
