## Debugging Coroutines

Coroutines lower into a state machine with a hidden frame. The debugger does not natively show "where is this coroutine paused, what is it waiting on, what is its continuation". You configure tools and write helpers to recover that view. This chapter covers what works in 2026.

### What the Compiler Emits

Each coroutine produces:

- A regular function (the ramp) the user calls. It allocates the frame, runs `initial_suspend`, returns the user-facing object.
- A resume function. Takes a frame pointer, executes from the current suspend index to the next.
- A destroy function. Cleans up the frame.
- The promise type, embedded in the frame.

In the binary you will see symbols like:

```
work() -> the ramp
work() (resume) -> the resume function
work() (destroy) -> the destroy function
```

Clang and GCC use slightly different mangling. With Clang's `-fcoroutines`, the demangled names include `(resume)` and `(destroy)` suffixes. GDB and LLDB show them in stack traces.

### GDB Pretty Printers

A pretty printer for `std::coroutine_handle<P>` makes interactive debugging tolerable.

```python
# coro_printers.py
import gdb

class CoroutineHandlePrinter:
    def __init__(self, val):
        self.val = val

    def to_string(self):
        ptr = self.val['__handle_']
        if int(ptr) == 0:
            return "coroutine_handle{null}"
        # The first two pointers in the frame are resume/destroy fn pointers.
        addr = int(ptr)
        try:
            resume_fn = gdb.Value(addr).cast(gdb.lookup_type('void(**)(void*)')).dereference()
            sym = gdb.find_pc_function(int(resume_fn))
            name = sym.name if sym else f"<{int(resume_fn):#x}>"
        except gdb.error:
            name = "<bad>"
        return f"coroutine_handle{{{name}}}"

def lookup(val):
    t = val.type.unqualified().strip_typedefs()
    if str(t).startswith('std::coroutine_handle'):
        return CoroutineHandlePrinter(val)
    return None

gdb.pretty_printers.append(lookup)
```

Source it from `.gdbinit`:

```
source /path/to/coro_printers.py
```

Now `print my_handle` shows the resume function name, which is the coroutine that handle refers to. You can identify "this is `read_db()` paused at line 42" by the symbol name.

Lewis Baker's `cppcoro` repository ships a more complete printer that walks the promise's continuation chain. Worth pulling and adapting.

### Walking the Continuation Chain

In a `task<T>`-style runtime each promise has a `continuation` handle pointing to the parent coroutine. Walking the chain reconstructs the async stack trace.

```python
class AsyncStackCommand(gdb.Command):
    def __init__(self):
        super().__init__("async-bt", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        h = gdb.parse_and_eval(arg)
        depth = 0
        while int(h['__handle_']) != 0:
            addr = int(h['__handle_'])
            resume = gdb.Value(addr).cast(gdb.lookup_type('void(**)(void*)')).dereference()
            sym = gdb.find_pc_function(int(resume))
            print(f"#{depth} {sym.name if sym else 'unknown'}")
            # Read the promise's `continuation` field at a known offset.
            # Offset depends on your task layout - adapt accordingly.
            promise_ptr = addr + 16  # past resume/destroy ptrs
            # ... read continuation handle from promise ...
            depth += 1
            # break or continue walking

AsyncStackCommand()
```

This is bespoke per-runtime: the offset of `continuation` inside the promise is fixed for a given task type but varies between task types. You write one printer per task type you ship.

folly::coro and stdexec both publish printers/scripts in their repos. Use them as starting points.

### LLDB Coroutine Support

LLDB 17+ has builtin coroutine awareness via the `__coro_frame_ty` debug type that Clang emits when `-fcoroutines-debug` is passed. The breakpoints work, locals show up at suspend points (with caveats: spilled-only locals are visible), and `frame variable` walks into the promise.

```
(lldb) settings set target.experimental.coroutines true
(lldb) breakpoint set -f mycode.cpp -l 42
(lldb) frame variable
```

For multi-coroutine dumps, write a Python LLDB command that iterates over a known coroutine registry. Many frameworks (folly::coro, abseil) maintain a debug-only thread_local list of in-flight coroutines for this purpose.

### AddressSanitizer with Coroutines

ASan instruments coroutine frames. Two interactions matter.

1. Use-after-destroy on a coroutine frame is detected. If a stale handle is resumed, ASan flags it.
2. Stack-use-after-return inside a coroutine: a local that the compiler thought did not escape but does (typically because of capture-by-reference) is flagged.

Compile with `-fsanitize=address -O1` (ASan needs at least -O1 for sane coroutine instrumentation). Run your test suite. The ASan reports for coroutine bugs are extremely helpful: they show both the allocation site (the coroutine ramp) and the access site.

A common ASan finding: capturing a temporary by reference in a coroutine lambda.

```cpp
auto make_task() {
    std::string s = "hello";
    return [&s] -> task<void> {
        co_await something();
        std::cout << s;  // s was destroyed when make_task returned
    }();
}
```

The lambda body is a coroutine, the frame outlives `s`. ASan catches the use-after-return on access. Fix: capture by value or pass by move into the coroutine function (not a lambda).

### Lifetime Traps

The single most common coroutine bug is dangling reference to data the coroutine captured.

#### Trap 1: Coroutine Lambdas Capture by Reference

```cpp
task<int> compute(std::vector<int> const& data);  // FINE: parameter copied into frame

void caller() {
    std::vector<int> v = {1,2,3};
    auto t = [&v]() -> task<int> {  // BAD: captures &v
        co_await something();
        co_return v.front();
    }();
    // v destroyed before t runs to completion
}
```

The fix: do not write coroutine lambdas. Write coroutine functions and pass parameters by value (which the coroutine stores inside its frame).

```cpp
task<int> work(std::vector<int> v) {  // taken by value, copied into frame
    co_await something();
    co_return v.front();
}
```

#### Trap 2: Dangling Reference Parameters

```cpp
task<int> work(std::string const& s) {        // HAZARD
    co_await something();
    co_return s.size();
}

void caller() {
    work("temporary");                         // string materializes, address dies after the call expression
}
```

Reference parameters do not extend lifetime to the coroutine's resumption. The temporary is destroyed when the ramp returns. The frame holds a dangling reference.

The rule: coroutines should take parameters by value or by move, not by reference, unless the caller is documented to outlive the entire coroutine. Many shops have `clang-tidy` rules that flag reference parameters in coroutine functions.

Even by-value taking has subtleties: parameters are copied into the frame at coroutine start. If the type has internal references (like `std::string_view`), the inner reference can dangle.

```cpp
task<int> bad(std::string_view sv);  // sv refers to caller storage
bad(std::string{"x"});               // string destroyed, sv dangles
```

#### Trap 3: this-Capture in Member Coroutines

```cpp
struct Server {
    task<void> serve(int fd) {
        co_await handle();   // uses this implicitly
    }
    task<void> handle();
};

void run() {
    auto t = Server{}.serve(0);  // Server temporary
    co_await std::move(t);       // Server already destroyed
}
```

The frame captures `this`. Member coroutines must outlive their owning object. Many codebases ban member coroutines and prefer free functions taking the object by `shared_ptr` or by value.

### Capture-by-Value vs Capture-by-Move

```cpp
auto data = make_data();
auto t = [data = std::move(data)]() -> task<void> {
    co_await something();
    use(data);
}();
```

The lambda is a coroutine. The capture `data` lives in the lambda object. When the lambda is invoked it produces the coroutine, which copies (or moves) the lambda into the coroutine frame as the implicit "lambda body" object. The frame owns the data. Lifetime is bounded by the coroutine's life.

This works. The hazard: returning the task and letting the lambda go out of scope is fine because the data has been moved into the frame, not because the lambda is alive. If your compiler does not move the lambda into the frame correctly (a long-fixed bug in early Clang and GCC versions), the data lifetime is the lambda's, which dies. Modern compilers handle this correctly.

### Common UB Patterns

1. Resuming an already-completed coroutine. `done() == true`, calling `resume()` is UB. Always check `done()`.
2. Destroying a coroutine that is currently running. UB. Coroutines must be suspended (or completed) when destroyed.
3. Resuming a coroutine that has been destroyed. Stale handle. ASan catches it, without ASan it is silent corruption.
4. Throwing from `final_suspend`. The standard requires `noexcept`. Compilers do not enforce it. Check.
5. Throwing from `await_suspend` after the handle has been published to another thread. Race: the other thread may have already resumed. The throw is UB.
6. Multiple `co_await` on a single-shot task. Implementation-defined, usually a crash or hang.

### clang -fcoroutines Symbols

To get useful debug info on Clang:

```
clang++ -std=c++23 -O1 -g -fcoroutines -fno-omit-frame-pointer ...
```

`-fcoroutines` is not strictly required (it's default for C++20+), but explicit is better. `-fno-omit-frame-pointer` keeps stack walking working through coroutine ramps. `-O1` minimum lets HALO and inlining happen but keeps debug info readable.

For stricter debugging, `-O0` keeps everything visible but can change coroutine codegen significantly: HALO never fires, frames are larger, and the assembly bears little relation to optimized output. Use `-O1` as the baseline for debug builds.

### Tracing across Awaits

`thread_local` variables do not survive across awaits if the coroutine resumes on a different thread.

```cpp
thread_local std::string request_id;

task<void> handler(Req r) {
    request_id = r.id;
    co_await db_query();           // may resume on another thread
    log("processing");             // request_id may be empty here
}
```

The fix: capture the trace context at coroutine start, restore it on every resume. Production tracing libraries (OpenTelemetry, Jaeger) provide context-propagating awaiters that wrap every co_await.

```cpp
template <typename A>
struct traced_awaiter {
    A inner;
    trace_ctx ctx;

    bool await_ready() noexcept { return inner.await_ready(); }
    auto await_suspend(auto h) {
        ctx = current_trace_ctx();
        return inner.await_suspend(h);
    }
    auto await_resume() {
        set_trace_ctx(ctx);
        return inner.await_resume();
    }
};
```

Wrap every awaiter via `await_transform` in the promise. Now `thread_local` trace context is preserved across hops.

#### Junior to FAANG callout

A junior writes a coroutine, sets a thread_local at the start, reads it after an await, and sees garbage. They blame the framework. Senior engineers know that thread_local is per-thread, and coroutines hop threads. The fix is restoration on resume, not "more thread_locals". This is the same lesson Go learned with goroutine-local storage (and rejected) and that Java is now relearning with virtual threads (`ThreadLocal` becomes `ScopedValue`).

### Logging Suspend Points

A debug-only `await_transform` that logs every suspend gives you a rough trace.

```cpp
struct task_promise {
    template <typename A>
    auto await_transform(A&& a) {
        return debug_awaiter{std::forward<A>(a), __builtin_FILE(), __builtin_LINE()};
    }
};
```

The two builtins record the source location of the `await_transform` call, which is the promise definition, not the user's `co_await` site. Better: use `std::source_location` parameter passed through `co_await` adapter. Some shops define a `tracked_await(expr, std::source_location::current())` macro that wraps awaiters with their call-site location.

### Practical Checklist

- Run with ASan in CI.
- Install pretty printers for your task and generator types.
- Take parameters by value, not by reference. Audit with clang-tidy.
- Never write member coroutines unless the object's lifetime is rigorously managed.
- Wrap awaiters with trace-context restoration. Do not rely on thread_local across awaits.
- Compile debug builds with `-O1 -g -fno-omit-frame-pointer`.
- For long-lived async chains, build an "async backtrace" command on top of the continuation pointers.
