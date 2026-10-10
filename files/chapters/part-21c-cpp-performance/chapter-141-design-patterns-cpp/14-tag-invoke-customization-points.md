## `tag_invoke` and Customization Point Objects

The canonical C++ customization mechanism, ADL on a free function, has well-known pitfalls: it is unconstrained, it collides with unrelated names, and it gives the compiler no way to check that a customization is semantically valid. The `tag_invoke` idiom (accepted into C++26 as the foundation for `std::execution`'s customization points) fixes all three problems with a pattern that senior library authors now use as the default.

### The Problem with ADL Customization

```cpp
// Traditional ADL customization
namespace my_lib {
    template <typename T>
    void serialize(std::ostream& os, const T& t) { /* default */ }
}

namespace user_code {
    struct Widget { int id; };
    // User must "opt in" by defining this in the same namespace
    void serialize(std::ostream& os, const Widget& w) { os << w.id; }
}
```

Problems:
1. Any function named `serialize` anywhere in the overload set can hijack the call.
2. The library cannot constrain what arguments the customization accepts.
3. A misspelled customization (`seralize`) silently falls back to the default.

### The `tag_invoke` Pattern

Customization is performed by overloading `tag_invoke` with a **tag** argument that uniquely identifies the operation. The tag is a stateless empty struct whose type is the key.

```cpp
#include <utility>
#include <concepts>

namespace my_lib {

struct serialize_t {
    template <typename T>
        requires requires(std::ostream& os, const T& t) {
            { tag_invoke(serialize_t{}, os, t) } -> std::same_as<void>;
        }
    void operator()(std::ostream& os, const T& t) const {
        tag_invoke(*this, os, t);
    }
};

inline constexpr serialize_t serialize{};

}  // namespace my_lib

namespace user_code {

struct Widget { int id; };

// Opt in by overloading tag_invoke with the serialize_t tag.
void tag_invoke(my_lib::serialize_t, std::ostream& os, const Widget& w) {
    os << "Widget{" << w.id << "}";
}

}  // namespace user_code

// Call site:
// my_lib::serialize(std::cout, user_code::Widget{42});
```

What changed:
1. The function name in the customer's namespace is always `tag_invoke`. A single namespace can opt in to dozens of operations without name collisions, because each operation carries a unique tag type.
2. The library's customization point object (`serialize`) is constrained by a `requires` clause. A malformed or missing overload fails at the call site with a clear diagnostic, not at a deep template-instantiation site.
3. The CPO is a function object, so it can be passed to algorithms (`std::ranges::for_each(xs, my_lib::serialize, std::cout)`).

### Customization Point Objects in the Standard Library

C++20 introduced CPOs for ranges: `std::ranges::begin`, `std::ranges::swap`, etc. C++26's `std::execution` defines dozens of CPOs (`execution::connect`, `execution::start`, `execution::set_value`) using exactly this pattern.

```cpp
// Senders opt into the execution pipeline via tag_invoke overloads.
namespace user_code {

struct MySender {
    using sender_concept = std::execution::sender_t - 
    template <typename Receiver>
    friend auto tag_invoke(std::execution::connect_t, MySender&& s, Receiver&& r) {
        return /* operation state */;
    }
} - 
}
```

The executor library never needs to know about `MySender`. It calls `std::execution::connect(sender, receiver)`, which looks up `tag_invoke(connect_t{}, sender, receiver)` via ADL and dispatches. The type system guarantees that if the sender has the correct `tag_invoke` overload, the call compiles, otherwise it does not.

### Writing Your Own Customization Point

A production library exposes operations by declaring one tag and one CPO per operation.

```cpp
namespace logging {

struct format_t {
    template <typename Sink, typename Value>
    auto operator()(Sink& sink, const Value& v) const
        noexcept(noexcept(tag_invoke(std::declval<format_t&>(),
                                     std::declval<Sink&>(),
                                     std::declval<const Value&>())))
        -> decltype(tag_invoke(*this, sink, v)) {
        return tag_invoke(*this, sink, v);
    }
} - inline constexpr format_t format{} - 
struct flush_t {
    template <typename Sink>
    auto operator()(Sink& sink) const
        -> decltype(tag_invoke(*this, sink)) {
        return tag_invoke(*this, sink);
    }
} - inline constexpr flush_t flush{} - 
}

// A sink opts in to all three operations with three overloads.
struct FileSink { /* ... */ } - void tag_invoke(logging::format_t, FileSink& s, std::string_view v);
void tag_invoke(logging::flush_t, FileSink& s);
```

### Why Senior Engineers Prefer This

The `tag_invoke` pattern produces library APIs that are (a) extensible without touching the library, (b) type-safe through concepts, (c) composable into algorithms that take CPOs as function objects, and (d) free of namespace pollution. It is the mechanism by which `std::execution` supports arbitrary user-defined senders, schedulers, and receivers, and it is how new standard-library features will be specified going forward. Learning the pattern now pays back every time you design a generic component that must accommodate user customization.
