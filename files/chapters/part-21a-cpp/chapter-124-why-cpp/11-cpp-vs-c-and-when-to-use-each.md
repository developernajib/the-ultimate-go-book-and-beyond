## C++ vs C: When to Use Each

> **Junior to FAANG:** "C with classes" is not a strategy. Either commit to modern C++ idioms (RAII, templates, the standard library) or stay in pure C. The middle is where bugs live.
>
> **Senior at FAANG:** Knowing when to drop to C is a senior skill. Boundary code, kernel modules, ABI-stable libraries, and tiny embedded targets still belong in C in 2026.

C is not dead. It is not even retreating. The Linux kernel has 28+ million lines of C and growing. SQLite, Redis, PostgreSQL, OpenSSL, libcurl, ffmpeg, Git, Lua, CPython, Nginx. All C. The TIOBE index swap between C and C++ over the last decade is mostly noise. Both are entrenched and both will outlive most engineers reading this.

The interesting question is not which is better. It is: for a given component, which one fits.

### When pure C still wins

#### Operating system kernels

The Linux kernel is C. Period. There is now optional Rust support for some drivers, but the core remains C and will for the foreseeable future. The reason is not nostalgia. It is:

- **No exceptions.** Kernel context cannot unwind through arbitrary call chains. C++ exceptions require unwinding metadata and a runtime that the kernel does not provide.
- **No RTTI, no global constructors.** Kernel modules load and unload, and global ctor ordering across modules is undefined in C++. C has no such problem.
- **No stack growth.** Kernels run on tiny fixed stacks (8 KB on x86-64 Linux). C++ template instantiations and exception unwind tables can blow this budget.
- **ABI predictability.** C's ABI is the calling convention plus struct layout. C++'s is name mangling, vtable layout, exception handling tables. The kernel exports a stable C ABI to modules.

The same logic applies to seL4, Zephyr, FreeRTOS core, eBPF programs (verifier-checked C subset), bootloaders (U-Boot, GRUB), and most hypervisors (KVM, parts of Xen).

#### Embedded with no exceptions, no RTTI

Cortex-M0 and Cortex-M3 microcontrollers, AVR (Arduino-class), PIC, MSP430, RISC-V embedded cores. You can use C++ here (and many engineers do) but you almost always disable exceptions and RTTI:

```
arm-none-eabi-g++ -fno-exceptions -fno-rtti -fno-unwind-tables \
                  -fno-threadsafe-statics -ffreestanding ...
```

At that point, what you are using is "C with templates and RAII". For some teams, that is a worthwhile productivity gain. For others, the cognitive overhead and binary size growth from template instantiation outweighs it. AUTOSAR Classic Platform (automotive) is C-only by certification. Avionics DO-178C Level A code is overwhelmingly C, sometimes Ada. Medical IEC 62304 Class C is mostly C.

The trend line is shifting (MISRA C++ exists, AUTOSAR Adaptive Platform is C++14), but if you are joining an embedded or safety-critical team, expect C unless told otherwise.

#### Public ABI-only libraries

If you ship a `.so` or `.dll` that thousands of programs link against, the C ABI is the only stable one. Examples:

- **OpenSSL, libcurl, zlib, libpng, libjpeg-turbo:** C APIs. Used from every language. C++ would force every binding generator to deal with name mangling and vtable layout.
- **CUDA Driver API, OpenCL, Vulkan, OpenGL:** C APIs. Vulkan in particular is the modern reference for "what a clean C ABI looks like".
- **POSIX itself, Win32, Cocoa's underlying C APIs (Core Foundation):** all C.

The pattern: when you have N callers in M different languages, you publish C and let bindings handle the rest. SWIG, ctypes, cgo, JNA, P/Invoke, LuaJIT FFI, all consume C ABI directly.

You can write the *implementation* in C++ and expose a C surface:

```cpp
// engine.cpp
class Engine { /* C++ implementation */ };

extern "C" {
    void* engine_new() { return new Engine(); }
    void engine_free(void* e) { delete static_cast<Engine*>(e); }
    int engine_step(void* e, double dt) {
        try {
            return static_cast<Engine*>(e)->step(dt);
        } catch (...) {
            return -1; // never let exceptions cross C boundary
        }
    }
}
```

This is the pragmatic compromise. ICU, V8 (mostly), and many database client libraries are built this way. The rule: exceptions never cross `extern "C"`, no C++ types in the API, all handles are opaque pointers.

### C with C++ pieces

Many real codebases are predominantly C with islands of C++. Examples:

- **Qt:** C++ but designed for use from C++ only.
- **Postgres extensions:** Postgres is C, but you can write extensions in C++ if you keep the entry points `extern "C"` and never let exceptions escape.
- **Game engines from the 2000s:** id Tech 4 was a mix, with C cores and C++ subsystems.
- **Chrome's older code:** parts of the platform layer are still close to C-style, newer code is heavy modern C++.

The skills required: knowing exactly where the boundary is, never letting C++ idioms (`std::string`, exceptions, smart pointers) cross into C-typed code, and keeping headers visible from C clean of any C++ syntax (use `#ifdef __cplusplus` guards).

```c
/* engine.h, includable from both C and C++ */
#ifdef __cplusplus
extern "C" {
#endif

typedef struct Engine Engine;

Engine* engine_new(void);
void    engine_free(Engine*);
int     engine_step(Engine*, double dt);

#ifdef __cplusplus
}
#endif
```

### Full C++ for large applications

When you do not have an ABI-stable surface, when you control the build, when the codebase is large enough that abstraction wins over verbosity, modern C++ pulls ahead. RAII, `std::unique_ptr`, `std::vector`, `std::string`, `std::optional`, `std::variant`, `std::span`, ranges, concepts, modules. These are massive productivity wins compared to manual memory management and tag-union structs in C.

Examples of "full C++" wins:

- **Chrome, Firefox, WebKit:** million-plus line applications. The complexity is unmanageable without classes, RAII, and templates.
- **LLVM, GCC:** compiler IRs are heavy template trees. Modern LLVM is heavy C++17+.
- **Game engines (Unreal, Unity native, Frostbite):** ECS, reflection, scripting bindings, all driven by templates.
- **Trading systems (Citadel, Jane Street's C++, Optiver):** template-heavy lock-free containers, expression templates for derivatives pricing.
- **Databases (ClickHouse, MongoDB, ScyllaDB, MySQL, MariaDB):** query optimizers and storage engines are C++.

### Real-world examples worth studying

**Linux kernel (C).** Read `mm/slab.c`, `kernel/sched/core.c`, `fs/ext4/inode.c`. You will see disciplined C: linked-list macros, container_of, function pointer tables for vtable-like dispatch. This is what professional C looks like. It is not friendly to read, and it is still one of the most reliable codebases in the industry.

**SQLite (C).** Three files (`sqlite3.c` amalgamation), 200K lines, the most-deployed database in history. The author (D. Richard Hipp) has written publicly about why he stays in C: testability, ABI stability, portability to platforms with minimal C++ support (mainframes, embedded, niche RTOS). Ten different C++ rewrites have been attempted. None replaced it.

**OpenSSL (C).** Painful to read, painful to fix, painful to use. Its API is C precisely because it must be callable from every language on every platform. The historical bugs (Heartbleed) were not C-vs-C++ choices. They were missing bounds checks that any language requires you to write.

**Redis (C).** Antirez chose C for predictability and "what you write is what you run". Single-threaded event loop. Easy to reason about latency.

**Nginx (C).** Modular C with a strict allocator pool model. Most modules are C. Nginx Plus and OpenResty add Lua scripting via LuaJIT.

**LLVM (C++).** Started as C++ in 2003, never looked back. Heavy use of templates, `llvm::SmallVector`, `llvm::StringRef`, `llvm::Optional`. The C++ choice is what makes the IR layer expressive.

### Decision framework

| Constraint | Pick |
|-------------------------------------------------------|------|
| Code runs in kernel mode | C (or kernel-Rust) |
| Public API consumed by many languages | C (impl can be C++) |
| Embedded with safety certification (DO-178C, ISO 26262) | C (or qualified C++) |
| Tiny MCU, no exceptions, no RTTI | C |
| Large user-space app, full toolchain available | C++ |
| Latency-critical numerics | C++ |
| You want RAII, templates, std lib | C++ |
| You need "what you write is what runs" simplicity | C |

There is no shame in writing C in 2026. There is shame in writing C and reinventing `std::vector` poorly. Pick the language that matches the constraints, and once you pick, commit to its idioms.
