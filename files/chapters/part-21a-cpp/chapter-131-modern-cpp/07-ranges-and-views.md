## Ranges and Views

The Ranges library shipped with C++20 and grew substantially in C++23. It restructures iteration around two ideas: a **range** is anything with `begin` and `end`, and a **view** is a range that owns no elements and is cheap to copy. Views compose lazily through the pipe operator. The result is iterator-free code that looks like a Unix shell pipeline and compiles to the same loops the hand-written version would.

### Eager Containers vs Lazy Views

A `std::vector<int>` owns memory and is expensive to copy. A `std::ranges::transform_view` holds a reference to its source and a function object, costs nothing to copy, and produces values on demand.

```cpp
std::vector<int> xs = {1, 2, 3, 4, 5};

// Eager. Allocates a new vector.
std::vector<int> doubled(xs.size());
std::transform(xs.begin(), xs.end(), doubled.begin(),
               [](int x) { return x * 2; });

// Lazy. Allocates nothing. Each * dereference computes x * 2.
auto v = xs | std::views::transform([](int x) { return x * 2; });
for (int y : v) std::cout << y << ' ';
```

A view is itself a range. `v.begin()` returns an iterator that, when dereferenced, applies the transform. Composing views composes the function objects. The optimizer inlines the chain into a single loop body.

### The Pipe Operator

`r | adaptor` is sugar for `adaptor(r)`. Adaptors are objects in `std::views::` that store their arguments and produce a view when piped into a range.

```cpp
auto pipeline = xs
              | std::views::filter([](int x) { return x % 2 == 0 ; })
              | std::views::transform([](int x) { return x * x ; })
              | std::views::take(3);
```

Read left to right. Each stage receives the previous view and produces a new one. No allocation, no intermediate vectors. The pipeline is a type whose name is unprintable, which is why `auto` is mandatory in practice.

## Core Adaptors

```cpp
namespace v = std::views;

v::transform(f)         // f(x) for each x
v::filter(pred)         // keep elements where pred(x)
v::take(n)              // first n elements
v::take_while(pred)     // until pred fails
v::drop(n)              // skip first n
v::drop_while(pred)     // skip while pred holds
v::reverse              // back to front, requires bidirectional source
v::keys                 // .first of pair-like
v::values               // .second of pair-like
v::elements<I>          // get<I> of tuple-like
v::join                 // flatten range-of-ranges
v::split(delim)         // tokenise
v::common               // adapt to a common iterator/sentinel pair
```

C++23 added the heavy hitters.

```cpp
v::chunk(n)             // groups of n
v::chunk_by(pred)       // groups while pred(prev, curr) holds
v::slide(n)             // sliding window of size n
v::stride(n)            // every nth element
v::zip(r1, r2, ...)     // tuple of corresponding elements
v::zip_transform(f, ...) // zip then apply f
v::adjacent<N>          // adjacent N-tuples
v::cartesian_product(...) // every combination
v::enumerate            // (index, element) pairs (C++23)
v::repeat(x, n)         // n copies of x
```

A representative C++23 pipeline.

```cpp
auto rolling_avg = prices
                 | v::slide(window)
                 | v::transform([](auto&& w) {
                       return std::ranges::fold_left(w, 0.0, std::plus{}) / w.size();
                   });
```

## Projection Arguments

Range algorithms take an optional **projection**, a function applied to each element before the predicate or comparator runs. Projections eliminate most one-line lambdas.

```cpp
struct Order { int id; long long price_cents; std::string symbol; };
std::vector<Order> book = /* ... */;

// Sort by price without writing a comparator.
std::ranges::sort(book, std::less{}, &Order::price_cents);

// Find the order with id == 42.
auto it = std::ranges::find(book, 42, &Order::id);

// Max-by-price.
auto top = std::ranges::max_element(book, {}, &Order::price_cents);
```

`{}` defaults the comparator to `std::ranges::less`. The third argument is the projection. Member-pointer-to-member is implicitly invocable, so `&Order::price_cents` reads as "look at this field". This idiom is everywhere in modern code.

### Sentinels

A range is `[begin, end)` where `end` does not have to be the same type as `begin`. The end is a **sentinel**, a type that compares equal to the iterator when iteration should stop.

```cpp
struct null_terminated {
    const char* p;
    char operator*() const { return *p; }
    null_terminated& operator++() { ++p; return *this; }
    bool operator==(std::default_sentinel_t) const { return *p == '\0'; }
};
```

This is how `std::views::take_while` and `std::views::istream` express bounds without forcing the source to know its size. Sentinels make C-string iteration, network streams, and infinite generators expressible inside the same iterator model.

### std::ranges Algorithms

Every classical algorithm has a ranges counterpart that takes a range, supports projections, and uses concepts for constraints.

```cpp
std::ranges::sort(v);                          // entire container
std::ranges::sort(v, std::greater{});          // descending
std::ranges::sort(v, {}, &Order::price_cents); // by field
std::ranges::partial_sort(v, v.begin() + 10);  // top 10
std::ranges::nth_element(v, v.begin() + k);    // kth element
std::ranges::stable_partition(v, pred);
std::ranges::unique(v);                        // returns subrange of removed
```

The return type of mutating algorithms is `std::ranges::subrange` rather than a single iterator, which solves the long-standing problem of `std::remove` returning a single iterator and forcing the caller to remember the erase-remove idiom.

```cpp
auto [removed_begin, removed_end] = std::ranges::remove_if(v, is_stale);
v.erase(removed_begin, removed_end);
```

C++23 added `std::ranges::to`, which materialises a view into a container.

```cpp
auto evens = std::views::iota(1, 100)
           | std::views::filter([](int x){ return x % 2 == 0; })
           | std::ranges::to<std::vector>();
```

### Performance Pitfalls

Views are not free of cost. The pitfalls.

**Multi-pass vs single-pass.** `std::views::filter` is a forward range. Its iterator advances by re-running the predicate. Calling `++it` twice on the same position runs the predicate twice. Wrapping a filter in another filter compounds the issue. Profile when stacking three or more filters over millions of elements. A `views::transform | views::filter` is fine, but `views::filter | views::reverse` materialises through bidirectional iteration and may be slower than a manual loop.

**Cached begin.** `filter_view::begin()` caches its result on first call to amortise predicate evaluation. The first call is O(n), subsequent calls are O(1). Range-for handles this correctly. Calling `begin()` directly inside a hot loop does not.

**Reference invalidation.** Views hold references to their source. Modifying the source while iterating a view is undefined behavior, exactly like modifying a vector while holding an iterator into it.

**Compile time.** Heavy view chains expand into nested templates. A pipeline with eight stages can add a noticeable second per translation unit. Production codebases at FAANG-scale push pipelines into `.cpp` files behind type-erased boundaries when they would otherwise be reinstantiated in every header consumer.

### std::generator Integration (C++23)

`std::generator<T>` is a coroutine-based input range. It yields values lazily without manual iterator code.

```cpp
std::generator<int> fibonacci() {
    int a = 0, b = 1;
    while (true) {
        co_yield a;
        std::tie(a, b) = std::pair{b, a + b};
    }
}

auto first_ten = fibonacci()
               | std::views::take(10)
               | std::ranges::to<std::vector>();
```

A generator is a single-pass range, which means it composes with `take`, `filter`, `transform`, `drop`, but not `reverse` or `sort`. The coroutine frame is allocated once, the iterator advances by resuming the coroutine, and the lifetime ends when iteration completes.

## Junior to FAANG / Senior at FAANG

A junior should be comfortable writing `r | filter | transform | to<vector>`, using projections in `ranges::sort`, and reading the `<ranges>` header to discover adaptors. They should know that views are lazy and cheap, and that `std::ranges::to` is the materialization point.

A senior is expected to reason about iterator categories, identify when a pipeline forces multi-pass evaluation, decide between a view chain and a hand-written loop based on profile data, and design APIs that take `std::ranges::range auto&&` instead of specific containers. They should know how `std::generator` interacts with the borrow trait, why `views::filter` is not a `random_access_range`, and how to write a custom view with `std::ranges::view_interface`.
