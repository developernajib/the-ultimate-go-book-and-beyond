## `noexcept` Policy Design

`noexcept` is two things at once. It is a runtime contract (if a `noexcept` function actually throws, the runtime calls `terminate`), and it is a compile-time predicate (`noexcept(expr)` is `true` if `expr` is not allowed to throw). Both forms have load-bearing effects on performance and on standard library behavior. Treating `noexcept` as decoration produces subtle bugs and missed optimizations.

## The Contract

```cpp
void f() noexcept;            // promise: never throws
void g() noexcept(true);      // same
void h() noexcept(false);     // explicitly may throw (default for non-special members)
void k() noexcept(sizeof(int) == 4);  // conditional
```

If `f` actually throws (directly or transitively), the runtime calls `std::terminate`. The compiler emits no special "stack guard" or recovery code for the inside of `f`. What it does emit is awareness at the call site: callers know the call cannot throw, so destructors of objects in the caller do not need to be in a landing pad's cleanup list across that call. This shrinks `.gcc_except_table` and (on some targets) lets the compiler inline more aggressively.

## Why Move Constructors Should Be `noexcept`

`std::vector<T>::push_back` has a strong exception guarantee. When growing, it must move (or copy) all existing elements to the new buffer. If a move throws halfway, the old buffer is gone, the new buffer has half the moves done, and there is no way back to the original state.

The standard library chooses at compile time:

```cpp
if constexpr (std::is_nothrow_move_constructible_v<T> ||
              !std::is_copy_constructible_v<T>) {
    // move (cheap)
} else {
    // copy (preserves strong guarantee)
}
```

If your move constructor is not `noexcept`, `vector<T>` falls back to copying on grow. For a type holding a 10MB buffer, that is the difference between a pointer swap and a 10MB allocation plus memcpy per element. This is the most common production bug caught by `static_assert(std::is_nothrow_move_constructible_v<T>);` audits.

The rule: **move ctor and move assign must be `noexcept`**. If your type cannot promise that, redesign it (often by using `unique_ptr` for a heap pinata instead of a member that allocates).

### Why Destructors Should Be `noexcept`

Destructors are implicitly `noexcept(true)` since C++11 (unless any subobject's destructor is `noexcept(false)`, which is rare and almost always wrong). A throwing destructor that runs during stack unwinding calls `terminate` immediately. Destructors run during unwinding any time an exception is thrown from a frame that contains automatic objects. The chance of two simultaneous exceptions is high in any non-trivial code.

```cpp
class BadGuard {
public:
    ~BadGuard() {
        if (auto ec = flush()) throw std::system_error(ec);  // bug
    }
};
```

If the surrounding code is unwinding, this calls `terminate`. The fix is to log the error or set a flag the caller can check, never to throw.

### Why `swap` Should Be `noexcept`

`std::swap(a, b)` is the basis for the copy-and-swap idiom. If `swap` throws, the strong exception guarantee for assignment is impossible. The standard library specializes algorithms on `is_nothrow_swappable_v<T>` similarly to how it specializes on `is_nothrow_move_constructible_v<T>`.

Provide a hidden friend `swap`:

```cpp
class Buffer {
public:
    friend void swap(Buffer& a, Buffer& b) noexcept {
        using std::swap;
        swap(a.data_, b.data_);
        swap(a.size_, b.size_);
    }
private:
    T* data_;
    std::size_t size_;
};
```

The hidden friend (in-class definition with `friend`) is found by ADL and not by unqualified name lookup, which avoids ambiguity with `std::swap`.

## Conditional `noexcept`

Generic code rarely knows whether `T`'s operations throw. Propagate with `noexcept(noexcept(expr))`:

```cpp
template <typename T>
void relocate(T* dst, T* src)
    noexcept(std::is_nothrow_move_constructible_v<T> &&
             std::is_nothrow_destructible_v<T>) {
    new (dst) T(std::move(*src));
    src->~T();
}
```

Or the shorter form:

```cpp
template <typename F, typename... A>
auto call(F&& f, A&&... a)
    noexcept(noexcept(std::forward<F>(f)(std::forward<A>(a)...)))
    -> decltype(auto) {
    return std::forward<F>(f)(std::forward<A>(a)...);
}
```

`noexcept(expr)` is the operator, the outer `noexcept(...)` is the specifier. The double-`noexcept` is the canonical pattern in standard library implementations.

### `noexcept` and the Optimizer

GCC and Clang use `noexcept` to:

- Emit fewer cleanup landing pads in callers.
- Skip generation of `.gcc_except_table` entries for ranges where every callee is `noexcept`.
- Inline `noexcept` functions across exception-throwing callers without poisoning the caller's exception table.
- For some library types, select faster algorithm specializations (`vector` grow, `optional` move, `variant` move, etc.).

The effect on raw function-call latency is small (single-digit nanoseconds per call). The effect on `vector` and `flat_map` workloads via algorithm selection is enormous.

### The Lakos Rule

Wide contracts (functions whose precondition is "any input is fine") should be `noexcept`. Narrow contracts (functions with a precondition the caller must satisfy) should not be `noexcept`, so that violation can be reported via an exception, contract assertion, or test hook. This is the Lakos rule, named after John Lakos, and it is why `vector::front()` is not `noexcept` (precondition: vector is not empty) while `vector::size()` is `noexcept` (no precondition).

In practice for application code, the rule is less religious: mark special members (move, dtor, swap) `noexcept`, and otherwise apply `noexcept` where you can guarantee it. Do not put `noexcept` on a function that calls into code you do not control unless you have wrapped it in a `catch (...)` that translates to a different signal.

### `noexcept` at Service Boundaries

A common policy at large companies:

- Internal callees: liberal `noexcept`. Move/copy/swap/dtor of every domain type is `noexcept` and audited.
- Public boundary functions: not `noexcept` if they can fail. They return `expected` or throw a domain exception.
- C-ABI exports: `noexcept` always, with an internal `try { ... } catch (...) { return ERROR; }` translating any escapee to an error code (covered in the FFI section).

The mistake is marking a top-level RPC handler `noexcept` "to be fast". Any escaping exception from a deep callee then terminates the whole process. Mark internal helpers `noexcept`, not boundaries.

### Detecting `noexcept`-incorrect Code

A useful audit:

```cpp
static_assert(std::is_nothrow_move_constructible_v<Session>);
static_assert(std::is_nothrow_move_assignable_v<Session>);
static_assert(std::is_nothrow_destructible_v<Session>);
static_assert(std::is_nothrow_swappable_v<Session>);
```

Put these in the test file for every domain value type. They fire at compile time and prevent regressions. CI catches a future change to a member that quietly drops the `noexcept` from the synthesized move.

### Common Bugs

**Forgotten `noexcept` on user-defined move.** Compiler-generated moves are `noexcept` if all subobject moves are. A user-written move ctor without `noexcept` regresses the type. Fix: always write `Type(Type&&) noexcept = default;` or write the body and add `noexcept`.

**Throwing inside `noexcept` lambda.** Lambdas are not `noexcept` by default. Mark them: `[]() noexcept { ... }`.

**`noexcept` on a function that calls a virtual.** The virtual's exception specification at compile time is the static one. If a derived override actually throws, you get `terminate` at runtime. Audit polymorphic hierarchies.

**`noexcept(noexcept(f()))` evaluating `f` differently across overloads.** Operator resolution inside `noexcept(...)` follows the same overload resolution as the call would. Subtle bugs occur when constraints differ.

### FAANG Bar

A senior engineer should:

- Default to `noexcept` on move ctor, move assign, dtor, swap, and prove it with `static_assert`.
- Use conditional `noexcept(noexcept(...))` in generic code.
- Recognize the algorithmic effect on `vector::push_back` of a non-`noexcept` move.
- Apply the Lakos rule to API design.
- Avoid `noexcept` on top-level boundaries that legitimately fail.
- Audit for hidden non-`noexcept` regressions with `static_assert` in tests.
