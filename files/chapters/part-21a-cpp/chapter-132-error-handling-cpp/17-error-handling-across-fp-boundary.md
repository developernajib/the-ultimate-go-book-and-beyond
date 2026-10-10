## Error Handling Across the FFI Boundary

C++ exceptions cannot cross a C ABI. C does not have a notion of unwinding, RTTI, or `catch`. If an exception escapes a function declared `extern "C"` and the caller is C, the behavior is undefined (in practice: process abort, sometimes after running some destructors, sometimes not). The same applies to functions called from another runtime (Python via CPython, Java via JNI, Go via cgo, Rust via FFI). The boundary is where you must translate.

### The Rule

**No C++ exception ever escapes a C ABI function.** Wrap every `extern "C"` body:

```cpp
extern "C" int my_lib_open(const char* path, my_handle_t** out) {
    if (!path || !out) return MY_ERR_INVALID_ARG;
    try {
        auto h = std::make_unique<MyHandle>(path);  // may throw
        *out = reinterpret_cast<my_handle_t*>(h.release());
        return MY_OK;
    } catch (const std::bad_alloc&) {
        return MY_ERR_OOM;
    } catch (const std::system_error& e) {
        return translate(e.code());
    } catch (const std::exception& e) {
        log_error("my_lib_open: %s", e.what());
        return MY_ERR_INTERNAL;
    } catch (...) {
        log_error("my_lib_open: unknown exception");
        return MY_ERR_INTERNAL;
    }
}
```

Centralize this with a wrapper helper:

```cpp
template <typename F>
int with_c_abi(F&& f) noexcept {
    try {
        return std::forward<F>(f)();
    } catch (const std::bad_alloc&) { return MY_ERR_OOM; }
      catch (const std::system_error& e) { return translate(e.code()); }
      catch (const std::exception& e) { log_error("%s", e.what()); return MY_ERR_INTERNAL; }
      catch (...) { return MY_ERR_INTERNAL; }
}

extern "C" int my_lib_open(const char* path, my_handle_t** out) {
    return with_c_abi([&] {
        // ... C++ body ...
        return MY_OK;
    });
}
```

The outer function is `noexcept` (C functions are always implicitly nothrow on the linkage side). The wrapper guarantees no escape.

### Marshalling Errors

A C ABI cannot return a complex error object. Three patterns dominate:

1. **Integer code return.** `int` or `enum` returned by value. Out-parameters for the success value. Used by SQLite, libcurl, OpenSSL, POSIX.
2. **Code plus thread-local last error.** `errno`, Windows `GetLastError`, OpenSSL's `ERR_get_error`. The function returns a small code, the detail is fetched from a TLS slot. Avoid in new APIs, thread-local error state breaks across coroutines and fiber-based concurrency.
3. **Code plus opaque error object.** Function returns a code, fills `MyError**` out-parameter on failure, caller calls `my_error_free`. Cleaner than TLS, requires deallocator API.

Pattern 3, used by absl::Status when it crosses a wrapped C boundary:

```cpp
struct my_error {
    int code;
    char message[256];
    char file[64];
    int line;
};

extern "C" void my_error_free(my_error* e);

extern "C" int my_lib_query(my_handle_t* h, const char* sql, my_error** err_out) {
    return with_c_abi([&] {
        try {
            real_handle(h)->query(sql);
            return MY_OK;
        } catch (const QueryError& qe) {
            if (err_out) *err_out = build_my_error(qe);
            return MY_ERR_QUERY;
        }
    });
}
```

Document ownership: who allocates, who frees. Do not assume `malloc` or `new`, use a paired allocator and deallocator from the same library so a future ABI change does not crash the caller.

### SQLite, BoringSSL, and the C-ABI Lessons

**SQLite.** Functions return small `int` codes (`SQLITE_OK`, `SQLITE_BUSY`, `SQLITE_DONE`, etc.). Detail comes from `sqlite3_errmsg(db)`, which reads thread-local-ish state on the connection. The connection acts as the "context" for the last error, which is cleaner than a true thread-local because connections are explicitly threaded. Lesson: tie last-error state to the explicit handle, not to the thread.

**BoringSSL / OpenSSL.** Errors live in a thread-local stack (`ERR_get_error`). A single API call may push multiple errors. The caller drains the stack. Lesson: composite operations may have multi-error context. Provide a way to enumerate, do not collapse.

**libcurl.** Functions return `CURLcode`. Detail goes into a caller-provided `errbuf` (set by `curl_easy_setopt(... CURLOPT_ERRORBUFFER ...)`). Lesson: caller-provided buffer avoids allocation in the failure path, which is essential when the failure is OOM.

**Python C API.** Returns `NULL` or `-1` to signal error, with detail via `PyErr_Set*`. The caller checks `PyErr_Occurred()`. Lesson: the convention is consistent, exhaustively documented, and lints catch a function that signals an error without setting one.

### Exceptions Across Plugin Boundaries (`dlopen`)

If you `dlopen` a `.so` and call into it through a C ABI function pointer, an exception escaping that function is undefined behavior even if both sides are C++. The unwinder may need symbols that are not exported, RTTI may not match (different `type_info` instances per DSO), and `personality_v0` may differ between toolchains.

For C++ plugins where you control both sides, two viable options:

1. **Same toolchain, exported RTTI, default visibility on exception types.** Both DSOs use the same libc++ / libstdc++. Exception classes are explicitly exported with `__attribute__((visibility("default")))` and listed in the link-script. Exceptions propagate fine, but you have just made your plugin ABI fragile.
2. **C ABI between plugin and host, exceptions translated at the boundary.** The host calls into the plugin through `extern "C"` functions. Each function wraps its body in a translation block. Exception types defined in the plugin never leave it. This is the boring, durable choice.

Pick option 2. It survives compiler upgrades and ships of Theseus refactors that option 1 does not.

### Cgo, JNI, Python, Rust

**Go (cgo).** Cgo cannot catch C++ exceptions. Wrap your C++ in C ABI with translation. Some code uses `extern "C++"` blocks plus `__cxa_demangle` tricks, do not. Boring works.

**JNI.** Throw a Java exception via `env->ThrowNew(env, cls, msg)` after catching the C++ exception. Returning to JNI with a C++ exception in flight calls `terminate`. Always wrap. Always check `env->ExceptionOccurred` after JNI calls.

**Python (CPython).** `PyErr_SetString(PyExc_RuntimeError, what)` then return `NULL`. Pybind11 automates this:

```cpp
PYBIND11_MODULE(my_module, m) {
    m.def("compute", &compute);
    py::register_exception<MyError>(m, "MyError");
}
```

Pybind11 catches escaping C++ exceptions in the wrapper trampoline and translates them. The default catches `std::exception` and translates to Python `RuntimeError`. Custom translation requires `register_exception` or `register_exception_translator`.

**Rust.** `extern "C"` in Rust is `nounwind` by default. A C++ exception unwinding into Rust is UB. Use `#[unwind(allowed)]` or, more sanely, translate at the C++ side. Project `cxx` (Dropbox / Google) wraps every exposed C++ function in a try/catch and surfaces a `Result` to Rust, which is the right pattern.

### Memory Ownership Across the Boundary

Exceptions are about control flow. Memory is about data. Both must be addressed.

- Caller-allocates, callee-fills: simplest. No deallocator needed across boundary.
- Callee-allocates, caller-frees with paired API: works. Requires lifetime discipline and a deallocator export.
- Callee-allocates, caller-frees with `free`: only works if both sides use the exact same `malloc`. On Windows with multiple CRTs, this crashes. Do not.

Smart pointers do not cross C boundaries. `unique_ptr<T>` on the C++ side, raw pointer with explicit free function on the C side. Use `release()` to hand off and `reset(p)` to take back.

### Strings Across the Boundary

`std::string` does not cross. Pass `const char*` plus length, or `const char*` and trust the null. Returning a `std::string` requires a callee-side allocator and a caller-side free, which is the same issue as memory ownership.

## FAANG Bar

A senior engineer should:

- Wrap every `extern "C"` body in a `try`-catch translator.
- Pick error-marshalling shape (code, code+TLS, code+object) appropriate to the API surface.
- Recognize that C++ exceptions and `dlopen` plugins do not mix safely without strict ABI control.
- Map exceptions across cgo, JNI, Pybind11, and Rust FFI without UB.
- Pair every callee-allocated handle with a callee-defined free function.
