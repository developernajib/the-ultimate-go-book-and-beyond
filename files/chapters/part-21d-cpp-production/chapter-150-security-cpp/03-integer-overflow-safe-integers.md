## Integer Overflow: Safe Integer Arithmetic

Integer overflow is responsible for a deceptively large fraction of memory corruption bugs. The pattern is always the same: user-controlled integer arithmetic produces a value smaller than intended, which is then used as an allocation size or array length. The allocation succeeds with a tiny buffer, and the subsequent write, sized to the original larger value, overflows into adjacent memory.

The classic example is `malloc(len * sizeof(int))`. If `len` is an attacker-controlled value near `SIZE_MAX / 4`, the multiplication wraps to a small number on 32-bit systems or overflows to a manageable allocation on 64-bit systems. The allocation succeeds. The copy loop writes `len * 4` bytes into a much smaller buffer.

### Signed Overflow Is Undefined Behavior

C++ signed integer overflow is not just a wrong value, it is undefined behavior. The compiler is permitted to assume it cannot occur and to optimize accordingly. This produces code that silently drops overflow checks the programmer added to catch the problem.

```cpp
// The overflow check that doesn't work
bool would_overflow_signed(int a, int b) {
    // UB: compiler assumes (a + b) does not overflow
    // With optimization, this branch may be eliminated entirely
    if (a + b < a) {
        return true;  // unreachable after optimizer removes it
    }
    return false;
}

// Demonstration: signed overflow in size calculation
void vulnerable_allocation(int user_len) {
    // If user_len = 536870912 (2^29), then user_len * 4 = 2^31, wraps to negative
    // cast to size_t: 2^31 as size_t is 2147483648 on 64-bit, still large, but
    // on a 32-bit system this wraps to 0 or a small value
    int buf_size = user_len * 4;          // UB if user_len > INT_MAX/4
    char* buf = new char[buf_size];       // tiny allocation
    std::memcpy(buf, source, user_len * 4);  // massive write, heap overflow
    delete[] buf;
}
```

### Detecting Overflow with Builtins

GCC and Clang provide `__builtin_*_overflow` builtins that perform checked arithmetic in a single instruction on most architectures. They are the correct tool for security-sensitive arithmetic.

```cpp
#include <stdexcept>
#include <cstdint>
#include <cstdlib>

// Safe multiplication for allocation sizing
size_t safe_multiply(size_t a, size_t b) {
    size_t result;
    if (__builtin_mul_overflow(a, b, &result)) {
        throw std::overflow_error("size_t multiplication overflow");
    }
    return result;
}

// Safe addition
size_t safe_add(size_t a, size_t b) {
    size_t result;
    if (__builtin_add_overflow(a, b, &result)) {
        throw std::overflow_error("size_t addition overflow");
    }
    return result;
}

// Safe allocation with checked size arithmetic
void* safe_alloc_array(size_t count, size_t element_size) {
    size_t total = safe_multiply(count, element_size);
    void* ptr = std::malloc(total);
    if (!ptr) throw std::bad_alloc();
    return ptr;
}

// Usage in a real parser
std::vector<uint32_t> parse_array(const uint8_t* data, size_t count) {
    if (count > 1'000'000) {
        throw std::invalid_argument("array count exceeds limit");
    }
    // Even with the limit, verify arithmetic before allocation
    size_t byte_size = safe_multiply(count, sizeof(uint32_t));
    std::vector<uint32_t> result(count);  // std::vector handles this internally too
    std::memcpy(result.data(), data, byte_size);
    return result;
}
```

`__builtin_add_overflow`, `__builtin_sub_overflow`, and `__builtin_mul_overflow` work for any integer type, `int`, `long`, `size_t`, `int64_t`. They compile to a single `adds`/`muls` instruction with overflow flag check on x86-64 and ARM.

### The SafeInt Library (Microsoft)

For codebases where arithmetic-heavy code must be auditable, Microsoft's SafeInt library wraps integer types in a template that throws on overflow. It works with MSVC, GCC, and Clang.

```cpp
#include <SafeInt.hpp>

// Every arithmetic operation is checked, throws SafeIntException on overflow
void safe_buffer_operations(size_t user_count) {
    SafeInt<size_t> count(user_count);

    // Multiplication: throws if count * 4 overflows size_t
    SafeInt<size_t> byte_size = count * sizeof(uint32_t);

    // Addition: throws if byte_size + HEADER_SIZE overflows
    SafeInt<size_t> total = byte_size + size_t{16};  // 16-byte header

    void* buf = std::malloc(static_cast<size_t>(total));
    if (!buf) throw std::bad_alloc();

    // ... use buf ...
    std::free(buf);
}

// SafeInt comparison: prevents sign-confusion bugs
void compare_safe(int signed_val, size_t unsigned_val) {
    SafeInt<int> sv(signed_val);
    // Comparing SafeInt<int> with size_t is safe: properly handles sign
    if (sv < 0 || SafeInt<size_t>(signed_val) > unsigned_val) {
        throw std::invalid_argument("invalid range");
    }
}
```

### Unsigned Wraparound

Unsigned integer wraparound is not UB, but it is a common logic error, particularly in length calculations and loop bounds.

```cpp
// Unsigned underflow: if size < header_len, result wraps to near SIZE_MAX
size_t payload_len(size_t total_size, size_t header_len) {
    return total_size - header_len;  // wraps if header_len > total_size
}

// Safe: validate before subtracting
size_t safe_payload_len(size_t total_size, size_t header_len) {
    if (header_len > total_size) {
        throw std::invalid_argument("header larger than packet");
    }
    return total_size - header_len;
}

// Also dangerous: decrementing an unsigned loop counter
void bad_reverse_loop(size_t n) {
    for (size_t i = n - 1; i >= 0; --i) {  // infinite loop: i wraps at 0
        process(i);
    }
}

// Safe: use signed index or restructure
void safe_reverse_loop(size_t n) {
    for (size_t i = n; i > 0; --i) {
        process(i - 1);  // adjust inside loop
    }
}
```

### Numeric Limits and Input Validation

For any integer that arrives from an external source, network, file, user input, establish bounds before arithmetic.

```cpp
#include <limits>
#include <stdexcept>

struct PacketHeader {
    uint32_t payload_length;
    uint32_t item_count;
};

void validate_header(const PacketHeader& hdr) {
    constexpr uint32_t MAX_PAYLOAD = 64 * 1024;          // 64 KB
    constexpr uint32_t MAX_ITEMS   = 4096;

    if (hdr.payload_length > MAX_PAYLOAD) {
        throw std::invalid_argument("payload_length exceeds maximum");
    }
    if (hdr.item_count > MAX_ITEMS) {
        throw std::invalid_argument("item_count exceeds maximum");
    }
    // After validation, arithmetic on these values is safe
    // because limits are chosen to avoid overflow in subsequent calculations
}
```

### UBSan: Catching Overflow in Tests

UBSan (`-fsanitize=undefined`) catches signed integer overflow, shift overflow, and integer-to-pointer casts at runtime. Enable it alongside ASan in your CI test runs.

```bash
clang++ -fsanitize=address,undefined,signed-integer-overflow \
        -fsanitize-recover=all \
        -g -O1 \
        your_code.cpp -o test_binary
./test_binary

# UBSan output on overflow:
# your_code.cpp:47:20: runtime error: signed integer overflow:
# 2147483647 + 1 cannot be represented in type 'int'
```

In Go, integer-to-slice-index operations panic on overflow, and slice lengths use `int` which is architecture-native size. Go does not have automatic checked arithmetic for general integer operations, a similar vulnerability in Go would require explicit bounds checks. The critical difference is that Go's memory model makes overflow-induced allocation bugs non-exploitable in most cases: the allocator will always produce a correctly-sized slice for the value passed to `make`.

---
