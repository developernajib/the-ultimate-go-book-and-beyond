## 159.7 V8 Embedder API

The V8 embedder API in `include/v8.h` is what Chromium, Node.js, Electron, Cloudflare Workers, and every JavaScript-hosting C++ application use to drive V8. The API is intentionally narrow (a few dozen public types), heavily templated, and unforgiving about lifetime mistakes.

### Core Types

```cpp
namespace v8 {

class Isolate;          // Single-threaded V8 instance. Owns one heap.
class Context;          // JavaScript global scope. Multiple per Isolate.
class HandleScope;      // RAII for stack-allocated handle lifetime.
class EscapableHandleScope;  // Lets one handle escape to outer scope.

template <class T> class Local;       // Stack-rooted handle.
template <class T> class Global;      // Long-lived handle (was Persistent).
template <class T> class Maybe;       // Result or empty.
template <class T> class MaybeLocal;  // Local or empty.

class Value;            // Base of all JS values.
class Object;
class Function;
class String;
class Number;
class Promise;
class External;         // Wrapper for an opaque C++ pointer.

class FunctionTemplate; // Factory for JS functions backed by C++.
class ObjectTemplate;   // Factory for JS objects with shape.

class Platform;         // Embedder-provided thread pool, time source.
class TaskRunner;
}  // namespace v8
```

### Initialization

```cpp
#include "v8/include/libplatform/libplatform.h"
#include "v8/include/v8.h"

int main(int argc, char** argv) {
  v8::V8::InitializeICUDefaultLocation(argv[0]);
  v8::V8::InitializeExternalStartupData(argv[0]);
  std::unique_ptr<v8::Platform> platform =
      v8::platform::NewDefaultPlatform();
  v8::V8::InitializePlatform(platform.get());
  v8::V8::Initialize();

  v8::Isolate::CreateParams create_params;
  create_params.array_buffer_allocator =
      v8::ArrayBuffer::Allocator::NewDefaultAllocator();
  v8::Isolate* isolate = v8::Isolate::New(create_params);

  // ... use isolate ...

  isolate->Dispose();
  v8::V8::Dispose();
  v8::V8::DisposePlatform();
  delete create_params.array_buffer_allocator;
}
```

The `Platform` provides V8 with threads (for concurrent marking, background compilation), task queues, and a time source. Chromium provides its own platform implementation that integrates with `base::ThreadPool`.

### Isolate and Scopes

An `Isolate` is single-threaded. To use it from a thread, you must "enter" it:

```cpp
{
  v8::Isolate::Scope isolate_scope(isolate);
  v8::HandleScope handle_scope(isolate);

  v8::Local<v8::Context> context = v8::Context::New(isolate);
  v8::Context::Scope context_scope(context);

  // Inside here we can run JS, allocate handles, call into the API.
}
```

`HandleScope` defines the lifetime of `Local<T>` handles. When the scope exits, all `Local`s allocated inside become invalid. The handle is just a slot in a stack-allocated array, the GC walks these slots as roots.

`Context::Scope` makes a context the "current" one for binding API-created objects.

### Local vs Persistent vs Global

Three handle flavors:

- **`Local<T>`.** Stack-only. Cheap. Invalid after the enclosing `HandleScope`.
- **`Global<T>`.** Heap-allocated, long-lived. The GC keeps the target alive. Use for caches, embedder-owned references that outlive a single API call.
- **`Eternal<T>`.** Special-case Global that lives as long as the Isolate. Used for well-known strings.

Old code uses `Persistent<T>`, which is now a subset of `Global<T>` with a non-copyable wrapper. New code should use `Global<T>` and `Eternal<T>`.

`Local<T>::New(isolate, global_handle)` materializes a Local from a Global inside a HandleScope.

### Templates: Bridging C++ to JavaScript

`FunctionTemplate` creates a JS function whose body is a C++ callback:

```cpp
void HelloCallback(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* isolate = info.GetIsolate();
  v8::Local<v8::String> result =
      v8::String::NewFromUtf8(isolate, "hello from C++").ToLocalChecked();
  info.GetReturnValue().Set(result);
}

v8::Local<v8::FunctionTemplate> hello_tmpl =
    v8::FunctionTemplate::New(isolate, HelloCallback);
v8::Local<v8::Function> hello_fn =
    hello_tmpl->GetFunction(context).ToLocalChecked();
context->Global()->Set(context,
                       v8::String::NewFromUtf8Literal(isolate, "hello"),
                       hello_fn).Check();
```

`ObjectTemplate` is the same idea for objects: defines property accessors, internal field count, indexed handlers. Internal fields are slots that hold C++ pointers (typically the wrapped C++ object) without being visible to JS.

### A Minimal Embedder

```cpp
#include <iostream>
#include <string>

#include "v8/include/libplatform/libplatform.h"
#include "v8/include/v8.h"

namespace {

void Print(const v8::FunctionCallbackInfo<v8::Value>& info) {
  v8::Isolate* iso = info.GetIsolate();
  v8::HandleScope handle_scope(iso);
  for (int i = 0; i < info.Length(); ++i) {
    v8::String::Utf8Value s(iso, info[i]);
    std::cout << *s;
    if (i + 1 < info.Length()) std::cout << ' ';
  }
  std::cout << '\n';
}

v8::MaybeLocal<v8::Value> RunScript(v8::Local<v8::Context> ctx,
                                    const std::string& src) {
  v8::Isolate* iso = ctx->GetIsolate();
  v8::EscapableHandleScope handle_scope(iso);
  v8::Local<v8::String> code =
      v8::String::NewFromUtf8(iso, src.c_str()).ToLocalChecked();
  v8::Local<v8::Script> script;
  if (!v8::Script::Compile(ctx, code).ToLocal(&script))
    return {};
  v8::Local<v8::Value> result;
  if (!script->Run(ctx).ToLocal(&result))
    return {};
  return handle_scope.Escape(result);
}

}  // namespace

int main(int argc, char* argv[]) {
  v8::V8::InitializeICUDefaultLocation(argv[0]);
  v8::V8::InitializeExternalStartupData(argv[0]);
  auto platform = v8::platform::NewDefaultPlatform();
  v8::V8::InitializePlatform(platform.get());
  v8::V8::Initialize();

  v8::Isolate::CreateParams params;
  params.array_buffer_allocator =
      v8::ArrayBuffer::Allocator::NewDefaultAllocator();
  v8::Isolate* iso = v8::Isolate::New(params);
  {
    v8::Isolate::Scope iso_scope(iso);
    v8::HandleScope hs(iso);

    v8::Local<v8::ObjectTemplate> global_tmpl =
        v8::ObjectTemplate::New(iso);
    global_tmpl->Set(iso, "print",
                     v8::FunctionTemplate::New(iso, Print));

    v8::Local<v8::Context> ctx = v8::Context::New(iso, nullptr, global_tmpl);
    v8::Context::Scope ctx_scope(ctx);

    const char* src = R"(
      function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
      print('fib(20) =', fib(20));
    )";
    auto result = RunScript(ctx, src);
    if (result.IsEmpty()) {
      std::cerr << "script error\n";
      return 1;
    }
  }
  iso->Dispose();
  delete params.array_buffer_allocator;
  v8::V8::Dispose();
  v8::V8::DisposePlatform();
  return 0;
}
```

Build instructions are in this chapter's exercises. The source compiles against a built V8 with `gn` and links roughly six static libraries.

### Embedder Snapshots

Cold-starting V8 takes 50 to 100 ms on desktop because the heap has to be populated with all the built-in objects (`Object.prototype`, `Array.prototype`, `Math`, regex parsers, ...). Snapshots solve this.

A startup snapshot captures the post-init state of the heap as a binary blob. New Isolates load the blob and skip initialization. V8 ships with a default snapshot. Embedders can build custom snapshots that include their bindings preinitialized.

```cpp
// Build snapshot:
v8::SnapshotCreator creator;
{
  v8::Isolate* iso = creator.GetIsolate();
  v8::HandleScope hs(iso);
  v8::Local<v8::Context> ctx = v8::Context::New(iso);
  // ... install bindings, run init scripts ...
  creator.SetDefaultContext(ctx);
}
v8::StartupData blob = creator.CreateBlob(
    v8::SnapshotCreator::FunctionCodeHandling::kClear);

// Use snapshot:
v8::Isolate::CreateParams params;
params.snapshot_blob = &blob;
v8::Isolate* iso = v8::Isolate::New(params);
```

Chrome ships per-platform snapshots. Cloudflare Workers ships per-tenant snapshots: each tenant's startup script is baked into a snapshot, so a new isolate boots in under a millisecond.

### Internal Fields and C++ Wrappers

When you bind a C++ object into JS, the JS object needs to remember the C++ pointer:

```cpp
v8::Local<v8::ObjectTemplate> tmpl = v8::ObjectTemplate::New(iso);
tmpl->SetInternalFieldCount(1);
v8::Local<v8::Object> js_obj = tmpl->NewInstance(ctx).ToLocalChecked();

MyCppType* native = new MyCppType();
js_obj->SetAlignedPointerInInternalField(0, native);

// Later, in a C++ callback:
auto* recovered =
    static_cast<MyCppType*>(js_obj->GetAlignedPointerFromInternalField(0));
```

Lifetime: the embedder must arrange for `delete native` when the JS object is collected. Use a `Global<Object>` with `SetWeak` and a finalizer callback. Modern Chromium uses cppgc to make this automatic.

### Promises

```cpp
v8::Local<v8::Promise::Resolver> resolver =
    v8::Promise::Resolver::New(ctx).ToLocalChecked();
v8::Local<v8::Promise> promise = resolver->GetPromise();

// Asynchronously:
resolver->Resolve(ctx, some_value).Check();
// Or:
resolver->Reject(ctx, error_value).Check();
```

The microtask queue runs after each script's main turn, before returning to the event loop. Embedders set the microtask policy with `isolate->SetMicrotasksPolicy(...)`.

### Error Handling

Most API calls return `MaybeLocal<T>` or `Maybe<T>`. Empty means a JS exception was thrown. Use `TryCatch` to capture:

```cpp
v8::TryCatch tc(iso);
auto result = script->Run(ctx);
if (result.IsEmpty()) {
  v8::String::Utf8Value msg(iso, tc.Exception());
  std::cerr << "JS error: " << *msg << '\n';
}
```

`.Check()` aborts on failure. `.ToLocalChecked()` aborts if the maybe is empty. Use these only when you have proven the operation cannot fail.

### Threading Caveats

- Only one thread may "be inside" an Isolate at a time.
- The `Locker` class allows multiple threads to take turns, with explicit locking.
- Most embedders avoid `Locker` by giving each thread its own Isolate.
- Background tasks scheduled by V8 (concurrent marking, compilation) run on Platform-provided threads and do not require explicit Locker use.

### Senior Interview Material

- "What is a `HandleScope`, and what happens to a `Local<T>` whose enclosing scope has exited?"
- "When would you use `Global<T>` vs `Eternal<T>`?"
- "How does V8 startup time get reduced from 100 ms to under 1 ms? Walk through the snapshot mechanism."
- "Bind a C++ class so that JavaScript can construct, call methods on, and finalize instances. Walk through internal fields and weak callbacks."
- "Why is V8 single-threaded per Isolate? What does Locker buy you?"

The next section steps out of V8 into the graphics half of the browser, with Skia.

---
