## noexcept and Move Strategies

`noexcept` looks like a documentation marker. It is not. It changes algorithm selection in the standard library. The most important consequence is `std::vector` reallocation: a noexcept-movable type gets moved during grow, a throwing-movable type gets copied. For a million-element vector of large strings, that is the difference between O(N) cheap pointer swaps and O(N*M) byte copies.

### The std::vector Reallocation Story

When a vector grows past its capacity, it allocates a new buffer and transfers elements. The transfer must satisfy the strong exception guarantee: if anything throws, the original vector is unchanged.

If the element type's move constructor is noexcept, vector moves elements. If a move could throw, vector cannot guarantee the strong exception guarantee with moves, because partway through the transfer, an exception would leave both buffers in inconsistent states. So vector falls back to copy.

The selector is `std::move_if_noexcept`:

```cpp
template <class T>
constexpr conditional_t<
    !is_nothrow_move_constructible_v<T> && is_copy_constructible_v<T>,
    const T&,
    T&&>
move_if_noexcept(T& x) noexcept;
```

If `T` has a noexcept move constructor, return `T&&` (an xvalue, vector moves). Otherwise, if `T` is copyable, return `const T&` (vector copies). If `T` is not copyable, return `T&&` anyway (vector moves and accepts the loss of the strong guarantee). Move-only types like `unique_ptr` always move, regardless of noexcept (because there is no copy fallback).

### Practical Implications

```cpp
class Bad {
public:
    Bad(Bad&& other) /* noexcept missing */ { /* swap pointers */ }
    Bad(const Bad&)  { /* copy */ }
};

class Good {
public:
    Good(Good&& other) noexcept { /* swap pointers */ }
    Good(const Good&)  { /* copy */ }
};

std::vector<Bad>  v1; // grows by COPYING
std::vector<Good> v2; // grows by MOVING
```

A missing `noexcept` on a move constructor is a frequent performance bug. It often goes unnoticed because the code is correct, just slow. Profiling on grow-heavy benchmarks reveals the discrepancy.

### When Move Cannot Be noexcept

A move constructor cannot honestly be noexcept if any subobject's move can throw. The standard library traits compose:

- `std::is_nothrow_move_constructible_v<T>` checks the implicit or user-defined move ctor of `T` for noexcept.
- For aggregates and rule-of-zero classes, the implicit move is noexcept iff every member's move is noexcept.

Common offenders:

- `std::list<X>` has a noexcept move (it is a pair of pointers).
- `std::vector<X>` has a noexcept move (pointer + size + capacity).
- Allocators with stateful, non-noexcept-movable state can taint container moves. Default `std::allocator` is fine.
- A class with a `std::string` member is fine: `std::string`'s move is noexcept.
- A class with a non-noexcept user move from a third-party library taints everything that contains it.

If you cannot make move noexcept honestly, do not lie. Lying causes `std::terminate` if a move actually throws inside a noexcept function.

### noexcept(noexcept(...))

Computed noexcept lets you propagate exception specifications:

```cpp
template <class T>
struct Wrapper {
    T value;

    Wrapper(Wrapper&& other) noexcept(std::is_nothrow_move_constructible_v<T>)
        : value(std::move(other.value)) {}

    void swap(Wrapper& other) noexcept(noexcept(std::swap(value, other.value))) {
        std::swap(value, other.value);
    }
};
```

The inner `noexcept(expr)` is an operator that yields true if `expr` would not throw, false otherwise. The outer `noexcept(...)` is the specification.

Uses:

- `noexcept(noexcept(swap(a, b)))` propagates the underlying swap's spec.
- `noexcept(std::is_nothrow_move_constructible_v<T>)` is a cleaner spelling for the move-construction case.

Avoid manually wrapping every member. For most cases, default the move and let the implicit specification do the right thing:

```cpp
struct Wrapper {
    T a;
    U b;
    Wrapper(Wrapper&&) = default; // implicit noexcept iff both T and U are noexcept-movable
};
```

### std::move_if_noexcept Idiom

If you implement a container, use `std::move_if_noexcept` for grow operations:

```cpp
template <class T>
void grow(T* old_buf, T* new_buf, std::size_t n) {
    for (std::size_t i = 0; i < n; ++i) {
        std::construct_at(new_buf + i,
            std::move_if_noexcept(old_buf[i]));
    }
}
```

If a copy throws partway, the new buffer's already-constructed elements are destroyed, the old buffer is intact, and the exception propagates. The strong exception guarantee holds.

If you used `std::move` unconditionally and the move threw, the original elements would already be moved-from. The container would be in a corrupted state.

### std::vector::resize and noexcept

`resize(n)` may grow or shrink. On grow that requires reallocation, move-if-noexcept applies. The same is true for `reserve`, `push_back`, `emplace_back`, `insert` past capacity, and `shrink_to_fit`.

A microbenchmark on a vector of 1 million `Bad` (string-owning, throwing-move) versus `Good` (same string, noexcept move) shows roughly an order-of-magnitude difference on grow-heavy workloads. The cost is the per-element string copy versus the per-element pointer swap.

### Move Constructors That Throw

Some types have throwing moves by design. `std::list` does not. `std::vector` does not. But:

- A class with an `int` resource handle that is acquired in the move? Throwing move is possible.
- A class containing a non-noexcept-movable third-party member.
- A class that uses pre-C++17 `boost::container::stable_vector` patterns.

If you must have a throwing move, either:

1. Make the class non-movable (delete the move). Containers fall back to copy and the user knows.
2. Refactor the move to swap a pointer or other trivial state, leaving any allocation to the constructor.

Option 2 is almost always achievable. Move should be a pointer-and-state swap, not a resource acquisition.

### Defaulted Special Members and noexcept

The compiler computes the noexcept specification of a defaulted special member from the noexcept specifications of the corresponding operations on each direct base and member. Two consequences:

- Adding a non-noexcept-movable member taints your class silently.
- Removing a member can make your class noexcept-movable where it was not before.

CI rule worth adding: assert `std::is_nothrow_move_constructible_v<T>` for hot types in unit tests. If a maintenance change adds a throwing-move member, the test catches it before the perf regression hits production.

```cpp
static_assert(std::is_nothrow_move_constructible_v<HotType>);
static_assert(std::is_nothrow_move_assignable_v<HotType>);
static_assert(std::is_nothrow_swappable_v<HotType>);
```

### noexcept(false) is Almost Always Wrong on Move

`noexcept(false)` (the default if no spec is given) is a contract: "I might throw". Containers see this and choose to copy on grow. Across a codebase, the difference is significant.

Audit: search for user-defined move constructors and move assignment operators without `noexcept`. Each is a candidate performance bug. The fix is usually trivial: add `noexcept` if the body really cannot throw.

### destructors and noexcept

Destructors are noexcept by default in C++11+. Almost no one writes `noexcept(false)` destructors deliberately, and they break the standard library if used inside containers. Trust the default.

### noexcept and Function Pointers

`noexcept` is part of the function type since C++17. A `void(*)() noexcept` is convertible to a `void(*)()` but not the reverse. This matters for callback registration and is worth knowing for API design.

```cpp
void f() noexcept;
void g();

void (*pa)() noexcept = f; // ok
void (*pb)()          = f; // ok (loses noexcept)
void (*pc)() noexcept = g; // ill-formed
```

### Junior at FAANG vs Senior at FAANG

Junior writes a move constructor and forgets `noexcept`. The class works, vectors of it work, the perf graphs show 5x slowdown after a refactor and nobody knows why. Senior writes `noexcept` on every move, adds `static_assert(is_nothrow_move_constructible_v<T>)` in the header next to the type, and explains in code review why an audit member that breaks the trait is unacceptable. Senior also knows `std::move_if_noexcept` exists, what it returns, and why containers use it.

### Drill

1. What does `std::move_if_noexcept(x)` return when `decltype(x)` has a throwing-move and is copyable? `const T&`.
2. What does it return for `unique_ptr<int>`? `unique_ptr<int>&&` (move-only types always move).
3. How do you propagate the noexcept of a member's swap to your own swap? `noexcept(noexcept(member.swap(other.member)))`.
4. What is the default exception specification of an implicit move constructor? Computed from members, noexcept iff all members are noexcept-movable.
5. How do you assert a class is noexcept-movable in a header? `static_assert(std::is_nothrow_move_constructible_v<T>);`.
