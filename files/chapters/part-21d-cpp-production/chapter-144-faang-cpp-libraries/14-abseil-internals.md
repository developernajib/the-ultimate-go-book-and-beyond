## Abseil Internals

Abseil is the open-source distillation of Google's internal `//base` and `//util` libraries. Every type in `absl::` exists because the standard library version was either too slow, too unsafe, or arrived a decade too late for Google's workloads. This file walks the internals of the components a senior C++ engineer at Google touches every day.

### Why Abseil Exists at All

The C++ standards committee moves on a 3-year cadence. Google ships hundreds of thousands of binaries a week. When Google needed a faster hash table in 2013, it could not wait for C++17. The result is a library that:

- Tracks the current C++ standard (C++17 minimum as of 2024, moving to C++20).
- Provides a forward-compatibility layer (`absl::string_view`, `absl::optional`, `absl::variant`) that aliased to the std types once they shipped.
- Provides Google-only types that the committee declined or has not yet absorbed (`Cord`, `StatusOr`, `Time`, `Duration`, `flat_hash_map`).
- Compiles cleanly under `-fno-exceptions` and `-fno-rtti`.

The library is built with Bazel. It has no transitive dependencies outside libc++ / libstdc++.

### absl::flat_hash_map (SwissTable)

The single most important Abseil contribution. SwissTable is the hash table design behind `absl::flat_hash_map`, `absl::flat_hash_set`, `absl::node_hash_map`, and the internal Google `dense_hash_map`. The original 2017 CppCon talk by Matt Kulukundis is required viewing.

#### Layout

A SwissTable is one contiguous allocation containing two arrays:

```
[ control_bytes (one byte per slot) | slots (sizeof(value_type) per slot) ]
```

The control byte for slot `i` is one of:

- `0xFF` (kEmpty): slot never occupied.
- `0xFE` (kDeleted, also called tombstone): slot was occupied, now erased.
- `0x80 | h2`: slot occupied, where `h2` is the top 7 bits of the hash. Top bit is 1 to distinguish from sentinels.

#### Lookup Algorithm

Given key `k` with hash `h`:

1. Split `h` into `h1` (57 bits) and `h2` (7 bits).
2. `start = h1 % capacity`, where capacity is `2^n - 1` (always a power of two minus one, so groups of 16 align).
3. Load 16 control bytes starting at `start` into an SSE register (`__m128i`).
4. Compare against a broadcast of `h2` using `_mm_cmpeq_epi8`. The result is a 16-bit mask of candidate slots.
5. For each candidate, compare the actual key. On match, return.
6. If the group contains any `kEmpty` byte, the key is absent. Stop.
7. Otherwise advance to the next group with quadratic probing on group index.

The SIMD comparison gives 16 candidate matches per cycle. On non-x86 (ARM NEON, or scalar fallback), the same logic uses `vceqq_u8` or a portable bit twiddling trick.

#### Why Tombstones Matter

Erase cannot just write `kEmpty` because that would terminate probe sequences for keys that hashed past this slot. Tombstones (`kDeleted`) preserve probe chains. Insertion treats tombstones as available but counts them against the load factor so the table rehashes before tombstones dominate.

Max load factor is 7/8 (87.5%). Higher than `std::unordered_map`'s 1.0 because the SIMD scan absorbs the cost of longer probe chains.

#### Memory Cost

`flat_hash_map<K, V>` stores `std::pair<const K, V>` directly in the slot array. No per-node allocation, no pointer chasing. Compare to `std::unordered_map`: one allocation per insert, one cache miss per lookup, plus the bucket array.

For pointer-stable references, use `absl::node_hash_map`. It allocates each entry separately but keeps the SwissTable control structure for fast lookup.

#### Iterator Invalidation

Any insertion may rehash. Erase invalidates only the erased iterator. Pointers and references to elements are invalidated by rehash for the flat variant. The node variant gives pointer stability across rehash.

### absl::btree_map

A B-tree keyed map. Nodes are wide (typically 256 to 512 bytes, holding 16 to 32 entries depending on key/value size). Compared to `std::map` (red-black tree, one node per entry):

- 4 to 8 times less memory.
- Better cache behavior on iteration and lookup (one node fits in 4 to 8 cache lines, vs one per element).
- Slower individual insert at the high end because shifting within a node is O(node_size).

Use `absl::btree_map` when you need ordered iteration. Use `flat_hash_map` when you need lookup only.

### absl::Cord

A reference-counted rope structure. Designed for the case where you have a 200 MB protobuf message that gets copied between RPC layers, log buffers, and serialization paths.

Internal layout: a tree of nodes where leaves point to immutable byte buffers (`CordRep::Flat` for inline, `CordRep::External` for buffers owned elsewhere). Concatenation, prefix, and substring are O(log n) and copy zero bytes.

Cord has an inline representation for strings under 15 bytes (small string optimization in the tagged pointer).

In gRPC, the request and response payloads can be Cords end-to-end, avoiding copies between the wire format buffer and the parsed message.

### absl::Time and absl::Duration

`absl::Time` is a point on the timeline. `absl::Duration` is a signed length of time. Both are 96-bit values (one 64-bit count of seconds, one 32-bit count of quarter-nanoseconds for Duration, or similar packing for Time).

Why not `std::chrono::system_clock::time_point`? Three reasons:

1. `std::chrono` types do not specify epoch in C++17 (fixed only in C++20).
2. Arithmetic on `system_clock` is not well-defined across leap seconds.
3. Format and parse routines are bolted on. Abseil ships `absl::FormatTime`, `absl::ParseTime`, timezone-aware `absl::TimeZone`.

```cpp
absl::Time now = absl::Now();
absl::Time deadline = now + absl::Seconds(30);
absl::Duration elapsed = absl::Now() - now;
std::cout << absl::FormatTime(now, absl::UTCTimeZone());
```

### absl::StatusOr

A discriminated union of `absl::Status` (an error code with a message and a payload) and a value of type T. The `Status` type has a small-string optimization for the message and uses a single pointer for the OK case (no allocation on success).

```cpp
absl::StatusOr<File> OpenFile(absl::string_view path) {
  int fd = open(std::string(path).c_str(), O_RDONLY);
  if (fd < 0) return absl::ErrnoToStatus(errno, "open failed");
  return File(fd);
}
```

The `RETURN_IF_ERROR` and `ASSIGN_OR_RETURN` macros (from `absl/status/status_macros.h`) are the canonical way to chain `StatusOr` calls without exceptions.

### absl::Mutex with Deadlock Detection

`absl::Mutex` is a counting mutex with an optional deadlock detection mode. When compiled with `-DABSL_INTERNAL_USE_NONPROD_MUTEX`, every Lock and Unlock walks a graph of held mutexes per thread and detects cycles before they deadlock the process.

It also supports condition-style waits without an explicit `condition_variable`:

```cpp
absl::Mutex mu;
int count ABSL_GUARDED_BY(mu) = 0;

void Wait() {
  mu.LockWhen(absl::Condition(+[](int* c) { return *c > 0; }, &count));
  // count > 0 here, mu is held.
  mu.Unlock();
}
```

The thread safety analysis annotations (`ABSL_GUARDED_BY`, `ABSL_LOCKS_EXCLUDED`) are checked statically by Clang. Misuse is a compile error in any TU built with `-Wthread-safety`.

### absl::flags

Command-line flags as global variables, defined with `ABSL_FLAG`:

```cpp
ABSL_FLAG(int32_t, port, 8080, "TCP port to listen on");

int main(int argc, char** argv) {
  absl::ParseCommandLine(argc, argv);
  int port = absl::GetFlag(FLAGS_port);
}
```

Flags are type-safe. They support `--help`, `--helpfull`, `--flagfile`, and a registry that any library can introspect. The internal Google version supports `--undefok` and dynamic reloading from a config service.

### absl::log

Stream-style logging with severity levels:

```cpp
LOG(INFO) << "started, port=" << port;
LOG(ERROR) << "failed: " << status;
LOG_IF(WARNING, retry_count > 3) << "retrying";
VLOG(2) << "verbose detail";
CHECK(ptr != nullptr);
DCHECK_EQ(a, b);
```

`CHECK` is a runtime assertion that abort()s with a stack trace. `DCHECK` is compiled out in optimized builds. `VLOG(n)` is enabled with `--v=n` and is essentially free at the default level (one branch on a global int).

### absl::str_format

A printf-style formatter that is type-safe and faster than `std::ostringstream`. The format string is checked at compile time when wrapped in `absl::ParsedFormat<>`. Supports custom formatters via `AbslFormatConvert`.

```cpp
std::string s = absl::StrFormat("user=%s age=%d", name, age);
```

About 4 to 10 times faster than the equivalent `std::ostringstream` chain in benchmarks. Comparable to `fmt::format`, which is the C++20 standardization.

### Why Google Built Each Replacement

| std type | absl replacement | Reason |
|----------|------------------|--------|
| `std::unordered_map` | `flat_hash_map` | 3 to 5x faster lookup, half the memory |
| `std::map` | `btree_map` | 4 to 8x less memory, faster iteration |
| `std::string` (concatenation) | `Cord` | Zero-copy splicing for large payloads |
| `std::chrono::system_clock` | `Time`, `Duration` | Defined epoch, leap-second sane, formatter included |
| exceptions | `Status`, `StatusOr` | No exceptions allowed in google3 |
| `std::mutex` | `Mutex` | Deadlock detection, condition predicates, TSA annotations |
| `gflags` (third-party) | `flags` | First-party, Bazel-clean, no global init order issues |
| `glog` (older Google) | `log` | Same API, modern internals, no leaked symbols |
| `std::ostringstream` | `StrFormat`, `StrCat` | 4 to 10x faster, compile-time format check |

### Junior to FAANG: When to Reach for absl

A junior engineer drops `absl` everywhere because it is what the codebase uses. A FAANG-track engineer knows which absl type solves which problem, and can defend the choice in code review. Memorize the table above. In an interview, say "I'd use `absl::flat_hash_map` because the values are small and I never need pointer stability, and SwissTable's SIMD probe gives me 5x lookup over `std::unordered_map`." That is the answer that gets you hired.

### Senior at FAANG: Customization Hooks

Senior engineers extend Abseil. The hooks are:

- `AbslHashValue(H state, const T& v)` to make T hashable by `absl::Hash`.
- `AbslStringify(Sink& s, const T& v)` (C++17) to make T loggable and formattable.
- Custom allocators via the `Alloc` template parameter on the hash containers.
- `absl::FunctionRef<R(Args...)>` for non-owning callables on hot paths (no heap, no virtual dispatch overhead).

When you build a new internal library at Google, you wire these in from day one. That is the difference between "I used Abseil" and "I extended Abseil".
