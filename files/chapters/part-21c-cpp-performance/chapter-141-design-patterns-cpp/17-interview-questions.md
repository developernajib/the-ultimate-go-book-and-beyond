## Interview Questions

### Q1: What is the Pimpl idiom and why must you define the destructor out-of-line?

**Answer:** Pimpl (Pointer to IMPLementation) hides a class's private data behind a `unique_ptr` to a forward-declared `Impl` struct. The implementation struct is defined only in the `.cpp` file, so callers' translation units never see its contents, changing private fields does not cascade into recompilation of every includer.

The destructor must be defined in the `.cpp` file (even as `= default`) because `unique_ptr<Impl>`'s destructor calls `delete`, which requires `Impl` to be a complete type. If you write `~MyClass() = default` in the header, the compiler tries to instantiate `unique_ptr<Impl>::~unique_ptr()` at the header include site, where `Impl` is still just a forward declaration. The fix: declare `~MyClass()` in the header (no `= default`), define it in the `.cpp`.

The same applies to move constructor and move assignment if the default-generated bodies reference the destructor of `Impl`.

---

### Q2: Explain the "small buffer optimization" in std::function. When does it matter?

**Answer:** `std::function` stores its callable in a fixed-size inline buffer (typically 16-32 bytes depending on the implementation). If the callable, including all captured state, fits in this buffer, no heap allocation occurs. This is the SBO (small buffer optimization).

It matters when `std::function` is constructed and destroyed frequently, such as in a tight loop registering callbacks. A lambda that captures one or two pointers (8-16 bytes) fits inline and incurs zero allocation cost. A lambda that captures a `std::string` or `std::vector` triggers a heap allocation on every construction.

To check: if `sizeof` of the lambda closure class exceeds ~16 bytes, expect heap allocation. Profile with a custom allocator or use Clang's `-fsanitize=address` to detect heap traffic. For hot paths where SBO misses are a concern, a hand-rolled type erasure class with a tuned buffer size eliminates the allocation entirely.

---

### Q3: What is the "overload" trick used with std::visit? Write it from memory.

**Answer:**

```cpp
template <typename... Ts>
struct overload : Ts... {
    using Ts::operator()...;
};

// C++17 deduction guide (not needed in C++20)
template <typename... Ts>
overload(Ts...) -> overload<Ts...>;
```

This creates a struct that inherits from all provided callable types and pulls all their `operator()` overloads into scope via `using`. When you pass an `overload{lambda1, lambda2, lambda3}` to `std::visit`, the compiler selects the right `operator()` based on which `std::variant` alternative is active. If you omit a case, the compiler reports an ambiguous overload or a deleted function, giving compile-time exhaustiveness. The entire construct is two lines and zero runtime overhead.

---

### Q4: What is policy-based design and when does it beat virtual dispatch?

**Answer:** Policy-based design (Alexandrescu, "Modern C++ Design") parameterizes a class with template arguments, called policies, each representing one orthogonal dimension of behavior. The host class composes them. Because template parameters are resolved at compile time, the compiler inlines policy calls entirely, no vtable, no indirect call.

It beats virtual dispatch when:
- The concrete combination is always known at compile time (e.g., a test build always uses `NullOutput`, a production build always uses `FileOutput`).
- The policy is called per-element rather than per-operation (comparators, allocators, hash functions), where the vtable overhead is multiplied millions of times.
- You have M × N × P combinations of orthogonal behaviors: policy-based design requires M+N+P implementations, whereas inheritance requires M×N×P subclasses.

Virtual dispatch is better when the concrete type must be selected at runtime (from config file, dependency injection, user input).

---

### Q5: Describe two ways to implement lifetime-safe observer auto-unsubscription in C++.

**Answer:**

**Method 1, RAII Handle:** `subscribe()` returns a `Handle` object that stores a pointer to the signal and a unique ID. The `Handle` destructor calls `signal->unsubscribe(id)`. As long as the listener holds the handle, the subscription is active. When the handle goes out of scope or is reset, the subscription is removed. No dangling pointer is possible because the signal is not accessed after it destroys itself (the caller's handle should also be destroyed before that point, or the handle stores a `shared_ptr` to the signal).

**Method 2, `weak_ptr` to subscriber:** Store each subscriber as a `std::weak_ptr<T>`. On `emit()`, attempt to lock each `weak_ptr`. If `lock()` returns null, the subscriber has been destroyed, remove it from the list. This approach requires subscribers to be `shared_ptr`-managed objects, but provides automatic cleanup without any explicit deregistration. It is simpler but less efficient (lock attempt per dispatch).

Production systems often combine both: RAII handle for explicit lifetime management, `weak_ptr` as a safety net for subscribers that fail to unregister.

---

### Q6: When would you use std::variant over a virtual base class hierarchy?

**Answer:** Use `std::variant` when the set of types is **closed**, you control all alternatives and they are fixed at compile time. `std::variant` provides:
- Compile-time exhaustiveness: missing a case in `std::visit` is a compile error, not a runtime bug.
- No heap allocation: the variant holds all alternatives inline (size = max alternative + discriminant).
- No vtable overhead: `std::visit` dispatches via a jump table, not an indirect call chain.
- Value semantics: variants can be freely copied, moved, and stored in arrays.

Use a virtual base class hierarchy when the set of types is **open**, third-party code will add new subtypes that you cannot know at compile time. Plugins, extensible node systems, and framework base classes require virtual dispatch because you cannot enumerate all alternatives in the variant.

The classic trade-off: variants make it easy to add new operations (visitors) but hard to add new types. Virtual dispatch makes it easy to add new types but hard to add new operations (requires touching every subclass).

---

### Q7: What is CRTP and how does it solve the builder inheritance problem?

**Answer:** CRTP (Curiously Recurring Template Pattern) is a C++ idiom where a base class is parameterized by its derived class:

```cpp
template <typename Derived>
class Base {
    Derived& self() { return static_cast<Derived&>(*this); }
public:
    Derived& method() { /* ... */ return self(); }
};

class Derived : public Base<Derived> { ... };
```

In a fluent builder, methods in `Base` return `Base&`. If a derived builder inherits from `Base`, calling a base method during chaining returns `Base&`, losing access to the derived builder's methods. CRTP fixes this by having base methods call `self()` (a `static_cast` to `Derived&`) and return `Derived&`. The derived type is baked into the base class template, so no virtual call is needed.

This is zero-overhead: the `static_cast` compiles to nothing, the return type is resolved at compile time, and the compiler can inline the full chain.

---

### Q8: How would you implement a thread-safe singleton using std::call_once and what pitfalls does it avoid?

**Answer:**

```cpp
#include <mutex>

class DatabasePool {
public:
    static DatabasePool& instance() {
        static std::once_flag flag;
        static DatabasePool*  pool = nullptr;
        std::call_once(flag, [] {
            pool = new DatabasePool();
        });
        return *pool;
    }

private:
    DatabasePool() { /* initialize connection pool */ }
};
```

`std::call_once` guarantees that the initialization lambda runs exactly once across all threads, even with concurrent first calls. It handles the double-checked locking anti-pattern correctly, no manual memory fences, no undefined behavior from data races.

In C++11 and later, the simpler form `static DatabasePool instance;` in a function is also guaranteed thread-safe by the standard ("magic statics"). The `std::call_once` form is preferred when initialization requires multiple steps or the singleton must be heap-allocated (for controlled destruction order).

Pitfalls it avoids: data race during initialization (UB in pre-C++11 code), "double-checked locking" with a plain bool flag (broken without proper memory barriers), and eager initialization at program startup (which may fail if dependencies are not yet initialized).

---

### Q9: Compare ECS architecture to OOP inheritance for game entities. When is each appropriate?

**Answer:** OOP inheritance models a game entity as an object in a class hierarchy: `Character -> Player`, `Character -> Enemy`. Behavior comes from overriding virtual methods. The problem: you cannot cleanly model entities that share behaviors from multiple branches (a flying entity that is also a vehicle), data is scattered across heap-allocated objects, and iterating all entities of a type is cache-hostile (pointer-chasing).

ECS separates **identity** (integer EntityId), **data** (component structs stored in dense arrays), and **logic** (systems that iterate component arrays). Iterating all entities with a `Position` component scans a contiguous array, one cache line holds multiple components, and the loop can be SIMD-vectorized. Adding a new behavior is adding a new component type and a new system, no inheritance hierarchy change.

ECS is appropriate when: entity count is large (10,000+), most update logic iterates all entities of a type, and data-oriented performance is a requirement (games, simulations, physics engines).

OOP inheritance is appropriate when: entity count is small, each entity has unique complex behavior, and code clarity matters more than cache performance. For a 50-entity turn-based game, the complexity of ECS is not justified. For a 100,000-particle physics simulation, OOP is demonstrably too slow.

---
