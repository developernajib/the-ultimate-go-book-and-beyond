## Interview Deep Dive: Move Semantics

Move-semantics questions appear in roughly half of senior C++ interviews at Google, Meta, and Apple. The questions cluster around five themes: value categories, perfect forwarding, the rule of five, self-move and self-assignment, and what the compiler actually does. Below are detailed walk-throughs of representative questions with the answers a strong candidate gives.

### Q1 (Google): "Walk me through what `std::move(x)` does at the assembly level."

The candidate's answer should hit:

1. `std::move` is a cast. Specifically, `std::move(x)` is `static_cast<std::remove_reference_t<decltype(x)>&&>(x)`.
2. A cast generates no code. It changes the value category from lvalue to xvalue at the type system level.
3. The "moving" happens at the next operation that selects a different overload because the argument is now an xvalue.

A demonstration on godbolt:

```cpp
#include <utility>
#include <string>

void take(std::string s);

void test_move(std::string s) {
    take(std::move(s));
}
```

`-O0` assembly (x86-64, GCC):

```
test_move(std::string):
    sub rsp, 8
    mov rdi, rdi      ; argument already in rdi (the string)
    call take(std::string)
    add rsp, 8
    ret
```

No instruction corresponds to `std::move`. The argument register `rdi` already points to the string. The compiler picked the move constructor for `take`'s parameter because the call-site argument was an xvalue.

If you write `take(s)` instead, the compiler picks the copy constructor (additional allocation) and the assembly grows by the string copy code path.

### Q2 (Meta): "Why does this code copy instead of move?"

```cpp
std::vector<std::string> make_vector() {
    std::vector<std::string> v;
    v.push_back("a");
    return std::move(v);
}
```

Answer: `std::move(v)` defeats NRVO. The returned expression is no longer the name of an automatic local, it is `std::move(v)`. NRVO requires the returned expression to be the local's name.

Without `std::move`, NRVO applies and the local `v` is constructed directly in the caller's storage. No move at all.

With `std::move`, the compiler emits a move construction from `v` into the return slot. One extra move where there should be zero.

Compilers warn: GCC/Clang emit `-Wpessimizing-move`. The fix is to remove the `std::move`:

```cpp
std::vector<std::string> make_vector() {
    std::vector<std::string> v;
    v.push_back("a");
    return v; // NRVO eligible
}
```

### Q3 (Apple): "When is `T&& x` not a forwarding reference?"

The answer must list:

1. When `T` is not deduced (e.g., member function of a class template where `T` is the class's template parameter).
2. When the parameter type is qualified (`const T&&`, `volatile T&&`).
3. When the parameter type is wrapped (`std::vector<T>&&`, `T*&&`).
4. When the function is not a template (`void f(int&& x)`).

Bonus: explain why each case fails. The deduction rules apply only to a `T&&` parameter where `T` is being deduced for that function call. Anything else is a plain rvalue reference.

### Q4 (Google): "Implement a `unique_ptr` move-assign operator. What can go wrong?"

A correct implementation:

```cpp
template <class T>
class unique_ptr {
    T* p_ = nullptr;
public:
    ~unique_ptr() { delete p_; }

    unique_ptr& operator=(unique_ptr&& o) noexcept {
        if (this != &o) {
            delete p_;
            p_ = std::exchange(o.p_, nullptr);
        }
        return *this;
    }
};
```

What can go wrong:

1. Forgetting the self-assignment guard. `p = std::move(p);` would `delete p_` then read `o.p_` which is the same destroyed pointer. UB.
2. Forgetting `noexcept`. Containers fall back to copy on grow.
3. Not nulling the source. The source's destructor would double-free.
4. Forgetting `delete p_`. Leaks the previously owned object.

The bonus discussion: a deleter `D`. If `D` is stateful, the move-assign must move-assign the deleter as well. This adds:

```cpp
unique_ptr& operator=(unique_ptr&& o) noexcept(/* depends on D */) {
    if (this != &o) {
        reset(o.release());
        deleter_ = std::move(o.deleter_);
    }
    return *this;
}
```

Standard `std::unique_ptr<T, D>` does exactly this.

### Q5 (Meta): "What does `decltype((x))` return, and why does it matter?"

`decltype(x)` (no extra parentheses) returns the declared type of `x`.

`decltype((x))` (extra parentheses) treats `(x)` as an expression, not a name. It returns:

- `T&` if `(x)` is an lvalue of type `T`.
- `T&&` if `(x)` is an xvalue.
- `T` if `(x)` is a prvalue.

For a local variable `int x = 0;`:

- `decltype(x)` is `int`.
- `decltype((x))` is `int&`.

This matters in `decltype(auto)` return deduction:

```cpp
decltype(auto) f1(int& x) { return x; }    // returns int& (name of x)
decltype(auto) f2(int& x) { return (x); }  // returns int& ((x) is lvalue)
decltype(auto) f3() { int y = 0; return y; }   // returns int (NRVO, name of local)
decltype(auto) f4() { int y = 0; return (y); } // returns int& -- DANGLING
```

The last case is a dangling reference to a local. The extra parens turned the return into "expression of type int&".

### Q6 (Google): "Write a perfect-forwarding factory function."

```cpp
template <class T, class... Args>
T construct(Args&&... args) {
    return T(std::forward<Args>(args)...);
}
```

Discussion points:

- `Args&&...` is a forwarding reference pack.
- `std::forward<Args>(args)...` expands element-wise. Each `args` is forwarded with its corresponding `Args` deduction.
- The return is by value. With C++17 mandatory elision, the constructed `T` lands in the caller's storage.
- If `T` is move-only and not noexcept-movable, the function still works because of elision.

Pitfalls:

- Forgetting `std::forward`. Lvalue arguments cause a copy in the constructor call.
- Using `std::move(args)...`. Wrong: hijacks lvalue arguments.
- Using `decltype(auto)` return. Useless here because we explicitly construct a `T`.

### Q7 (Apple): "Why is `noexcept` important for move constructors?"

The standard library's `std::vector::reserve`, `std::vector::push_back` past capacity, and other reallocating operations use `std::move_if_noexcept`. If the element's move is noexcept, the operation moves elements to the new buffer. Otherwise it copies.

The reason is the strong exception guarantee. If an element's move could throw partway through reallocation, both buffers would be in inconsistent states (some elements moved, some not, source elements partially destroyed). To preserve the guarantee, vector copies in that case.

For a vector of N strings of size M, the difference is:

- Noexcept move: O(N) pointer swaps. Bytes touched ~ 16N.
- Throwing move: O(N) string copies. Bytes touched ~ NM.

For a million strings of 100 characters, that is ~16 MB versus ~100 MB of memory traffic.

Bonus: `static_assert(std::is_nothrow_move_constructible_v<T>);` next to your hot type prevents a future maintainer from silently making it non-noexcept.

### Q8 (Meta): "Move on a `const` object. What happens?"

```cpp
const std::string s = "hello";
std::string t = std::move(s);
```

`std::move(s)` casts to `const std::string&&`. The overload resolution for `std::string`'s constructors looks for one taking `const std::string&&`. None exists. The next candidate is `std::string(const std::string&)`. This binds because `const std::string&&` converts to `const std::string&`. The result is a copy.

`std::move` on a const object silently degrades to copy. This is by design: const promises immutability, and a move would mutate the source.

The lesson: `std::move(const_object)` is not an error, but it is also not a move. Compiler warnings rarely catch this. Lints sometimes do.

### Q9 (Google): "Detect at compile time whether a type's move is noexcept."

```cpp
static_assert(std::is_nothrow_move_constructible_v<T>);
static_assert(std::is_nothrow_move_assignable_v<T>);
```

Alternative spellings exist (`std::is_nothrow_constructible<T, T&&>`). The two `_v` traits cover the move case.

For overload selection or SFINAE:

```cpp
template <class T>
    requires std::is_nothrow_move_constructible_v<T>
void fast_path(T x);
```

Or with `std::move_if_noexcept`:

```cpp
template <class T>
void grow(T* dst, T* src, std::size_t n) {
    for (std::size_t i = 0; i < n; ++i)
        std::construct_at(dst + i, std::move_if_noexcept(src[i]));
}
```

### 5-Question Rapid Drill

1. What is the value category of `std::move(x)`? Xvalue.
2. Does `T(T(T()))` require `T` to be movable in C++17? No: mandatory elision, single object materialized.
3. Inside `template <class T> void f(T&& x)`, if the caller passes an int lvalue `i`, what is `T`? `int&`.
4. What does `std::forward<T>(x)` do when `T = int&`? Returns `int&` (forwards as lvalue).
5. Why can a move constructor not be virtual? Construction establishes the dynamic type, there is no object to dispatch on yet.

### Common Edge Cases Interviewers Probe

#### Move on a member that is `const`

```cpp
struct S {
    const std::string name;
    S(S&& o) noexcept : name(std::move(o.name)) {} // copy, not move
};
```

`o.name` is const. Move attempt becomes copy.

#### Move-only type in an exception

```cpp
throw std::move(my_unique_ptr); // ill-formed: throw object must be copyable (pre-C++26)
```

C++26 may relax this. Currently, exception objects must be copyable because the exception machinery may copy the object during stack unwinding.

#### Move into a `std::initializer_list`

```cpp
std::vector<std::unique_ptr<int>> v = {std::make_unique<int>(1)}; // ill-formed
```

`std::initializer_list<T>` exposes `const T*` iterators. You cannot move from a `const T`. Move-only types do not work in braced initialization of containers.

The fix: build the vector with `emplace_back` or pass a range of move iterators.

#### NRVO across optimization boundaries

```cpp
std::vector<int> make() {
    if (cond) return std::vector<int>{1, 2, 3};
    return std::vector<int>{4, 5, 6};
}
```

NRVO does not apply (returned expressions are different prvalues). Mandatory elision (C++17) does apply per branch: each prvalue initializes the return slot directly. No moves.

If the branches return named locals:

```cpp
std::vector<int> make() {
    std::vector<int> a{1};
    std::vector<int> b{2};
    if (cond) return a;
    return b;
}
```

NRVO disabled (two locals). Implicit move applies (C++11+). Both branches move-construct the return value.

### What Compilers Actually Do

Use godbolt with `-O2` and look at:

- Number of constructor calls (look for `_ZN1TC1Ev`, `_ZN1TC1ERKS_`, `_ZN1TC1EOS_`).
- Inlining: does the move/copy code disappear?
- `-fdump-tree-final` (GCC) shows the final tree before code generation.
- `-fno-elide-constructors` disables elision so you can see what is being elided.

For a function like:

```cpp
std::string make() { return std::string("hello"); }
auto s = make();
```

Under C++17 with optimization, you should see one `std::string` constructor call and one destructor. No move, no copy. If you see more, elision did not kick in.

### Junior at FAANG vs Senior at FAANG

Junior memorizes "use std::move for performance". They cannot answer why, when it works, and when it does not. Senior connects each cast to a value category, each value category to overload resolution, and each overload to a constructor. Senior also discusses when std::move is wrong (forwarding refs, return statements, const objects), what `noexcept` does to container behavior, and how to verify with godbolt.

### Closing: The Mental Model

Move semantics rests on three pillars:

1. Value categories (lvalue, xvalue, prvalue) decide what an expression names.
2. Reference types (`T&`, `T&&`) and reference collapsing decide what bindings are legal.
3. Special member functions (copy ctor, move ctor, etc.) decide what the compiler generates.

Every move-semantics question reduces to "what is the value category of this expression, what reference does it bind to, and which special member runs?". Answer those three for any expression and you have the right answer.
