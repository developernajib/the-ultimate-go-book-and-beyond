## Custom String Allocators and SSO

Strings are the most common heap allocation in most C++ programs. A web server parses thousands of header strings per request. A compiler holds millions of identifier strings. A database holds billions of column strings. The default `std::string` is heap-backed for non-trivial sizes, and that heap traffic dominates many workloads. Two strategies push back: small-string optimization (avoid the heap entirely for short strings) and string interning (share storage for repeated strings).

### SSO in libc++ vs libstdc++

Small-string optimization stores short strings inline in the `std::string` object itself, avoiding the heap. The implementation differs between standard libraries.

libc++ (Clang's standard library, default on macOS and FreeBSD): SSO capacity is 22 bytes on 64-bit. The `std::string` object is 24 bytes. The layout uses one bit to discriminate short vs long, and on x86-64 packs the short-mode size into the high byte.

libstdc++ (GCC's standard library, default on Linux): SSO capacity is 15 bytes on 64-bit. The `std::string` object is 32 bytes. The layout reserves an inline buffer plus a pointer that points into the buffer for short strings.

| Library | sizeof(std::string) | SSO capacity | Layout discrimination |
|------------|---------------------|--------------|---------------------------|
| libc++ | 24 | 22 | High bit of size byte |
| libstdc++ | 32 | 15 | Pointer != self |
| MSVC STL | 32 | 15 | Pointer != self |

This matters in two ways.

First, code that depends on `sizeof(std::string)` is non-portable. Padding decisions in your structs depend on which library you are using.

Second, the SSO threshold determines the heap-traffic win. On libc++ a string of "Content-Type: application/json" (32 chars) misses SSO. On libstdc++ even a 16-char string misses SSO. The cutoff matters for HTTP-header-heavy workloads.

### COW Was Removed

Pre-C++11 some implementations of `std::string` used copy-on-write. Multiple `std::string` instances shared a buffer with a refcount, copy was O(1). Modification copied the buffer first.

C++11 broke COW in two ways. `data()` returning a non-const pointer would have to trigger a copy on call, which hidden refcounting could not handle without locking on every iterator dereference. And `noexcept` move constructors required transferring without locking refcount machinery.

GCC kept COW until version 5 with `_GLIBCXX_USE_CXX11_ABI=0`. Since GCC 5, libstdc++ uses non-COW (the SSO layout above). Ancient binaries linked against the old ABI may still use COW, if you see `std::__cxx11::basic_string` symbols you have the new ABI, otherwise the old one. Prefer the new ABI, the COW version locks per copy-construct on multi-threaded workloads.

### String Interning

Many strings repeat. Compiler identifiers, JSON keys, HTTP headers, log levels, all repeat thousands of times across a process. Interning stores each unique string once and hands out pointers (or handles) to the canonical copy.

```cpp
class StringInterner {
    std::unordered_set<std::string> pool_;
    mutable std::shared_mutex mu_;

public:
    std::string_view intern(std::string_view s) {
        {
            std::shared_lock g(mu_);
            auto it = pool_.find(std::string(s));  // unfortunate temp
            if (it != pool_.end()) return *it;
        }
        std::unique_lock g(mu_);
        auto [it, inserted] = pool_.emplace(s);
        return *it;
    }
};
```

This works but has costs. The `std::unordered_set<std::string>::find` cannot directly take a `string_view` until C++20's heterogeneous lookup. Pre-C++20 you copy the input on every lookup. Mitigation: switch to `absl::flat_hash_set<std::string>` with heterogeneous hash, or implement transparent comparators carefully.

For C++20:

```cpp
struct StringHash {
    using is_transparent = void;
    size_t operator()(std::string_view sv) const noexcept {
        return std::hash<std::string_view>{}(sv);
    }
    size_t operator()(const std::string& s) const noexcept {
        return std::hash<std::string_view>{}(s);
    }
};

struct StringEq {
    using is_transparent = void;
    bool operator()(std::string_view a, std::string_view b) const noexcept {
        return a == b;
    }
    // (further overloads for string vs string_view if needed)
};

std::unordered_set<std::string, StringHash, StringEq> pool;
auto it = pool.find(std::string_view{"key"});  // no temporary string
```

### Arena-Backed StringPiece

Google's `absl::string_view` (and the older `StringPiece`) is a non-owning view: `(const char*, size_t)`. It points into storage someone else owns. Combined with an arena, you get cheap, lifetime-bounded strings.

```cpp
class StringArena {
    BumpAllocator alloc_;

public:
    std::string_view intern(std::string_view s) {
        char* p = static_cast<char*>(alloc_.allocate(s.size(), 1));
        std::memcpy(p, s.data(), s.size());
        return {p, s.size()};
    }
};
```

No SSO. No reference counting. Fastest possible alloc-and-copy. Lifetime is the arena's lifetime, no shorter, no longer. For request-scoped processing this is unbeatable: every string the request handler creates lives in the request arena and dies when the request finishes.

The trade: equal strings are not deduplicated. If you have a million requests all with the header "application/json", you allocate that string a million times. For dedup, layer an interner on top.

### Combined: Interning Arena

```cpp
class InterningArena {
    BumpAllocator alloc_;
    absl::flat_hash_set<std::string_view> pool_;

public:
    std::string_view intern(std::string_view s) {
        if (auto it = pool_.find(s); it != pool_.end()) return *it;
        char* p = static_cast<char*>(alloc_.allocate(s.size(), 1));
        std::memcpy(p, s.data(), s.size());
        std::string_view stored{p, s.size()};
        pool_.insert(stored);
        return stored;
    }
};
```

Single arena owns the bytes. Hash set owns the dedup index. Lookup is one hash + one comparison. Insertion is one alloc + one memcpy + one hash insert.

For dictionary-heavy workloads (compilers, parsers, query engines) this is the standard pattern. Intern every identifier on first sight, work with `string_view` everywhere downstream.

### Rope Strings

For very long strings with frequent inserts and deletes, the contiguous-buffer model of `std::string` falls apart. Inserting at the start of a 1 MiB string copies all 1 MiB. Rope strings (text editors, code formatters, large concatenation pipelines) store strings as trees of small chunks, making mid-string edits O(log n).

```cpp
class Rope {
    struct Node {
        bool is_leaf;
        size_t size;
        union {
            struct { Node* left; Node* right; } inner;
            char data[64];
        };
    };
    Node* root_;
    // ...
};
```

Production-grade ropes are nontrivial: balancing, concatenation, slicing, iterator stability. Use an existing implementation (libstdc++'s `__gnu_cxx::rope`, Boost's `flat_rope`, or per-domain libraries) rather than rolling your own.

For most applications, `std::string` plus careful use of `reserve` and `string_view` is enough. Reach for ropes only when you have measured the editing-cost problem and confirmed it dominates.

### When SSO Loses

SSO is great for short strings. It is wasteful for long strings.

- Copying a long `std::string` copies 24 (libc++) or 32 (libstdc++) bytes of overhead plus a heap allocation. The 24/32 bytes are tiny, but hot paths that touch many strings touch them all.
- A vector of long strings has SSO capacity sitting unused inside each element. For 1 million strings averaging 200 bytes, you waste 22-32 MiB of overhead.
- SSO inhibits some optimizations. The discriminator bit means `data()` is a branch. Hot loops over many strings see the branch in their inner loop.

For workloads dominated by long strings, consider:

- `std::vector<char>` plus offset/length pairs into it. Equivalent to an arena but with explicit indexing.
- A "tagged pointer" string type: 64 bits, top bits are a length, low bits are a pointer or inline data.
- `absl::Cord`: Google's segmented-string type, designed for very long strings and zero-copy concatenation.

### The Anti-Pattern: Substring Allocation

```cpp
// Bad: allocates a new string per substring.
for (auto& field : split(request.url(), '/')) {
    if (field == "api") { ... }
}
```

`split` returning `std::vector<std::string>` allocates once per field. The strings are short. They die at the end of the loop. Allocator is hot. Heap is dirty.

Fix: return `std::vector<std::string_view>` over the original buffer. Zero allocations.

```cpp
std::vector<std::string_view> split_view(std::string_view s, char delim) {
    std::vector<std::string_view> out;
    size_t start = 0;
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == delim) {
            out.emplace_back(s.data() + start, i - start);
            start = i + 1;
        }
    }
    out.emplace_back(s.data() + start, s.size() - start);
    return out;
}
```

The output `vector` still allocates but holds 16-byte views, not arbitrary-length strings. Allocation count and heap pressure drop by 90%+ on header-parsing workloads.

### Junior to FAANG

A junior engineer uses `std::string` everywhere and is surprised when allocator profiling shows 80% of allocations are short strings. A FAANG-grade engineer interns repeated strings into an arena, uses `string_view` for non-owning slices, knows the SSO cutoff of their standard library and codes accordingly, and reserves capacity on `std::string` when the final size is knowable. They also know when to reach for `absl::Cord` versus when `std::string` is fine, and they never write a hand-rolled rope without first checking whether the standard or third-party library has one.
