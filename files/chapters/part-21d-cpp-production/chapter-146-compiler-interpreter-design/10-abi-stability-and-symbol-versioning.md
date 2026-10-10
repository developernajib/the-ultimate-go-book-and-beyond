## ABI Stability and Symbol Versioning for Compilers and Runtimes

A language implementation that emits shared libraries, exposes a C++ runtime, or ships plugin interfaces must control its ABI. ABI breaks manifest as silent memory corruption in clients that were compiled against the previous version. The fix is not "rebuild everything," it is designing the ABI to evolve without breaking.

### The two C++ ABIs you must know

On Linux, libstdc++ ships a dual ABI controlled by `_GLIBCXX_USE_CXX11_ABI`. The pre-C++11 ABI uses reference-counted `std::string`, the C++11 ABI uses small-string-optimized `std::string` with different layout. Mixing them in one process corrupts strings. Pin your toolchain, and verify every dependency:

```
nm -D libfoo.so | grep 'St7__cxx11'   # C++11 ABI symbols
nm -D libfoo.so | grep 'Ss'           # legacy COW std::string
```

`__attribute__((abi_tag("cxx11")))` annotates individual symbols. Use it when a single library must expose both ABIs during a migration.

### Inline namespaces for versioning

Inline namespaces let you rename a type's mangled name on every ABI change without changing user-visible code:

```cpp
namespace mylang {
inline namespace v3 {
    struct Value {
        TypeId type;
        uint32_t flags;
        uint64_t payload;
    };
}
}

// mylang::Value is mylang::v3::Value to the linker,
// but mylang::Value to the user.
```

When `Value` gains a field, bump to `inline namespace v4 { struct Value { ... } }` and keep `namespace v3 { struct Value { ... old ... }; }` for legacy clients. Old and new coexist in one process without collision, which is how LLVM ships breaking IR changes on a 6-month cadence.

### Symbol version scripts

GNU ld and lld accept a version script that explicitly lists the exported ABI. Unlisted symbols become local and cannot be bound by callers, which is the single best tool for preventing accidental ABI surface:

```
# mylang.map
MYLANG_1.0 {
    global:
        mylang_create;
        mylang_destroy;
        mylang_eval;
    local:
        *;
};

MYLANG_1.1 {
    global:
        mylang_eval_v2;
} MYLANG_1.0;
```

Link with `-Wl,--version-script=mylang.map`. `mylang_eval_v2` is a superset release that inherits from `MYLANG_1.0`. Clients linked against 1.0 still resolve, clients compiled against 1.1 can use the new entry.

### Symver aliases for evolving functions

A single function can expose multiple versions via `.symver`:

```cpp
extern "C" int mylang_eval_v1(const char* src);
extern "C" int mylang_eval_v2(const char* src, EvalOptions* opts);

__asm__(".symver mylang_eval_v1,mylang_eval@MYLANG_1.0");
__asm__(".symver mylang_eval_v2,mylang_eval@@MYLANG_1.1");
```

`@@` marks the default (what new links pick up), `@` marks the historical binding. Glibc uses this pattern for `memcpy`, `pow`, and friends. A senior engineer writing a runtime should reach for it the moment a signature needs to change.

### PIMPL as an ABI firewall

The most aggressive ABI discipline is to expose no C++ types at all across the library boundary, only pointers to incomplete types, with all access via free functions. This is PIMPL taken to its conclusion:

```cpp
// public header
struct MylangContext;
extern "C" MylangContext* mylang_context_create();
extern "C" void           mylang_context_destroy(MylangContext*);
extern "C" int            mylang_eval(MylangContext*, const char* src, char** err);
```

Internally `MylangContext` is a full C++ class, but the client sees only an opaque pointer. Nothing in the library's private headers affects client binaries. This is how LLVM-C, SQLite, and most long-lived C++ libraries maintain decade-long ABI stability.

### Itanium name mangling facts a senior engineer must know

- `_ZN` prefix marks a nested name, followed by length-prefixed components.
- Function signature is encoded after the name (`i` = int, `Pc` = char*, etc.).
- `c++filt` demangles, `llvm-cxxfilt` handles Microsoft mangling too.
- Template instantiations mangle the template arguments, so changing a default template argument is an ABI break.
- Inline functions in headers may be emitted into every TU and deduplicated by the linker, but if two TUs disagree on the definition (ODR violation) the linker picks one and silently miscompiles.

### Testing ABI compatibility

- `abidiff` (libabigail) compares two shared libraries and reports ABI changes in structured form. Run it in CI against the previous release.
- `checksymver` ensures no new exported symbol lacks a version tag.
- Keep an `abi_dump.json` artifact in the release bundle. A diff in code review catches accidental additions before release.

### Runtime compatibility contract

Document the contract explicitly: minor versions are ABI-compatible with older minor versions of the same major. Major versions may break, and the major number lives in the SONAME (`libmylang.so.3` vs `libmylang.so.4`) so both can coexist. This is the oldest rule in the Linux shared-library playbook, and breaking it is how distros ban your library.
