## Company-Specific C++ Expectations

Every FAANG company has its own C++ dialect, build system, and culture. Understanding these before an interview gives you a significant edge, it signals genuine familiarity with the company's engineering culture, not just generic C++ knowledge.

---

### Google

**Codebase**: Google's C++ codebase is among the largest in the world, over 1 billion lines. Almost all production infrastructure (Search, Ads, Maps backend) is written in C++. The codebase is monolithic (one repo, built with Blaze/Bazel).

**Abseil**: Google's open-source C++ library (`https://abseil.io`) extends the standard library and is considered part of Google's "standard environment." Knowing Abseil is not optional for a Google C++ role.

```cpp
#include "absl/status/status.h"
#include "absl/status/statusor.h"
#include "absl/container/flat_hash_map.h"
#include "absl/strings/string_view.h"
#include "absl/time/time.h"

// absl::Status and absl::StatusOr replace exceptions (Google disables exceptions)
absl::StatusOr<int> parse_port(absl::string_view s) {
    int port;
    if (!absl::SimpleAtoi(s, &port)) {
        return absl::InvalidArgumentError(
            absl::StrCat("invalid port: ", s));
    }
    if (port < 1 || port > 65535) {
        return absl::OutOfRangeError(
            absl::StrFormat("port %d out of range [1, 65535]", port));
    }
    return port;
}

// Usage:
auto result = parse_port("8080");
if (!result.ok()) {
    LOG(ERROR) << result.status();
    return;
}
int port = *result;

// absl::flat_hash_map: faster than std::unordered_map (open addressing, cache-friendly)
absl::flat_hash_map<std::string, int> scores;
scores["alice"] = 95;

// absl::string_view is equivalent to C++17 std::string_view
// (Abseil predates C++17 - Google uses the absl:: versions for compatibility)
```

**Google C++ Style Guide** (https://google.github.io/styleguide/cppguide.html), key rules:
- No exceptions (`-fno-exceptions` in production builds)
- `#pragma once` is used. Traditional include guards also acceptable
- `int` preferred over `size_t` in most loops (avoid signed/unsigned comparisons)
- Non-owning raw pointers are fine. Just mark them with a `// not owned` comment
- Prefer `auto` for complex types, but not when it obscures the type
- Thread safety annotations: `ABSL_GUARDED_BY(mu_)` on member variables

**Build system**: Bazel. A `cc_library` and `cc_test` rule looks like:

```python
# BUILD file:
cc_library(
    name = "http_parser",
    srcs = ["http_parser.cc"],
    hdrs = ["http_parser.h"],
    deps = [
        "@abseil//absl/status:statusor",
        "@abseil//absl/strings",
    ],
)

cc_test(
    name = "http_parser_test",
    srcs = ["http_parser_test.cc"],
    deps = [
        ":http_parser",
        "@googletest//:gtest_main",
    ],
)
```

**Interview signal**: When asked to write C++ at Google, use `absl::Status` for errors, `absl::flat_hash_map` instead of `std::unordered_map`, and mention that Google disables exceptions. These details immediately signal familiarity.

---

### Meta (Facebook)

**Codebase**: Meta's C++ infrastructure includes the Folly and fbthrift libraries, the Buck2 build system, and massive C++ services behind Feed, Messenger, and WhatsApp. Unlike Google, Meta uses exceptions.

**Folly**: Meta's open-source C++ library (`https://github.com/facebook/folly`). It extends the STL with battle-tested implementations optimized for Meta's scale.

```cpp
#include <folly/futures/Future.h>
#include <folly/container/F14Map.h>
#include <folly/FBVector.h>
#include <folly/Optional.h>
#include <folly/io/IOBuf.h>

// folly::Future: Meta's async computation primitive (predates C++20 coroutines)
folly::Future<int> fetch_user_count() {
    return folly::makeFuture(42)
        .thenValue([](int raw) { return raw * 2; })
        .thenError<std::exception>([](const std::exception& e) {
            LOG(ERROR) << "Error: " << e.what();
            return 0;
        });
}

// folly::F14FastMap: Robin Hood hashing, 2-4x faster than std::unordered_map
// for many workloads (uses SIMD for probe sequences)
folly::F14FastMap<uint64_t, std::string> user_cache;

// folly::fbvector: like std::vector but with jemalloc integration
// and no value-initialization on resize
folly::fbvector<int> data;
data.resize(1000);  // faster: no zero-initialization

// folly::IOBuf: non-contiguous buffer chain for zero-copy networking
// Each IOBuf is a reference-counted view into a larger buffer
auto buf = folly::IOBuf::copyBuffer("hello, world");
buf->appendChain(folly::IOBuf::copyBuffer(" more data"));
```

**Exception-based error handling**: Unlike Google, Meta uses C++ exceptions. Code should be exception-safe. RAII is the primary tool.

**Concurrency emphasis**: Meta is particularly focused on lock-free data structures and the C++ memory model. The Folly library has implementations of:
- `folly::MPMCQueue`, multiple-producer multiple-consumer lock-free queue
- `folly::SharedMutex`, scalable reader-writer lock with write priority
- `folly::Synchronized<T>`, wraps a value with a mutex, forces synchronized access

```cpp
#include <folly/Synchronized.h>

// folly::Synchronized: makes the association between data and its lock explicit
folly::Synchronized<std::vector<int>> safe_vec;

safe_vec.withWLock([](auto& vec) {
    vec.push_back(42);  // exclusive lock
});

safe_vec.withRLock([](const auto& vec) {
    std::cout << vec.size() << "\n";  // shared lock
});
```

**Interview signal**: Know Folly's async primitives. Be prepared to discuss the tradeoffs between `folly::Future` and C++20 coroutines. Mention `F14FastMap` when discussing hash map performance.

---

### Apple

**Codebase**: Apple uses C++ extensively in the macOS/iOS kernel components (XNU), Metal GPU framework, CoreAudio, Safari's JavaScript engine (JavaScriptCore, written in C++), and many system frameworks. A distinguishing feature is Objective-C++ interoperability.

**Objective-C++ interop**: Files with `.mm` extension compile as Objective-C++, allowing C++ and Objective-C to coexist.

```cpp
// MyView.mm, Objective-C++ file

#import <Cocoa/Cocoa.h>
#include <memory>
#include <vector>

@interface MyView : NSView
@end

@implementation MyView {
    // C++ members in Objective-C class, fully supported in .mm
    std::unique_ptr<std::vector<int>> data_;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        data_ = std::make_unique<std::vector<int>>(100, 0);
    }
    return self;
}

- (void)processData {
    // Mix C++ and Objective-C freely
    std::sort(data_->begin(), data_->end());
    NSLog(@"Sorted %zu elements", data_->size());
}
@end
```

**ARC (Automatic Reference Counting)**: Objective-C objects under ARC are reference-counted at compile time (not a GC). When mixing with C++ smart pointers, be careful: an Objective-C object stored in a `std::vector` works, but you need `__strong` ownership specifiers.

**Metal and SIMD**: Apple's GPU compute framework is written in C++ with Metal Shading Language (C++ superset). Performance-critical code uses ARM NEON SIMD intrinsics or the `<simd/simd.h>` header.

```cpp
#include <simd/simd.h>

// simd types: float2, float3, float4, float4x4
simd_float4 v = {1.0f, 2.0f, 3.0f, 4.0f};
simd_float4 w = simd_normalize(v);
float dot = simd_dot(v, w);
```

**Clang-specific attributes**: Apple's clang toolchain has extensions that are used throughout system headers:
- `__attribute__((objc_subclassing_restricted))`, equivalent to `final`
- `__attribute__((ns_returns_retained))`, ARC ownership annotation
- `__attribute__((availability(macos, introduced=10.15)))`, API availability

**Interview signal**: Know Objective-C++ interop basics. Understand ARC and how it interacts with C++ destructors. Be prepared to discuss why Apple uses C++ alongside Swift rather than replacing C++ entirely (performance, existing codebase, Metal/kernel requirements).

---

### Microsoft

**Codebase**: Microsoft's C++ spans Windows kernel (C, not C++), DirectX runtime, Visual C++ runtime, Office, Azure C++ SDK, and increasingly modern C++/WinRT for Universal Windows Platform apps.

**C++/WinRT**: The modern C++ projection of the Windows Runtime. Replaced the older WRL (Windows Runtime C++ Template Library) and ATL/COM patterns.

```cpp
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.UI.Xaml.h>

using namespace winrt;
using namespace Windows::Foundation;
using namespace Windows::Storage;

// C++/WinRT coroutines: Windows async operations integrate with C++20 co_await
IAsyncOperation<hstring> ReadFileAsync(hstring path) {
    StorageFile file = co_await StorageFile::GetFileFromPathAsync(path);
    hstring content  = co_await FileIO::ReadTextAsync(file);
    co_return content;
}

// Windows Runtime types use reference semantics (COM-like)
// hstring: immutable Windows string (analogous to std::string_view over WinRT)
// IAsyncOperation<T>: Windows async primitive that integrates with co_await
```

**COM (Component Object Model)**: Legacy but still pervasive in Windows system programming. DirectX uses COM interfaces.

```cpp
#include <d3d12.h>
#include <wrl/client.h>  // Microsoft::WRL::ComPtr

// ComPtr: smart pointer for COM interfaces (AddRef/Release managed automatically)
Microsoft::WRL::ComPtr<ID3D12Device> device;
HRESULT hr = D3D12CreateDevice(nullptr, D3D_FEATURE_LEVEL_11_0,
                                IID_PPV_ARGS(&device));
if (FAILED(hr)) {
    // COM error handling, HRESULTs, not exceptions
}

// ComPtr manages AddRef/Release via RAII
// operator-> works on the COM interface directly
device->CreateCommandQueue(/* ... */);
```

**MSVC-specific pragmas and extensions**:
```cpp
#pragma once                          // Microsoft's preferred include guard
__declspec(dllexport) void my_func(); // DLL export annotation
__declspec(novtable)  class Base {};  // optimization: skip vtable init for abstract base
__forceinline int hot_path() { /* */ } // MSVC force-inline
```

**Interview signal**: Know `ComPtr` and why it exists (COM reference counting). Understand `co_await` with Windows async operations. Be prepared to discuss the difference between C++/WinRT, WRL, and ATL.

---

### Amazon

**Codebase**: Amazon's C++ work spans AWS SDK for C++, Aurora storage engine, DynamoDB, and FreeRTOS for IoT devices (Greengrass). Amazon is unique in its heavy use of C++ in embedded/IoT contexts alongside cloud-scale services.

**AWS SDK for C++**:

```cpp
#include <aws/core/Aws.h>
#include <aws/s3/S3Client.h>
#include <aws/s3/model/GetObjectRequest.h>
#include <aws/s3/model/PutObjectRequest.h>

Aws::SDKOptions options;
Aws::InitAPI(options);  // must be called once at startup

{
    Aws::S3::S3Client s3_client;

    // GetObject: download from S3
    Aws::S3::Model::GetObjectRequest request;
    request.SetBucket("my-bucket");
    request.SetKey("my-key");

    auto outcome = s3_client.GetObject(request);
    if (outcome.IsSuccess()) {
        auto& body = outcome.GetResult().GetBody();
        std::string content{std::istreambuf_iterator<char>(body), {}};
    } else {
        auto& error = outcome.GetError();
        std::cerr << error.GetExceptionName() << ": " << error.GetMessage() << "\n";
    }
}

Aws::ShutdownAPI(options);
```

**Outcome pattern**: AWS SDK uses `Aws::Utils::Outcome<Result, Error>` (similar to `absl::StatusOr` or Rust's `Result<T, E>`) instead of exceptions. Every SDK call returns an outcome. Checking `IsSuccess()` before accessing `GetResult()` is mandatory.

**FreeRTOS and embedded C++**: Amazon contributes to FreeRTOS and uses C++ for Greengrass Lambda functions. Embedded constraints: no STL (or only freestanding subset), no dynamic allocation (or pool-only), no RTTI, no exceptions. Stack sizes are 512 bytes to 4 KB.

```cpp
// FreeRTOS task (C API, but often wrapped in C++ classes)
#include "FreeRTOS.h"
#include "task.h"

void sensor_task(void* params) {
    // No new/delete, use pvPortMalloc/vPortFree or static allocation
    static uint8_t buf[256];  // static storage only in embedded
    for (;;) {
        read_sensor(buf);
        vTaskDelay(pdMS_TO_TICKS(100));  // yield for 100 ms
    }
}

// C++ wrapper:
class SensorTask {
    static constexpr uint32_t kStackDepth = 512;
    StaticTask_t task_buffer_;
    StackType_t  stack_[kStackDepth];
public:
    SensorTask() {
        xTaskCreateStatic(sensor_task, "sensor", kStackDepth,
                          nullptr, 1, stack_, &task_buffer_);
    }
};
```

**Database internals**: Aurora and DynamoDB storage engines are C++ codebases with strong emphasis on:
- Lock-free B-tree variants for indexing
- Custom allocators for page caches
- NUMA-aware memory management for storage servers
- `io_uring` for async I/O on modern Linux kernels

**Interview signal**: Know the AWS SDK's Outcome pattern. Be prepared to discuss C++ in resource-constrained environments (no exceptions, no dynamic allocation, static task stacks). For database roles, discuss MVCC, buffer pool managers, and write-ahead logging.

---
