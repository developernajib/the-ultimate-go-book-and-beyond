## Buffer Overflow Prevention

A buffer overflow happens when code writes past the end of an allocated buffer. It is not a subtle edge case, it is one of the oldest and most exploited vulnerability classes in computing. Stack overflows can overwrite return addresses, redirecting execution to attacker-controlled code. Heap overflows can corrupt allocator metadata or adjacent objects. Both have been used to compromise production systems from Morris Worm (1988) to Chrome renderer exploits in 2024.

Go slices carry their length and capacity, and the runtime enforces bounds on every index operation. There is no equivalent automatic protection in C++, you must build it into your design.

### Stack Buffer Overflows

The vulnerable pattern is any stack-allocated array combined with an unbounded write.

```cpp
// Vulnerable: no length check
void process_input(const char* user_input) {
    char buf[64];
    strcpy(buf, user_input);   // copies until null terminator, no bounds check
    // if strlen(user_input) >= 64, return address is overwritten
}
```

`strncpy` is commonly proposed as the fix but is not actually safe: it does not guarantee null termination when the source is longer than the limit, leaving the buffer without a terminator and the next read running past the end.

```cpp
// Still dangerous: no null terminator if len(src) >= 64
strncpy(buf, user_input, 64);
buf[63] = '\0';  // must add this manually, easy to forget
```

The correct fix eliminates the raw array entirely.

```cpp
// Safe: std::string manages its own buffer
void process_input(const std::string& user_input) {
    // No fixed-size buffer. No overflow possible.
    if (user_input.size() > MAX_INPUT) {
        throw std::invalid_argument("input too large");
    }
    // use user_input directly
}
```

For C APIs that require `char*`, use `std::string::data()` with an explicitly sized operation and a known-good length:

```cpp
void fill_fixed_field(const std::string& name, char out[32]) {
    size_t copy_len = std::min(name.size(), size_t{31});
    std::memcpy(out, name.data(), copy_len);
    out[copy_len] = '\0';
}
```

### Heap Buffer Overflows

Off-by-one errors on heap allocations are just as dangerous as stack overflows, they corrupt heap metadata and adjacent objects.

```cpp
// Vulnerable: off-by-one, writes one past the end
void build_array(size_t n) {
    int* arr = new int[n];
    for (size_t i = 0; i <= n; ++i) {  // <= instead of <
        arr[i] = static_cast<int>(i);   // arr[n] is out-of-bounds
    }
    delete[] arr;
}
```

`std::vector` with bounds-checked access eliminates this.

```cpp
// Safe: .at() throws std::out_of_range on invalid index
void build_array(size_t n) {
    std::vector<int> arr(n);
    for (size_t i = 0; i < arr.size(); ++i) {
        arr.at(i) = static_cast<int>(i);  // bounds-checked
    }
    // no manual delete
}

// In hot paths where you've already validated bounds, operator[] is fine
void fill_validated(std::vector<uint8_t>& buf, size_t offset, uint8_t val) {
    if (offset >= buf.size()) throw std::out_of_range("offset out of bounds");
    buf[offset] = val;  // safe: validated above
}
```

### `std::span` as a Safe Buffer Interface (C++20)

Raw pointer + length pairs are a recurring source of overflow bugs. The caller passes a size that doesn't match the actual buffer, and the callee trusts it. `std::span` bundles pointer and length into one type, making the relationship explicit and enabling iteration without pointer arithmetic.

```cpp
#include <span>
#include <cstdint>

// Old pattern: pointer + length, mismatches are common
void encrypt_block_unsafe(const uint8_t* data, size_t len);

// New pattern: span carries its own length
void encrypt_block(std::span<const uint8_t> data) {
    if (data.size() != 16) {
        throw std::invalid_argument("AES block must be 16 bytes");
    }
    for (auto byte : data) {
        // Range-based for, no index arithmetic, no overflow
        (void)byte;
    }
}

// Callers: array, vector, or raw pointer+size all convert naturally
void caller_example() {
    std::array<uint8_t, 16> block{};
    encrypt_block(block);                           // array → span

    std::vector<uint8_t> buf(16);
    encrypt_block(buf);                             // vector → span

    uint8_t raw[16]{};
    encrypt_block(std::span{raw, 16});              // raw → span, explicit size
}
```

Sub-spans let you slice without new pointers:

```cpp
void process_chunks(std::span<const uint8_t> data, size_t chunk_size) {
    while (!data.empty()) {
        auto chunk = data.first(std::min(data.size(), chunk_size));
        encrypt_block(chunk);
        data = data.subspan(chunk.size());          // advance without pointer arithmetic
    }
}
```

### Validating `memcpy` and `memmove`

Even with modern idioms, low-level operations appear in serialization, networking, and codec code. Always validate the size parameter against both source and destination capacity.

```cpp
// Vulnerable: trusts caller-supplied length
void deserialize_unsafe(void* dst, const void* src, size_t len) {
    std::memcpy(dst, src, len);  // len may exceed dst capacity
}

// Safe: both bounds checked before copy
bool deserialize_safe(std::span<uint8_t> dst,
                      std::span<const uint8_t> src,
                      size_t requested_len) {
    if (requested_len > src.size() || requested_len > dst.size()) {
        return false;  // reject before touching memory
    }
    std::memcpy(dst.data(), src.data(), requested_len);
    return true;
}
```

### Compiler and Runtime Detection

`_FORTIFY_SOURCE=2` enables compile-time and runtime checks for calls to common C functions (`memcpy`, `strcpy`, `sprintf`). It is free to enable and catches a large subset of overflows when the buffer size is statically known.

```bash
# Add to all production builds
-D_FORTIFY_SOURCE=2 -O2
```

AddressSanitizer catches overflows that `_FORTIFY_SOURCE` misses, including heap overflows where buffer size is only known at runtime.

```bash
# Enable during development and CI
clang++ -fsanitize=address -fno-omit-frame-pointer -g ...
```

ASan output names the exact allocation site, the overflow location, and the stack trace. Run your full test suite under ASan. Fix every report, there are no benign buffer overflows.

libFuzzer finds overflows that your test suite misses by generating adversarial inputs automatically.

```cpp
// fuzz_json.cpp, libFuzzer entry point
#include <cstdint>
#include <cstddef>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    // Feed arbitrary bytes into your parser
    parse_json(std::string_view{reinterpret_cast<const char*>(data), size});
    return 0;
}
```

```bash
clang++ -fsanitize=address,fuzzer fuzz_json.cpp parser.cpp -o fuzz_json
./fuzz_json -max_len=65536 corpus/
```

### Production Rules

Never expose a raw pointer + size pair in a public API. Use `std::span` for read-only views, `std::span<uint8_t>` for writable views. Validate every caller-supplied length before arithmetic or memory operations. Enable `_FORTIFY_SOURCE=2` in all builds. Run ASan in CI. Fuzz any code that parses external input.

In Go, this entire section is enforced by the runtime, slice bounds checking is unconditional and cannot be disabled except with `unsafe`. In C++, the same guarantees require deliberate design.

---
