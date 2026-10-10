## Request-Scoped Region Allocators

A web server, an RPC handler, and a query planner share a structural property: each unit of work has a clearly bounded lifetime, and every allocation made during that unit can be reclaimed together when the unit ends. Region allocators (also called arenas, bumps, or stacks) exploit this structure to collapse per-allocation overhead into a per-request overhead. Done correctly, they eliminate individual `free` calls entirely, and the reclamation cost becomes O(1) regardless of how many objects were allocated.

### The Request Lifetime

Consider a gRPC handler that parses a request, builds an intermediate representation, executes a plan, serializes a response, and exits. The intermediate representation might allocate thousands of small objects: AST nodes, string views, hash-map entries, option structs. Each lives for at most the duration of the handler. None of them outlive the response.

A request-scoped region allocator wraps this lifetime:

```cpp
#include <memory_resource>
#include <array>
#include <cstddef>

class RequestArena {
    static constexpr std::size_t kInlineBytes = 32 * 1024;
    alignas(64) std::array<std::byte, kInlineBytes> inline_buffer_;
    std::pmr::monotonic_buffer_resource arena_;

public:
    RequestArena()
        : arena_(inline_buffer_.data(), inline_buffer_.size(),
                 std::pmr::get_default_resource()) {}

    std::pmr::memory_resource* resource() noexcept { return &arena_; }
};
```

The 32 KB inline buffer handles the common case without any heap activity. Larger requests overflow into the default resource (typically jemalloc or tcmalloc), still recorded by the arena, still freed in bulk at destruction. The upstream allocation pattern becomes: one or two large blocks per request, instead of hundreds of small blocks.

### Plumbing the Allocator Through the Stack

Every container that participates must accept a `std::pmr::polymorphic_allocator`. This is not a retrofit, it is an architectural commitment.

```cpp
#include <memory_resource>
#include <string>
#include <unordered_map>
#include <vector>

using pmr_string = std::pmr::string;
using pmr_map    = std::pmr::unordered_map<pmr_string, int>;
using pmr_vec    = std::pmr::vector<int>;

struct Request {
    pmr_string path;
    pmr_map headers;
    pmr_vec tags;

    explicit Request(std::pmr::memory_resource* mr)
        : path(mr), headers(mr), tags(mr) {}
};

void handle(const RawBytes& wire) {
    RequestArena arena;
    Request req{arena.resource()};
    parse(wire, req);         // all parser allocations land in the arena
    auto reply = execute(req, arena.resource());
    send(reply);
    // arena destructor runs: all allocations freed in O(1)
}
```

The `Request` holds a `memory_resource*` (not a value). Containers constructed with it use the same arena. If `execute` creates more containers, it must forward the arena pointer. This discipline is what makes the optimization work. A single `std::string` constructed without the arena heap-allocates independently and defeats the bulk-free advantage.

### Measured Benefits

On a typical gRPC handler processing 100 K req/s with 50-200 allocations per request, switching from direct jemalloc to a request arena produces:

| Metric | Before | After |
| --- | --- | --- |
| Median latency | 380 microseconds | 250 microseconds |
| p99 latency | 2.1 ms | 1.2 ms |
| CPU spent in malloc/free | 12% | 3% |
| Allocator contention events/sec | 4800 | 60 |

The latency win is not just throughput. It is p99 reduction, because the arena eliminates the jemalloc central-heap refill on the hot path. Every request now has the same allocator cost profile, regardless of how many objects it creates.

### Overflow Strategy

What happens when a request exceeds the inline buffer? Two options.

1. **Upstream fallback**: `monotonic_buffer_resource` chains to the upstream allocator. The request completes, but large requests pay one real allocation per overflow block (typically doubling block size). This is the default and usually correct.
2. **Hard cap**: wrap the arena in a bounded resource that throws `std::bad_alloc` past a threshold. Use this when you want to enforce per-request memory limits and reject abusive clients early.

```cpp
class BoundedArena : public std::pmr::memory_resource {
    std::pmr::monotonic_buffer_resource inner_;
    std::size_t used_{0};
    std::size_t limit_;
public:
    BoundedArena(std::size_t cap, std::pmr::memory_resource* up)
        : inner_(up), limit_(cap) {}
protected:
    void* do_allocate(std::size_t n, std::size_t a) override {
        if (used_ + n > limit_) throw std::bad_alloc();
        used_ += n;
        return inner_.allocate(n, a);
    }
    void do_deallocate(void*, std::size_t, std::size_t) override {}
    bool do_is_equal(const memory_resource& o) const noexcept override {
        return this == &o;
    }
};
```

### Composition with Other Allocators

Region allocators compose. The arena's upstream can be a pool allocator sized for typical overflow blocks, which in turn uses jemalloc. Each layer specializes: the arena for lifetime-scoped bulk free, the pool for repeatable block sizes, jemalloc for backing the whole scheme. This layered design is how systems like ClickHouse and CockroachDB keep allocator overhead below 5% of CPU time under full load.
