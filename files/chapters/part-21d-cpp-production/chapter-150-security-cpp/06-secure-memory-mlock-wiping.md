## Secure Memory: mlock and Memory Wiping

Applications that handle cryptographic key material, passwords, session tokens, and private keys face a threat model that most application code ignores: sensitive data does not live only inside your process. It can escape through the operating system's virtual memory subsystem in ways that survive process termination.

When physical RAM is under pressure, the OS swaps memory pages to disk. A page containing a 32-byte AES key may sit in a swap file for days, readable by root, survives system crashes, and persists across reboots until overwritten. Core dumps, generated when a process crashes, contain the entire address space: every key, token, and decrypted payload in memory at crash time. And when `free()` or `delete` releases memory, the allocator does not zero it: the key bytes sit in the freed block until the next allocation overwrites them.

Go's standard library does not address this directly. Third-party packages like `memguard` and `avo` exist for Go, but they are not idiomatic. In C++, the POSIX and platform APIs for secure memory are mature and widely used. libsodium wraps them in a portable, idiomatic interface.

### `mlock`: Preventing Swap

`mlock()` marks a range of virtual memory as non-swappable. The OS pins the physical pages, preventing them from being written to swap.

```cpp
#include <sys/mman.h>
#include <cstring>
#include <stdexcept>

class SecureBuffer {
    void*  data_ = nullptr;
    size_t size_ = 0;

public:
    explicit SecureBuffer(size_t size) : size_(size) {
        // Use mmap for page-aligned allocation, mlock requires page alignment
        data_ = mmap(nullptr, size_,
                     PROT_READ | PROT_WRITE,
                     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (data_ == MAP_FAILED) {
            throw std::runtime_error("mmap failed");
        }

        // Lock pages, prevent swap to disk
        if (mlock(data_, size_) != 0) {
            munmap(data_, size_);
            // Non-fatal on some systems (unprivileged process, limit exceeded)
            // Log and continue rather than throwing in non-security-critical path
            throw std::runtime_error("mlock failed: may lack RLIMIT_MEMLOCK");
        }

        // Exclude from core dumps
        madvise(data_, size_, MADV_DONTDUMP);
    }

    ~SecureBuffer() {
        wipe();
        if (mlock(data_, size_) == 0) {
            munlock(data_, size_);
        }
        munmap(data_, size_);
    }

    SecureBuffer(const SecureBuffer&) = delete;
    SecureBuffer& operator=(const SecureBuffer&) = delete;

    void* data() { return data_; }
    const void* data() const { return data_; }
    size_t size() const { return size_; }

    void wipe() {
        if (data_) sodium_memzero(data_, size_);  // guaranteed not optimized away
    }
};

// Usage: AES key that never reaches swap
void load_key(SecureBuffer& key_buf) {
    // Read key from hardware security module, environment, or key file
    // Key material stays in locked pages for the duration
    auto* key = static_cast<uint8_t*>(key_buf.data());
    read_key_from_hsm(key, key_buf.size());
}
```

`mlock` limits apply: unprivileged processes on Linux typically have a default `RLIMIT_MEMLOCK` of 64 KB. Systems handling significant key material should raise this limit or run with `CAP_IPC_LOCK`. libsodium's `sodium_mlock` handles this transparently and falls back gracefully.

### Memory Wiping: The Optimizer Problem

`memset(buf, 0, sizeof(buf))` is the obvious way to clear sensitive data. It is not safe. Modern compilers perform dead store elimination: if they can determine that `buf` is not read after the `memset`, they remove the call entirely, because zeroing memory that nobody reads is a no-op from the program's perspective.

```cpp
void unsafe_key_cleanup(uint8_t* key, size_t len) {
    // The compiler may eliminate this entirely
    //, the key buffer is "dead" after this function returns
    std::memset(key, 0, len);
}

// Compiler output after optimization:
// unsafe_key_cleanup:
//     ret         # memset removed as dead store
```

This is not a compiler bug. It is correct optimization applied to code that looks, from the compiler's perspective, like wasted work. Preventing it requires defeating the optimizer's analysis.

```cpp
#include <sodium.h>  // provides sodium_memzero, the easiest solution

// Option 1: libsodium, guaranteed not optimized away, portable
void secure_wipe_sodium(void* buf, size_t len) {
    sodium_memzero(buf, len);
}

// Option 2: explicit_bzero (glibc, OpenBSD), OS-provided guarantee
void secure_wipe_bzero(void* buf, size_t len) {
    explicit_bzero(buf, len);
}

// Option 3: memset_s (C11 Annex K), standard but not universally available
void secure_wipe_memset_s(void* buf, size_t len) {
    memset_s(buf, len, 0, len);  // guaranteed to not be elided
}

// Option 4: volatile pointer loop, portable, compiler-independent
void secure_wipe_volatile(void* buf, size_t len) {
    volatile uint8_t* vbuf = static_cast<uint8_t*>(buf);
    for (size_t i = 0; i < len; ++i) {
        vbuf[i] = 0;
    }
    // Memory barrier to prevent reordering
    std::atomic_thread_fence(std::memory_order_seq_cst);
}

// Option 5: SecureZeroMemory (Windows)
#ifdef _WIN32
#include <windows.h>
void secure_wipe_windows(void* buf, size_t len) {
    SecureZeroMemory(buf, len);
}
#endif
```

The recommended approach is libsodium's `sodium_memzero` in cross-platform code, and `explicit_bzero` on Linux/BSD where libsodium is unavailable.

### `sodium_mlock` and `sodium_munlock`

libsodium provides a single function that combines `mlock` + `MADV_DONTDUMP` in a portable interface:

```cpp
#include <sodium.h>

struct KeyMaterial {
    uint8_t encryption_key[crypto_secretbox_KEYBYTES];
    uint8_t signing_key[crypto_sign_SECRETKEYBYTES];
};

KeyMaterial* allocate_key_material() {
    auto* km = static_cast<KeyMaterial*>(
        sodium_malloc(sizeof(KeyMaterial))
    );
    // sodium_malloc: allocates with guard pages, mlock, MADV_DONTDUMP
    // Fills with 0xDB in debug builds to detect use-before-init
    if (!km) throw std::bad_alloc();
    return km;
}

void release_key_material(KeyMaterial* km) {
    // sodium_free: zeros memory, removes guard pages, unlocks, frees
    sodium_free(km);
}
```

`sodium_malloc` is the highest-level secure allocation API: it places the allocation between two guard pages, locks the pages, excludes them from core dumps, and zeros on free. Use it for all long-lived key material.

### Guard Pages

A guard page is a page mapped with `PROT_NONE`, any read or write causes a segfault (SIGSEGV). Placing guard pages before and after sensitive buffers turns out-of-bounds accesses into immediate crashes rather than silent corruption.

```cpp
#include <sys/mman.h>
#include <cstdlib>
#include <cstring>

constexpr size_t PAGE_SIZE = 4096;

struct GuardedBuffer {
    void*  usable = nullptr;    // the actual buffer, between guard pages
    void*  mapping = nullptr;   // full mmap region
    size_t total_size = 0;

    GuardedBuffer(size_t data_size) {
        // Round up to page boundary
        size_t data_pages = (data_size + PAGE_SIZE - 1) / PAGE_SIZE;
        size_t data_bytes = data_pages * PAGE_SIZE;

        // Allocate: guard_page | data_pages | guard_page
        total_size = PAGE_SIZE + data_bytes + PAGE_SIZE;
        mapping = mmap(nullptr, total_size,
                       PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (mapping == MAP_FAILED) throw std::bad_alloc();

        // Guard page before data
        mprotect(mapping, PAGE_SIZE, PROT_NONE);

        usable = static_cast<uint8_t*>(mapping) + PAGE_SIZE;

        // Guard page after data
        mprotect(static_cast<uint8_t*>(mapping) + PAGE_SIZE + data_bytes,
                 PAGE_SIZE, PROT_NONE);

        mlock(usable, data_bytes);
        madvise(usable, data_bytes, MADV_DONTDUMP);
    }

    ~GuardedBuffer() {
        if (usable) sodium_memzero(usable, PAGE_SIZE);
        munmap(mapping, total_size);
    }
};
```

### Core Dump Exclusion

Even without swapping, a process crash produces a core dump that contains all memory. On Linux, `MADV_DONTDUMP` excludes specific pages from core dumps:

```cpp
// Exclude sensitive region from core dumps
void protect_from_coredump(void* buf, size_t len) {
    if (madvise(buf, len, MADV_DONTDUMP) != 0) {
        // Log warning, non-fatal, but document the risk
        std::cerr << "WARN: MADV_DONTDUMP failed, keys may appear in core dumps\n";
    }
}

// Also: limit core dump size at process level
#include <sys/resource.h>
void disable_core_dumps() {
    struct rlimit rl = {0, 0};
    setrlimit(RLIMIT_CORE, &rl);
}
```

### Putting It Together: A Secure Key Container

A secure key container combines the pieces from this section: memory locked against swapping with `mlock`, guaranteed wiping on destruction, and no copies, so key material has exactly one, erasable home in the process.
```cpp
class SecureKey {
    uint8_t* data_;
    size_t   size_;
    bool     locked_ = false;

public:
    explicit SecureKey(size_t size)
        : data_(static_cast<uint8_t*>(sodium_malloc(size)))
        , size_(size)
    {
        if (!data_) throw std::bad_alloc();
        // sodium_malloc already: mlocks, MADV_DONTDUMP, guard pages
    }

    ~SecureKey() {
        sodium_free(data_);  // zeros memory before freeing
    }

    SecureKey(const SecureKey&) = delete;
    SecureKey& operator=(const SecureKey&) = delete;

    void fill_random() {
        randombytes_buf(data_, size_);
    }

    std::span<const uint8_t> view() const {
        return {data_, size_};
    }

    std::span<uint8_t> writable_view() {
        return {data_, size_};
    }
};
```

---
