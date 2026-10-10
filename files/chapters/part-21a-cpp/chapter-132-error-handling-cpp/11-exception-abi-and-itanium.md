## Exception ABI and the Itanium Model

Most production C++ on Linux, macOS, and the BSDs uses the Itanium C++ ABI for exception handling. Windows MSVC uses a different model (SEH-based), but the Itanium scheme dominates open-source toolchains (GCC, Clang, libc++, libstdc++). Understanding it is the difference between debugging a stripped core dump in production and shrugging at it.

### The Two-Phase Model

When `throw expr` runs, the runtime constructs an exception object on a side allocation (not the stack), copies the exception value into it, then enters the unwinder. Unwinding happens in two phases:

1. **Search phase.** Walk frames upward from the throw site. For each frame, ask "does this frame have a `catch` that matches?". No destructors run yet. If no match is ever found, the runtime calls `std::terminate` directly without unwinding. That choice is deliberate: it preserves the throwing frame's state for the debugger.
2. **Cleanup phase.** Walk frames again, this time running destructors of automatic objects (the cleanup landing pads) and stopping at the matching `catch`.

The two-phase split is why an uncaught exception leaves you with a stack you can actually inspect in `gdb`.

### DWARF Call Frame Information and `.gcc_except_table`

The unwinder needs two kinds of metadata per function:

- **`.eh_frame`** (DWARF Call Frame Information). Tells the unwinder how to restore registers and find the caller's frame, given a PC inside this function. This is the same machinery `gdb` uses for backtraces.
- **`.gcc_except_table`** (Language-Specific Data Area, LSDA). Per-function table mapping PC ranges to landing pads, plus a list of `catch` types. Encoded with `DW_EH_PE_*` formats.

You can dump it:

```bash
$ readelf --debug-dump=frames libfoo.so | head
$ objdump -s -j .gcc_except_table libfoo.so | less
$ llvm-dwarfdump --eh-frame libfoo.so
```

If you strip `.eh_frame` from a binary, throwing an exception becomes undefined behavior (typically immediate `terminate`). This is why people who blindly run `strip --strip-all` on shared libraries find their exception handling silently broken.

### What `_Unwind_RaiseException` Actually Does

`__cxa_throw` is the libc++abi/libsupc++ entry point. It:

```cpp
extern "C" void __cxa_throw(void* obj, std::type_info* tinfo, void (*dest)(void*)) {
    __cxa_exception* header = cxa_exception_from_thrown_object(obj);
    header->exceptionType        = tinfo;
    header->exceptionDestructor  = dest;
    header->unexpectedHandler    = std::get_unexpected();
    header->terminateHandler     = std::get_terminate();
    __cxa_get_globals()->uncaughtExceptions += 1;

    _Unwind_RaiseException(&header->unwindHeader);
    // If we return, no handler was found.
    __cxa_begin_catch(&header->unwindHeader);
    std::terminate();
}
```

`_Unwind_RaiseException` is the libgcc / libunwind entry point. It runs the search phase, then the cleanup phase. Cleanup landing pads end with `_Unwind_Resume`, which jumps back into the unwinder to continue cleaning up the next frame. A `catch` block ends with `__cxa_end_catch`, which decrements the refcount on the exception object and may free it.

### RTTI Matching

The catch type is matched by `std::type_info::__do_catch`, a virtual on `type_info`. For a `catch (Derived&)` against a thrown `Base`, the runtime walks the type's `__class_type_info` hierarchy. This is why hidden visibility on RTTI symbols across shared library boundaries causes `catch` to silently fail. Two `.so` files each compiled with `-fvisibility=hidden` and the exception type unexported will produce two distinct `type_info` symbols, and the address compare in `__do_catch` returns false.

The fix is `__attribute__((visibility("default")))` on exception classes, or building with `-fvisibility-inlines-hidden -fvisibility=hidden` plus an explicit export list that includes RTTI for thrown types.

### Performance Cost

A throw is expensive: an allocation, a registered destructor, a search walk, a cleanup walk, and several indirect calls. On modern x86_64 hardware, throwing across ~20 frames typically costs 10 to 50 microseconds. That is fine for "request failed, return 500" but a disaster inside a hot loop.

The non-throwing path is essentially free. `.eh_frame` and LSDA tables are paged in only on a throw. There is no per-call instrumentation, no setjmp, no register save (Itanium model is "table-driven", not "setjmp-longjmp"). The cost is only paid when something throws, which is the entire design intent.

This asymmetry is why "exceptions for exceptional cases" is correct advice: control flow that throws on every other call has terrible cache behavior because the unwinder pages in tables that are otherwise cold.

### SJLJ vs Table-Driven

Older toolchains and some embedded targets use setjmp/longjmp exceptions (`-fsjlj-exceptions`). Every `try` does a `setjmp`, every entry to a frame with destructors registers in a thread-local list. The non-throwing path is no longer free. Modern Linux/macOS x86_64 and aarch64 always use table-driven (DWARF) exceptions. Check with `gcc -v` for `--enable-sjlj-exceptions` (almost always absent on Linux distros).

### Windows SEH vs Itanium

MSVC integrates C++ exceptions with Structured Exception Handling. The metadata is in `.pdata` and `.xdata` sections (PE format), not `.gcc_except_table`. MinGW builds historically used SJLJ on 32-bit, DWARF on 64-bit, and now SEH on 64-bit. Cross-DLL exceptions on Windows have similar pitfalls: the exception type's RTTI must agree, and the CRT must be the same.

### Forced Unwinds and Cancellation

`_Unwind_ForcedUnwind` is the entry point pthread cancellation uses to unwind a thread. It looks like an exception to destructors, but `catch (...)` does not catch it (the personality routine refuses match in the search phase). This is why `pthread_cancel` runs C++ destructors but cannot be caught by user code, and why writing `catch (...)` and rethrowing is the correct pattern for "I want to log and let cleanup continue".

## What to Audit in a Production Binary

- Confirm `.eh_frame` is present: `readelf -S binary | grep eh_frame`.
- Confirm exception type RTTI is exported across shared library boundaries.
- For latency-sensitive code, count throws per second (`perf probe -x bin __cxa_throw`).
- For binary size, `.eh_frame` and `.gcc_except_table` can be 5 to 15 percent of a stripped binary. `-fno-asynchronous-unwind-tables` removes `.eh_frame` for code that never throws and never needs a backtrace, but disables stack traces.

## FAANG Interview Bar (L5/L6)

A senior engineer should be able to:

- Explain why the non-throwing path has zero per-call overhead in the Itanium ABI.
- Describe what fails when RTTI visibility is hidden across `.so` boundaries.
- Identify `.eh_frame` and `.gcc_except_table` in a stripped binary.
- Explain why `std::terminate` runs before stack unwinding when no handler is found, and how that helps post-mortem debugging.
- Distinguish forced unwind (cancellation) from a regular C++ throw.

If you cannot do these on a whiteboard, you do not yet own this layer of the language. Read the Itanium C++ ABI spec sections 1.3 and 2 (the EH chapters), then read libcxxabi's `cxa_exception.cpp` and `cxa_personality.cpp`. The whole thing is a few thousand lines and explains everything.
