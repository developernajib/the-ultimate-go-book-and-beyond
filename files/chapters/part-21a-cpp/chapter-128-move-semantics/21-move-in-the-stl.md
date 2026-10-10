## Move in the STL

The standard library is the largest user of move semantics. Knowing exactly which container operations move, which copy, and which preserve element addresses lets you write algorithms that match container guarantees instead of fighting them.

### Sequence Containers

#### `std::vector<T>`

- `vector(vector&&) noexcept`: O(1), pointer swap.
- `operator=(vector&&)`: O(1) if allocators are equal or POCMA, else O(N).
- Reallocation on grow: move-if-noexcept per element. Noexcept-movable elements move, throwing-movable, copyable elements copy.
- `push_back(T&&)` and `emplace_back(args...)`: amortized O(1). May trigger reallocation.
- `insert` and `erase`: O(N) shifts via move-assign.

Allocator considerations: `std::pmr::vector` and custom allocators may not have noexcept moves. The vector's `noexcept` move depends on the allocator.

#### `std::deque<T>`

- Move construction is O(1) (block pointer swap).
- Move assignment is O(1) if allocators allow, O(N) otherwise.
- No reallocation in the vector sense. Block-based, so growth does not invalidate existing element addresses (push_back/push_front do not invalidate iterators to other elements, they may invalidate end iterators).
- Element move is per-element on grow at the ends if a new block must be allocated.

#### `std::list<T>`, `std::forward_list<T>`

- O(1) move construction and move assignment.
- Element addresses never change. `splice` and `merge` move nodes between lists in O(1) (or O(N) for length-counted operations).
- Iterators stay valid across move construction (the nodes are the same).

#### `std::array<T, N>`

- Move is element-wise. O(N).
- Elements remain in the same physical addresses (the array is in-place).
- This is the only sequence container where "move" does not mean "transfer ownership of buffer".

### Associative Containers

#### std::map, std::set, std::multimap, std::multiset

- Tree-based. Each element is a node allocated separately.
- Move construction: O(1). Pointer swap of root.
- Move assignment: O(1) if allocators allow, O(N) otherwise.
- Iterators (= node pointers) remain valid across move construction. Iterators into the source become invalid because the source is now empty.
- Elements addresses (the node memory) survive the move. This makes them safe targets for parent/sibling pointers.

#### std::unordered_map, std::unordered_set

- Hash-based. Buckets are an array of pointers, nodes are heap-allocated.
- Move construction: O(1). Buckets and node chains move via pointer.
- Element addresses (node memory) survive. References and iterators to elements remain valid. Bucket-array iterators are invalidated.
- Allocator constraints same as above.

The iterator-stability guarantee for node-based containers is invaluable. You can store pointers and references to map/set/list elements across a move of the container itself.

### Move Iterators

`std::move_iterator<It>` wraps an iterator so that `*it` returns `std::move(*underlying_it)`. Used with algorithms to convert copies into moves:

```cpp
std::vector<std::string> src = {"a", "b", "c"};
std::vector<std::string> dst;
dst.reserve(src.size());
std::copy(std::make_move_iterator(src.begin()),
          std::make_move_iterator(src.end()),
          std::back_inserter(dst));
// src elements are now moved-from; dst has the originals
```

`std::make_move_iterator` constructs the wrapper. After the operation, the source elements are valid but unspecified.

For container-to-container transfers, prefer `std::vector(std::make_move_iterator(...), ...)` constructor or `assign`:

```cpp
std::vector<std::string> dst(std::make_move_iterator(src.begin()),
                             std::make_move_iterator(src.end()));
```

C++20 ranges added `std::ranges::move`:

```cpp
std::ranges::move(src, std::back_inserter(dst));
```

Same effect, cleaner syntax.

### std::move_only_function (C++23)

Covered in detail elsewhere. Relevant here: `std::function<R(Args...)>` requires copyability of the stored callable. `std::move_only_function<R(Args...)>` does not. For storing move-only lambdas in containers, use `std::move_only_function`.

### Move-Only Views in Ranges (C++20+)

A view is a non-owning, lazily-evaluated range. Most views in C++20 ranges are copyable. Some are move-only (e.g., views holding move-only callables, or owning views from C++23).

C++23 added `std::views::owning_view`, which takes ownership of a range. It is move-only because the underlying container is moved into the view:

```cpp
auto v = std::views::all(std::vector<int>{1, 2, 3}); // C++20: copies
                                                     // C++23: owning_view, moves
```

C++23's `std::ranges::to<Container>` constructs a container from any range:

```cpp
auto v = some_range | std::ranges::to<std::vector<int>>();
```

If the range yields rvalues, elements are moved into the new container.

### std::ranges::move and std::ranges::move_backward

C++20 added range-friendly versions of `std::move` (the algorithm, not the cast):

```cpp
std::vector<std::string> src = {"a", "b"};
std::vector<std::string> dst(2);
std::ranges::move(src, dst.begin());
// src elements moved-from; dst has originals
```

These overload on ranges and projections. They produce a `std::ranges::in_out_result` containing both end iterators.

### std::swap, std::ranges::swap

`std::swap(a, b)` is implemented via three moves. Its noexcept depends on `T`'s move noexcept.

C++20 added `std::ranges::swap` as a customization point object that:

- Uses a member or ADL `swap` if available.
- Otherwise falls back to three moves.

The CPO version is preferred because it avoids the `using std::swap; swap(a, b);` dance.

### Container Methods That Move

- `emplace`, `emplace_back`, `emplace_front`, `emplace_hint`, `try_emplace`, `insert_or_assign`: construct in place from forwarded arguments.
- `push_back(T&&)`, `push_front(T&&)`: move-construct the new element.
- `assign(InputIt, InputIt)` with `move_iterator`: move source elements.
- `splice` (list): O(1) node transfer between lists.
- `merge` (list, set, map): O(1)-per-node transfer between containers.
- `extract` (associative containers, C++17): removes a node and returns it as a `node_handle`. Lets you move keys around without copy:
  ```cpp
  std::map<std::string, int> a, b;
  auto node = a.extract("key"); // detaches node from a
  b.insert(std::move(node));    // attaches to b
  ```
 Useful for changing a key without reallocating the value:
  ```cpp
  auto node = m.extract("old");
  node.key() = "new";
  m.insert(std::move(node));
  ```

Extract/insert avoid copies when migrating large mapped values.

### std::swap Specializations

Some types specialize `std::swap` for O(1) behavior. Examples:

- `std::vector<T>`: swaps three pointers.
- `std::string`: swaps SSO buffer or pointer.
- `std::unique_ptr<T>`: swaps pointer.
- `std::array<T, N>`: cannot be O(1), swaps element-wise.

If your custom type has a swappable internal representation, provide a member or ADL `swap` to enable O(1) algorithm patterns. Three-move generic swap is fine for most user types but expensive for those with allocations.

### Allocator-Aware Move

Container move operations interact with allocators. The trait `std::allocator_traits<Alloc>::propagate_on_container_move_assignment` (POCMA) decides:

- If `true`: move assignment transfers the allocator and elements. O(1).
- If `false` and allocators are equal: same as above.
- If `false` and allocators are unequal: element-wise move-assign. O(N).

Standard `std::allocator` is "always equal" (`is_always_equal = true`), so the fast path applies. Custom allocators with state may force per-element moves.

`pmr` (Polymorphic Memory Resource, C++17) allocators are not always equal. Move between two `pmr::vector`s with different memory resources falls back to element-wise.

### Junior at FAANG vs Senior at FAANG

Junior writes `auto v2 = v;` to "duplicate the data" and gets a copy. Senior knows that for transfer they want `auto v2 = std::move(v);` (O(1)) and that `v` is then empty. Senior also recognizes `std::move_iterator` for moving elements between containers of different types and knows that `std::map` keeps node addresses stable across container moves so external pointers stay valid.

### Drill

1. Iterators into a moved-from `std::map` are valid pointers to nodes that moved with the container. True or false? True. The nodes are the same memory, only the container's root pointer moved.
2. Why is `std::vector<T>` move O(1)? Three pointers (begin, end, end_of_storage) are swapped.
3. What does `std::make_move_iterator(it)` do? Wraps `it` so `*it` returns an rvalue reference instead of an lvalue reference.
4. C++17 added `extract` and `insert(node_handle)` for associative containers. Why? Allows moving nodes between maps and changing keys without copies.
5. Why might a `pmr::vector` move assignment be O(N)? Different memory resources are not interchangeable, elements must be reallocated and moved one by one.
