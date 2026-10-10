## Binary Hardening: Stack Canaries, ASLR, PIE, RELRO, CFI

Memory safety bugs in C++ code create vulnerabilities. Binary hardening techniques do not fix the bugs, they make the bugs harder to exploit. A stack overflow that would directly overwrite a return address becomes a harder target when canaries are present. A code execution primitive that depends on known addresses fails against ASLR and PIE. A vtable hijacking attack fails against CFI. These defenses are independent layers: defeating one does not defeat the others.

Chrome, Firefox, Android, and iOS all ship with every hardening technique in this section enabled. For any binary that processes untrusted input, which is most production software, these are baseline requirements, not optional extras.

### Stack Canaries: `-fstack-protector-strong`

A stack canary is a random value placed on the stack between the local variables and the saved return address. Before executing `ret`, the compiler inserts a check: if the canary value has changed, the stack was overwritten, and the program terminates.

```cpp
// What the compiler generates around this function:
void process_command(const char* input) {
    char buf[64];
    // ...
}

// Compiler output (conceptual):
void process_command(const char* input) {
    uintptr_t canary = __stack_chk_guard;  // random value set at startup
    char buf[64];
    // ... function body ...
    if (canary != __stack_chk_guard) {
        __stack_chk_fail();  // terminate immediately, do not return
    }
}
```

The three protection levels:

- `-fstack-protector`: only protects functions with char arrays >= 8 bytes, too narrow
- `-fstack-protector-all`: protects all functions, adds overhead to every call
- `-fstack-protector-strong`: protects functions with arrays, address-taken locals, or calls to `alloca`, the correct choice

```cmake
target_compile_options(myapp PRIVATE -fstack-protector-strong)
```

Canaries can be bypassed if the attacker has an information leak that reveals the canary value, hence why canaries are a layer, not a complete defense.

### ASLR and PIE

ASLR (Address Space Layout Randomization) is an OS-level feature that randomizes the base addresses of the stack, heap, and shared libraries on each process run. An attacker who needs to jump to a specific address, a `system()` call, a ROP gadget, a shellcode buffer, must guess or leak the address first.

ASLR only randomizes shared libraries and stack/heap. The executable itself (code segment) is at a fixed address unless compiled as a Position-Independent Executable (PIE).

```bash
# Without PIE: the executable code is at a fixed address
# ASLR randomizes stack and heap, but not the executable itself
# Attacker can use gadgets in the binary at known addresses

# Check whether a binary is PIE:
readelf -h ./mybinary | grep Type
# ET_EXEC = not PIE (fixed address)
# ET_DYN  = PIE (randomized)

file ./mybinary
# mybinary: ELF 64-bit LSB shared object  ← PIE
# mybinary: ELF 64-bit LSB executable     ← not PIE
```

```cmake
# Enable PIE in CMake
target_compile_options(myapp PRIVATE -fpie -fPIE)
target_link_options(myapp PRIVATE -pie)
```

On Linux, verify ASLR is enabled system-wide:

```bash
cat /proc/sys/kernel/randomize_va_space
# 0 = disabled, 1 = partial, 2 = full (required)
```

Go binaries are compiled as PIE by default on `linux/amd64`, `linux/arm64`, and `darwin`. C++ requires explicit flags.

### RELRO: Relocation Read-Only

The PLT (Procedure Linkage Table) and GOT (Global Offset Table) are writable data structures used for lazy symbol resolution. Overwriting a GOT entry redirects all calls through that entry to attacker-controlled code, this is the "GOT overwrite" exploitation technique.

RELRO makes these tables read-only after the dynamic linker has resolved symbols.

- **Partial RELRO** (`-Wl,-z,relro`): makes the GOT partially read-only. Lazy resolution remains, `.got.plt` is still writable.
- **Full RELRO** (`-Wl,-z,relro,-z,now`): resolves all symbols at startup, then makes the entire GOT read-only. `.got.plt` becomes non-writable.

```bash
# Check RELRO status of a binary
checksec --file=./mybinary
# [*] RELRO           Full RELRO
# [*] Stack Canary    found
# [*] NX              enabled
# [*] PIE             enabled

# Or with readelf:
readelf -l ./mybinary | grep GNU_RELRO
```

The cost of full RELRO is startup time: all shared library symbols must be resolved at launch rather than on first use. For most applications this is imperceptible. For applications with thousands of dynamic symbols (large plugin systems), measure and decide.

```cmake
target_link_options(myapp PRIVATE
    -Wl,-z,relro
    -Wl,-z,now
)
```

### CFI: Control Flow Integrity

CFI restricts where indirect calls, function pointer calls and virtual dispatch, can transfer control. Without CFI, overwriting a vtable pointer or function pointer redirects execution anywhere in the process. With CFI, indirect calls are checked against a set of valid targets.

Clang's CFI implementation operates at link time with LTO (Link-Time Optimization) enabled:

```cmake
# CFI requires LTO
target_compile_options(myapp PRIVATE
    -flto
    -fsanitize=cfi-vcall       # virtual calls must target valid vtables
    -fsanitize=cfi-icall       # indirect calls must target valid functions
    -fsanitize=cfi-nvcall      # non-virtual member function calls
    -fvisibility=hidden        # required: CFI needs type information at link time
)
target_link_options(myapp PRIVATE
    -flto
    -fsanitize=cfi-vcall,cfi-icall,cfi-nvcall
)
```

```cpp
// Without CFI: vtable hijack is straightforward
struct Animal {
    virtual void speak() = 0;
};
struct Dog : Animal {
    void speak() override { std::puts("woof"); }
};

// Attacker writes to the vtable pointer of a Dog instance
// and redirects speak() to arbitrary code

// With CFI: the indirect call checks that the target is a valid
// implementation of Animal::speak, eliminates the redirect
```

CFI's limitations: it validates that a call targets a valid function of the correct type, but does not prevent calling the wrong valid function. It defeats ROP chains that go through indirect calls, and defeats vtable hijacking. Sophisticated attackers can construct "COOP" (Counterfeit Object-Oriented Programming) attacks that chain legitimate calls, but CFI still raises the bar significantly.

### SafeStack: Separating Return Addresses

SafeStack splits the stack into two regions: a "safe" stack for return addresses and spill slots, and an "unsafe" stack for buffers that might be overflowed. Buffer overflows on the unsafe stack cannot reach return addresses on the safe stack.

```bash
# Enable SafeStack, compatible with most code
clang++ -fsanitize=safe-stack ...

# SafeStack statistics: what fraction of stack frames use unsafe stack
# (lower = better, fewer locals are adjacent to return addresses)
```

SafeStack complements stack canaries: canaries detect overflow after the fact, SafeStack physically separates the targets.

### Shadow Call Stack (AArch64)

On AArch64 with `-fsanitize=shadow-call-stack`, the return address is stored in a separate, protected region (using register `x18`). ROP attacks that overwrite return addresses on the stack have no effect, the `ret` instruction reads from the shadow stack, not the corrupted main stack.

```bash
# AArch64 only, supported on Android NDK and newer Linux toolchains
clang++ -target aarch64-linux-gnu -fsanitize=shadow-call-stack ...
```

### Complete Hardening Build Configuration

Security hardening in C++ requires both compiler-level defenses, stack canaries, ASLR, PIE binaries, and code-level discipline around buffer bounds, integer arithmetic, and untrusted input handling. The examples below illustrate the specific mitigation for each vulnerability class discussed in this section.
```cmake
# CMakeLists.txt, production hardening for Linux
cmake_minimum_required(VERSION 3.20)
project(myapp)

add_executable(myapp src/main.cpp)

target_compile_options(myapp PRIVATE
    # Stack protection
    -fstack-protector-strong

    # Position-independent code (required for ASLR to cover executable)
    -fpie
    -fPIE

    # Fortify source: compile-time and runtime buffer checks for C stdlib
    -D_FORTIFY_SOURCE=2

    # Format string safety
    -Wformat
    -Wformat-security
    -Wformat=2
    -Werror=format-security

    # CFI (requires -flto and -fvisibility=hidden)
    -flto
    -fvisibility=hidden
    -fsanitize=cfi-vcall,cfi-icall
)

target_link_options(myapp PRIVATE
    # PIE executable
    -pie

    # Full RELRO: resolve all symbols at startup, make GOT read-only
    -Wl,-z,relro
    -Wl,-z,now

    # Non-executable stack (NX / W^X)
    -Wl,-z,noexecstack

    # LTO for CFI
    -flto
    -fsanitize=cfi-vcall,cfi-icall
)

# Verify hardening in CI
# add_custom_command(TARGET myapp POST_BUILD
#     COMMAND checksec --file=$<TARGET_FILE:myapp>
# )
```

### Verifying Your Build

`checksec` inspects the ELF binary's headers and dynamic section to verify that all six hardening features are present: Full RELRO (read-only GOT after startup), stack canary, NX bit (non-executable stack), PIE (position-independent executable for ASLR), FORTIFY_SOURCE (buffer-overflow detection in libc wrappers), and no dangerous `rpath`. Running `checksec` as a CI step fails the build if any hardening feature is missing from a release binary.
```bash
# checksec: full check of all hardening features
pip install checksec.py
checksec --file=./myapp

# Expected output for a fully hardened binary:
# [*] RELRO           Full RELRO
# [*] Stack Canary    found
# [*] NX              enabled
# [*] PIE             enabled
# [*] RPATH           No RPATH
# [*] RUNPATH         No RUNPATH
# [*] Symbols         No Symbols
# [*] FORTIFY         enabled
# [*] Fortified       3 (of 5 fortifiable functions)
# [*] Fortifiable     5
```

These flags are free to apply to any C++ project. The performance cost of stack canaries is negligible. The startup cost of full RELRO is rarely measurable. PIE adds a few percent overhead on x86 from indirect addressing, which is negligible on modern CPUs. CFI requires LTO but adds minimal runtime cost after the build-time analysis.

---
