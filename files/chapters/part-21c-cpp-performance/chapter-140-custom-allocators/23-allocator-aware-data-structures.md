## Allocator-Aware Data Structures

Standard containers accept an allocator template parameter. Most code uses the default and never thinks about it. For high-performance C++ you need to know what the allocator interface guarantees, what it propagates on copy, and what it does not. The rules are subtle. The bugs are easy to write.

### The Allocator Interface (C++17 and later)

A minimal C++17 allocator looks like this.

```cpp
template <typename T>
class MyAllocator {
public:
    using value_type = T;

    MyAllocator() noexcept = default;

    template <typename U>
    MyAllocator(const MyAllocator<U>&) noexcept {}

    [[nodiscard]] T* allocate(std::size_t n) {
        return static_cast<T*>(::operator new(n * sizeof(T)));
    }

    void deallocate(T* p, std::size_t /*n*/) noexcept {
        ::operator delete(p);
    }

    bool operator==(const MyAllocator&) const noexcept { return true; }
    bool operator!=(const MyAllocator&) const noexcept { return false; }
};
```

Five member functions, plus the rebind constructor template, plus equality. `std::allocator_traits<MyAllocator>` fills in the rest with defaults. You no longer need `pointer`, `const_pointer`, `reference`, `construct`, `destroy`, `max_size`, etc. The C++03 era allocator boilerplate is gone.

### Stateless vs Stateful

A stateless allocator carries no instance data. All instances are equivalent. `std::allocator<T>` is stateless. Copying is free. Swapping is free. The empty base optimization (EBO) applies, so a `std::vector<int>` is the size of three pointers, not four.

A stateful allocator holds at least one pointer or value. Copying matters. Equality is identity-based. You give up EBO unless you take care.

```cpp
// Stateless: empty class. EBO applies.
template <typename T>
struct StatelessArenaAlloc {
    using value_type = T;
    T* allocate(size_t n) { return /* hits a thread-local arena */; }
    void deallocate(T*, size_t) {}
    bool operator==(const StatelessArenaAlloc&) const { return true; }
};

// Stateful: holds a pointer. No EBO.
template <typename T>
class StatefulArenaAlloc {
    Arena* arena_;
public:
    using value_type = T;
    explicit StatefulArenaAlloc(Arena* a) : arena_(a) {}
    T* allocate(size_t n) { return static_cast<T*>(arena_->alloc(n * sizeof(T))); }
    void deallocate(T*, size_t) {}
    bool operator==(const StatefulArenaAlloc& o) const { return arena_ == o.arena_; }
};
```

For `std::vector<int, StatefulArenaAlloc<int>>`, sizeof is four pointers (data, size, capacity, allocator). For `std::vector<int, StatelessArenaAlloc<int>>`, sizeof is three because libc++ and libstdc++ both apply EBO.

If you write a stateless allocator that secretly looks at thread-local state, document it. The "stateless" label is a contract: every instance is interchangeable.

### Empty Base Optimization in Practice

Standard library implementations use compressed-pair internally to apply EBO to allocators. Folly's `compressed_pair`, Boost's `boost::compressed_pair`, and `std::__compressed_pair` (libc++ internal) all do the same thing: if either member is an empty class, store only the non-empty one and return a reference to a zero-byte object for the empty one.

Custom container authors should do the same. Otherwise stateless allocators waste a pointer per container.

### Allocator Propagation Traits

When you copy, move, or swap a container, what happens to its allocator? The standard provides three traits.

- `propagate_on_container_copy_assignment` (POCCA): on `c1 = c2`, does `c1` adopt `c2`'s allocator?
- `propagate_on_container_move_assignment` (POCMA): on `c1 = std::move(c2)`, does `c1` adopt `c2`'s allocator?
- `propagate_on_container_swap` (POCS): on `swap(c1, c2)`, do the allocators swap too?

`std::allocator_traits` defaults all three to `false_type`. You opt in by adding type aliases:

```cpp
template <typename T>
class MyAlloc {
public:
    using value_type = T;
    using propagate_on_container_copy_assignment = std::true_type;
    using propagate_on_container_move_assignment = std::true_type;
    using propagate_on_container_swap = std::true_type;
    // ...
};
```

The behavior when the trait is false:

- POCCA false, copy-assignment: target keeps its allocator. Source elements are reallocated using the target's allocator.
- POCMA false, move-assignment: if allocators are equal, take ownership of the source's storage. If not equal, move element-by-element. This is silent and slow when allocators differ.
- POCS false, swap: undefined behavior if allocators are not equal. The standard requires equal allocators for swap to be valid.

The default behavior (all false) is "the allocator is sticky to the container instance." This is what `std::pmr::polymorphic_allocator` enforces. For most cases this is what you want.

The trap: containers with stateful allocators that compare-equal-by-pointer and POCMA false will silently fall into the slow element-by-element move path on assignment. Profile-guided optimization will not save you because the slow path is in the standard library, inlined or not.

### A Worked Bug

```cpp
Arena a1, a2;
std::vector<int, StatefulArenaAlloc<int>> v1(StatefulArenaAlloc<int>{&a1});
std::vector<int, StatefulArenaAlloc<int>> v2(StatefulArenaAlloc<int>{&a2});

v1.push_back(1);
v1.push_back(2);

v2 = std::move(v1);  // POCMA defaults to false, &a1 != &a2
                     // -> element-by-element move into a2's storage
                     // v1 is now valid but empty, a1 still owns the original buffer (now garbage)
                     // v2's elements live in a2
```

Fix: enable POCMA, or make the allocator type comparable on a shared upstream, or accept the cost.

### std::pmr Differs

`std::pmr::polymorphic_allocator` sets all three propagation traits to `false`. Always. By design. This means `std::pmr::vector<T>` never adopts the source's allocator on assignment. The container is bound to its `memory_resource*` for life. Even `std::pmr::map` and `std::pmr::unordered_map` follow the rule.

This is why you cannot `swap` two `std::pmr::vector`s with different resources. The standard requires equal allocators for swap, polymorphic_allocator is equal iff the resources compare equal, and resources compare equal iff their `do_is_equal` says so. For most resources, `do_is_equal` is identity.

Workaround for "swap two pmr vectors with different resources": use the explicit copy-then-move pattern.

```cpp
std::pmr::vector<int> a(&res1);
std::pmr::vector<int> b(&res2);
// Want to swap contents:
std::pmr::vector<int> tmp(b, &res1);
b = std::pmr::vector<int>(a, &res2);
a = std::move(tmp);
```

This actually copies elements through the right resources. The cost is two element-by-element copies. There is no shortcut.

### std::vector Implementation Notes

What `std::vector` does on common operations.

| Operation | Allocator behavior |
|-------------------------|-------------------------------------------------------------|
| `vector(alloc)` | Stores `alloc`. No allocation. |
| `vector(n, val, alloc)` | Stores `alloc`. Allocates n objects via `alloc`. |
| `vector(other)` | Copies allocator via `select_on_container_copy_construction`. |
| `vector(other, alloc)` | Stores `alloc`. Copies elements through `alloc`. |
| `vector(std::move(other))` | Transfers allocator and storage. O(1). |
| `vector(std::move(other), alloc)` | If `alloc == other.alloc`, transfer storage. Else element-by-element move. |
| `a = b` | If POCCA, copy `b`'s alloc. Reallocate elements through final alloc. |
| `a = std::move(b)` | If POCMA, transfer alloc + storage. Else if equal allocs, transfer. Else element-by-element move. |
| `swap(a, b)` | If POCS, swap allocs and storage. Else: undefined if allocs differ, otherwise swap storage. |

The `select_on_container_copy_construction` hook lets a stateful allocator decide what to give a copy. The default is to copy the allocator. Pmr returns a default-constructed allocator (with `new_delete_resource`), which is why pmr copies do not propagate the resource.

### std::unordered_map Adds Quirks

Hash maps internally allocate node objects. Each node is a fixed size. Each table slot holds a pointer (or list head). Both come from the allocator.

The hash map's allocator handles two different size classes (nodes and the bucket array). Pmr's `unsynchronized_pool_resource` handles this well: small node allocations come from the pool, large bucket allocations bypass to the upstream.

A subtle bug: copying an `unordered_map<K, V, Hash, Eq, Alloc>` with a stateful allocator and POCCA false reallocates every node through the target's allocator. For a million-element map, this is a million allocations on copy. If you did not realize that copy was deep, the perf surprise can be hours of debugging.

### Common Bugs

1. Allocator propagation flag mismatch. Container A has POCMA true, container B has POCMA false. `c1 = std::move(c2)` does different things in different places. Pick one policy per allocator type.

2. Mixing pmr and non-pmr containers. `std::vector<int>` and `std::pmr::vector<int>` are different types. Conversion is always element-copy.

3. Allocator outliving its resource. `auto v = make_vector(); res.~MyResource(); v.push_back(...);` invokes a deallocated resource. Easy to write with stack-allocated resources and lambda captures.

4. Forgetting to pass the allocator to nested containers. `std::pmr::vector<std::pmr::string>` needs the allocator threaded through to each string. Use `uses_allocator_construction_args` or accept that the strings will use the default resource.

5. Using `select_on_container_copy_construction` to allocate fresh state. This is called on copy. Returning a freshly-allocated arena means every copy of a container creates a new arena. Probably not what you want.

### Junior to FAANG

A junior engineer writes `using value_type = T;` and a couple of methods, calls it an allocator, and is surprised when copies behave strangely. A FAANG-grade engineer picks propagation traits deliberately, writes EBO-friendly stateless allocators where possible, threads `uses_allocator` through nested containers, and tests allocator behavior with a tracking resource that asserts every alloc and free is balanced. They also read the libc++ implementation of `std::vector` once to internalize what `std::allocator_traits` actually does, because the documentation is dry and the code is not.
