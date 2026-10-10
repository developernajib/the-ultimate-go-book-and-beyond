## Move and Self-Assignment

Self-assignment is the edge case that bites every author of an assignment operator at least once. Move makes it worse: where copy self-assignment was a wasted operation, move self-assignment can leave the object in a moved-from-then-overwritten state, or with deleted resources, or in undefined behavior territory if the operator was naive.

### The Naive Move Assignment

```cpp
class Buffer {
    char* data_;
    std::size_t size_;
public:
    Buffer& operator=(Buffer&& o) noexcept {
        delete[] data_;
        data_ = o.data_;
        size_ = o.size_;
        o.data_ = nullptr;
        o.size_ = 0;
        return *this;
    }
};

Buffer b;
b = std::move(b); // BUG: deletes data_, then assigns from o.data_ (which is the same, now dangling)
```

The standard library says: "In all cases, an `x = std::move(x)` expression where `x` is a value and the type does not handle self-move-assignment must produce a valid but unspecified state." This means a `vector` or a `string` from libstdc++ handles it. Your hand-rolled type might not.

### The Standard's Position

`std::vector::operator=(vector&&)` since C++11 leaves the vector in a "valid but unspecified" state on self-assignment. libstdc++ historically had bugs here. libc++ tends to be conservative.

For your own types, the explicit guard is the safest:

```cpp
Buffer& operator=(Buffer&& o) noexcept {
    if (this != &o) {
        delete[] data_;
        data_ = std::exchange(o.data_, nullptr);
        size_ = std::exchange(o.size_, 0);
    }
    return *this;
}
```

The guard adds one branch. It removes the entire class of self-move bugs.

### Copy-and-Swap

The copy-and-swap idiom for assignment is naturally self-assignment safe and exception safe:

```cpp
class Buffer {
    char* data_;
    std::size_t size_;
public:
    void swap(Buffer& o) noexcept {
        std::swap(data_, o.data_);
        std::swap(size_, o.size_);
    }

    Buffer& operator=(Buffer o) noexcept { // pass by value
        swap(o);
        return *this;
    }
};
```

The parameter `o` is constructed from the argument: by copy if the argument is an lvalue, by move if an rvalue. Then we swap. The argument's old contents (now in `*this`) are destroyed when `o` exits scope.

Self-assignment is safe because:

- For lvalue self-assignment `b = b`, the parameter `o` is a copy of `b`. Swapping `*this` with `o` leaves `*this` unchanged in content (because `o` was a copy of the original `*this`). When `o` is destroyed, it takes the formerly-owned-by-this-now-owned-by-o resources with it. `*this` is intact.
- For rvalue self-assignment `b = std::move(b)`, the parameter `o` is move-constructed from `b`. After this construction, `b`'s data has been transferred to `o`. Then we swap `*this` (which is `b`, now empty) with `o` (which has the original data). `*this` ends up with its original data. Safe.

The cost is one extra construction. For move assignment, that construction is itself a move (cheap). For copy assignment, it is a copy. If self-assignment is rare, this is fine. If you assign large objects in tight loops, copy-and-swap costs an extra allocation per assignment.

### Move-and-Swap

A variant: separate copy and move assignment, both implemented via swap:

```cpp
class Buffer {
public:
    Buffer& operator=(const Buffer& o) {
        Buffer tmp(o);
        swap(tmp);
        return *this;
    }
    Buffer& operator=(Buffer&& o) noexcept {
        Buffer tmp(std::move(o));
        swap(tmp);
        return *this;
    }
};
```

Same exception-safety, slightly clearer intent, separate optimizations possible for each path.

### Why a = std::move(a) Is Not Always UB

The key question: what does the standard say about self-move?

For standard library types, the result is "valid but unspecified". The object is still destructible and assignable. You should not depend on its contents.

For your types, behavior is whatever you implement. If you do not guard, you may get UB (double-free, dangling pointer access, etc.). If you guard, the behavior is "no-op" or "your-defined-state".

The C++ Core Guidelines say (C.65): "Make move assignment safe for self-assignment." The recommended implementation is the guard or copy-and-swap.

### std::swap and Move

`std::swap` is implemented as:

```cpp
template <class T>
void swap(T& a, T& b) noexcept(/* ... */) {
    T tmp(std::move(a));
    a = std::move(b);
    b = std::move(tmp);
}
```

If `a` and `b` are the same object, this becomes `a = std::move(a)`, which the assignment operator must handle. The standard says swap on self does no observable work, but if your move-assign self-destructs, swap on self crashes.

The fix is to either:

1. Make your move assignment self-safe (guard or copy-and-swap).
2. Have a free `swap` overload that does the right thing.

Option 2 is the "ADL swap" idiom:

```cpp
class Buffer {
    friend void swap(Buffer& a, Buffer& b) noexcept {
        if (&a == &b) return;
        std::swap(a.data_, b.data_);
        std::swap(a.size_, b.size_);
    }
};
```

ADL finds your `swap` via friend injection. Generic code that does `using std::swap; swap(x, y);` picks up your version. This is the idiomatic way to provide a custom swap.

### Move-Assignment with Member Pointers and Self

If your class holds a member that may itself contain `*this` (e.g., a parent pointer), self-assignment can be doubly tricky. Audit:

```cpp
class Node {
    Node* parent_;
    std::vector<std::unique_ptr<Node>> children_;
public:
    Node& operator=(Node&& o) noexcept {
        if (this != &o) {
            parent_ = o.parent_;
            children_ = std::move(o.children_);
            // children's parent_ pointers still point to &o, not this!
            for (auto& c : children_) c->parent_ = this;
        }
        return *this;
    }
};
```

Move assignment must fix up internal references. This is why move semantics is hard to bolt onto graph-like data structures. It is also why intrusive structures (Boost.Intrusive) are typically pinned (non-movable).

### The Standard Containers' Behavior

`std::vector<int> v; v = std::move(v);`

libstdc++: well-defined, v is left valid but possibly empty.
libc++: well-defined, v is left valid but possibly empty.
MSVC STL: well-defined, v is left valid.

The standard requires "valid but unspecified", and all major implementations comply. Your code should never rely on the post-self-move contents.

### Performance vs Safety

The guard `if (this != &o) ...` adds a comparison and branch. On modern CPUs with good branch prediction, the cost is negligible. The exception-safety and correctness are worth it.

Copy-and-swap costs more (an extra allocation per assignment in the copy case, an extra move in the move case). Use it when the simplicity and exception-safety pay off, typically in classes with manual resource management.

For rule-of-zero classes (members handle ownership), the implicit move assignment runs each member's move assignment. Each member's implementation handles its own self-assignment. You inherit safety automatically.

### Self-Assignment in Templates

```cpp
template <class T>
class Container {
    T value_;
public:
    Container& operator=(Container&& o) noexcept(std::is_nothrow_move_assignable_v<T>) {
        if (this != &o) value_ = std::move(o.value_);
        return *this;
    }
};
```

The propagation of noexcept is via `noexcept(std::is_nothrow_move_assignable_v<T>)`. The guard is mandatory because the contained type's move-assign may not be self-safe.

### The "Slot Machine" Bug

A common bug: writing the move assignment as a sequence of moves without considering aliasing inside the source.

```cpp
class Pair {
    std::string a, b;
public:
    Pair& operator=(Pair&& o) noexcept {
        a = std::move(o.a);
        b = std::move(o.b);
        return *this;
    }
};

Pair p;
p = std::move(p); // a = std::move(a), then b = std::move(b)
                  // string self-move is well-defined - net effect: p is valid-unspecified
```

Even without explicit aliasing, member-wise move-assign on self leaves each member in a valid-unspecified state. Often this is fine. For containers of pointers that are part of a graph, it can be disastrous.

### Junior at FAANG vs Senior at FAANG

Junior writes a custom move assignment, runs the tests, all pass. The tests do not include `x = std::move(x)`. Code goes to production. Six months later, a swap inside a sort triggers self-move and the service crashes. Senior writes `if (this != &o)` reflexively, adds `static_assert(std::is_nothrow_move_assignable_v<T>)` next to the type, and includes `b = std::move(b);` (with cppcheck/UBSan suppressions if needed) in unit tests for any type with a hand-written move assignment. Senior also reaches for copy-and-swap when the manual resource management is complex enough that the guard pattern feels fragile.

### Drill

1. What does the standard say about `std::vector<int> v; v = std::move(v);`? Result is "valid but unspecified".
2. Why is copy-and-swap self-safe? The argument is constructed (copied/moved) before any modification of `*this`, the swap is symmetric.
3. What does `if (this != &o) ...` cost on modern CPUs? Negligible (one well-predicted branch).
4. How do member-wise move-assigns behave on self? Each member's move-assign runs on itself, the result is a valid but possibly empty object.
5. Why is intrusive data (parent pointers) hard to move-assign safely? Internal references must be fixed up, they often pin the object.
