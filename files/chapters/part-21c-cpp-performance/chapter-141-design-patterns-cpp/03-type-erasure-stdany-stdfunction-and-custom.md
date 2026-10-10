## Type Erasure: std::any, std::function, and Custom Type Erasure

Type erasure is the technique of hiding a concrete type behind a uniform interface without requiring the caller and the implementation to share a common base class. It is how Go interfaces work. In C++, type erasure requires explicit design, but the result can be zero-overhead at compile time or tuned for specific runtime characteristics.

### What Type Erasure Is

The core idea: given a concrete type `Dog` and a concrete type `Cat`, both of which can `speak()`, we want to store and call them through a common handle without requiring them to derive from `Animal`. The handle erases the type. Internally, it stores either a pointer to the concrete object plus a function pointer to its `speak`, or it uses virtual dispatch, or it uses template-driven code generation.

Go does this automatically: any type with a `Speak() string` method satisfies the `Speaker` interface. In C++, you implement the mechanism yourself, or use `std::function`, `std::any`, or virtual base classes.

### std::function: Type Erasure for Callables

`std::function<R(Args...)>` erases the type of any callable (lambda, function pointer, functor) that matches the signature. Internally,, it uses the "small buffer optimization" (SBO): callables small enough (typically 16 bytes on common implementations) are stored inline. Larger ones are heap-allocated.

```cpp
#include <functional>
#include <iostream>
#include <vector>

// Any callable that takes int and returns void is accepted.
// The concrete type (lambda, functor, function pointer) is erased.
void register_handler(std::function<void(int)> handler) {
    handler(42);
}

// Lambda -- stored inline if closure is small enough
register_handler([](int x) { std::cout << "got: " << x << '\n'; });

// Large functor with captured state -- may trigger heap allocation
struct BigHandler {
    std::array<char, 64> buffer;  // Exceeds SBO threshold on most impls
    void operator()(int x) const { (void)x; }
};
register_handler(BigHandler{});  // Heap allocation likely
```

The SBO threshold is implementation-defined. On libstdc++, libc++, and MSVC's STL it is typically 16-32 bytes. A lambda that captures one or two pointers fits inline. A lambda that captures a `std::string` or `std::vector` does not.

`std::function` incurs virtual-dispatch-like overhead: an indirect call through a vtable-equivalent stored inside the object. For hot paths, prefer `auto` lambdas or function templates.

### std::any: Type-Safe Void Pointer

`std::any` stores a value of any CopyConstructible type along with RTTI metadata to enable safe extraction:

```cpp
#include <any>
#include <string>
#include <stdexcept>

std::any value = 42;
value = std::string("hello");
value = 3.14;

// Type-safe extraction -- throws std::bad_any_cast on mismatch
double d = std::any_cast<double>(value);  // OK

try {
    int i = std::any_cast<int>(value);    // Throws: value holds double
} catch (const std::bad_any_cast& e) {
    // Handle mismatch
}

// Non-throwing form: returns pointer or nullptr
if (auto* p = std::any_cast<double>(&value); p != nullptr) {
    std::cout << "double: " << *p << '\n';
}

// Check type before cast
if (value.type() == typeid(double)) {
    // safe
}
```

`std::any` also uses SBO for small types. Large types trigger heap allocation. It requires RTTI, if you compile with `-fno-rtti`, you cannot use `std::any`.

### Custom Type Erasure with Small Buffer Optimization

The most powerful pattern is a hand-rolled type-erased wrapper tailored to your interface. This avoids `std::function`'s overhead for your specific call signature and can tune the SBO buffer size:

```cpp
#include <cstddef>
#include <cstring>
#include <type_traits>
#include <utility>
#include <new>

// Type-erased callable with configurable SBO buffer.
// Stores callables of signature void(int) without heap allocation
// if they fit in BufferSize bytes.
template <std::size_t BufferSize = 32>
class InlineFunction {
    // Vtable-like dispatch struct stored alongside the data
    struct Vtable {
        void (*invoke)(void* self, int arg);
        void (*destroy)(void* self);
        void (*copy)(void* dst, const void* src);
    };

    alignas(std::max_align_t) std::byte buffer_[BufferSize];
    const Vtable* vtable_ = nullptr;

    template <typename Fn>
    static constexpr bool fits_inline =
        sizeof(Fn) <= BufferSize &&
        alignof(Fn) <= alignof(std::max_align_t) &&
        std::is_nothrow_move_constructible_v<Fn>;

    template <typename Fn>
    static constexpr Vtable make_vtable() {
        return Vtable{
            .invoke  = [](void* self, int arg) {
                (*static_cast<Fn*>(self))(arg);
            },
            .destroy = [](void* self) {
                static_cast<Fn*>(self)->~Fn();
            },
            .copy    = [](void* dst, const void* src) {
                new (dst) Fn(*static_cast<const Fn*>(src));
            }
        };
    }

public:
    InlineFunction() = default;

    template <typename Fn,
              typename = std::enable_if_t<fits_inline<std::decay_t<Fn>>>>
    InlineFunction(Fn&& fn) {
        using FnDecayed = std::decay_t<Fn>;
        static constexpr Vtable vt = make_vtable<FnDecayed>();
        new (buffer_) FnDecayed(std::forward<Fn>(fn));
        vtable_ = &vt;
    }

    ~InlineFunction() {
        if (vtable_) vtable_->destroy(buffer_);
    }

    InlineFunction(const InlineFunction& other) {
        if (other.vtable_) {
            other.vtable_->copy(buffer_, other.buffer_);
            vtable_ = other.vtable_;
        }
    }

    void operator()(int arg) const {
        vtable_->invoke(const_cast<std::byte*>(buffer_), arg);
    }

    explicit operator bool() const noexcept { return vtable_ != nullptr; }
};
```

This implementation guarantees no heap allocation for callables up to `BufferSize` bytes. If a callable is too large, it fails to compile (the `enable_if` rejects it). In production, you would add a heap-fallback path or static_assert with a helpful message.

### Go Comparison: Interfaces as Built-in Type Erasure

Go interfaces are type erasure built into the language:

```go
type Speaker interface {
    Speak() string
}

// Dog and Cat need not know about Speaker at definition time.
type Dog struct{ Name string }
func (d Dog) Speak() string { return "woof" }

type Cat struct{ Name string }
func (c Cat) Speak() string { return "meow" }

func makeNoise(s Speaker) {
    fmt.Println(s.Speak())
}
```

Internally, a Go interface value is two words: a pointer to the type's method table (itab) and a pointer to the data. This is structurally identical to C++'s virtual dispatch, but without requiring explicit inheritance. The Go runtime builds itabs lazily and caches them.

C++ requires you to design the erasure mechanism explicitly. The payoff is control: you can tune the SBO size, choose between virtual dispatch and function pointers, add thread safety, or eliminate heap allocation entirely, none of which is possible with Go interfaces.

### Performance Implications

| Mechanism | Dispatch cost | Heap alloc | Requires RTTI |
|---|---|---|---|
| `std::function` (SBO hit) | ~2-5 ns | No | No |
| `std::function` (SBO miss) | ~5-10 ns | Yes | No |
| `std::any` | N/A (storage only) | Sometimes | Yes |
| Custom inline type erasure | ~1-3 ns | No (if sized right) | No |
| `virtual` dispatch | ~3-5 ns | Depends on object | No |
| Template (monomorphized) | 0 ns overhead | No | No |

For event handlers registered once and called frequently, custom type erasure with a tuned SBO size is the best balance of flexibility and performance.

---
