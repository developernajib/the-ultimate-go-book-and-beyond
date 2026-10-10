## Pimpl Idiom: Compilation Firewall

C++ compiles headers by inclusion. Every `.cpp` file that includes your header recompiles when the header changes, including when you change a private field that callers never touch. In a large codebase, this cascades into multi-minute build times for a one-line change. The Pimpl idiom (Pointer to IMPLementation) solves this by hiding the implementation behind an opaque pointer.

### The Compilation Problem

Consider a `NetworkClient` whose implementation needs OpenSSL, Boost.Asio, and an internal connection pool. Without Pimpl, every translation unit that uses `NetworkClient` transitively includes all of those headers:

```cpp
// network_client.h -- BAD: forces all callers to compile OpenSSL headers
#include <openssl/ssl.h>
#include <boost/asio.hpp>
#include "internal/connection_pool.h"

class NetworkClient {
public:
    NetworkClient(const std::string& host, uint16_t port);
    std::string get(const std::string& path);

private:
    SSL_CTX*                    ssl_ctx_;   // Exposed: callers see openssl types
    boost::asio::io_context     ioc_;       // Exposed: callers see boost types
    internal::ConnectionPool    pool_;      // Exposed: callers see internal types
};
```

Change `ConnectionPool` internals and everything recompiles. Pimpl fixes this.

### Modern Pimpl with unique_ptr

The modern idiom declares the implementation struct in the `.cpp` file only. The header declares a forward declaration and holds a `unique_ptr` to it:

```cpp
// network_client.h -- Clean public API, zero implementation details
#pragma once
#include <memory>
#include <string>
#include <cstdint>

class NetworkClient {
public:
    explicit NetworkClient(const std::string& host, uint16_t port);
    ~NetworkClient();  // Must be defined in .cpp where Impl is complete

    NetworkClient(NetworkClient&&) noexcept;
    NetworkClient& operator=(NetworkClient&&) noexcept;

    // Non-copyable: the connection is a unique resource
    NetworkClient(const NetworkClient&) = delete;
    NetworkClient& operator=(const NetworkClient&) = delete;

    std::string get(const std::string& path);
    void        post(const std::string& path, const std::string& body);
    bool        is_connected() const noexcept;

private:
    struct Impl;                    // Forward declaration only
    std::unique_ptr<Impl> impl_;    // Pointer to hidden implementation
};
```

The implementation file is the only place that knows about `Impl`:

```cpp
// network_client.cpp
#include "network_client.h"

// These heavy headers are now isolated to this one translation unit.
// Changing them only recompiles network_client.cpp.
#include <openssl/ssl.h>
#include <boost/asio.hpp>
#include "internal/connection_pool.h"
#include <stdexcept>

struct NetworkClient::Impl {
    std::string              host;
    uint16_t                 port;
    SSL_CTX*                 ssl_ctx  = nullptr;
    boost::asio::io_context  ioc;
    internal::ConnectionPool pool;

    Impl(const std::string& h, uint16_t p)
        : host(h), port(p)
    {
        ssl_ctx = SSL_CTX_new(TLS_client_method());
        if (!ssl_ctx) throw std::runtime_error("SSL_CTX_new failed");
        pool.connect(host, port, ssl_ctx);
    }

    ~Impl() {
        pool.disconnect();
        if (ssl_ctx) SSL_CTX_free(ssl_ctx);
    }
};

// Constructor: unique_ptr<Impl> requires complete type -- satisfied here
NetworkClient::NetworkClient(const std::string& host, uint16_t port)
    : impl_(std::make_unique<Impl>(host, port))
{}

// Destructor: must be in .cpp where Impl is complete, not in the header.
// unique_ptr's destructor calls delete, which requires a complete type.
NetworkClient::~NetworkClient() = default;

// Move constructor and assignment: default works because unique_ptr is movable
NetworkClient::NetworkClient(NetworkClient&&) noexcept = default;
NetworkClient& NetworkClient::operator=(NetworkClient&&) noexcept = default;

std::string NetworkClient::get(const std::string& path) {
    return impl_->pool.get(path);
}

void NetworkClient::post(const std::string& path, const std::string& body) {
    impl_->pool.post(path, body);
}

bool NetworkClient::is_connected() const noexcept {
    return impl_ && impl_->pool.is_connected();
}
```

### Move Semantics and Pimpl

The most common Pimpl mistake is forgetting the destructor definition. `unique_ptr<Impl>` needs a complete type to call the destructor of `Impl`. If you define `~NetworkClient() = default` in the header, the compiler tries to instantiate `unique_ptr<Impl>::~unique_ptr()` there, where `Impl` is still incomplete. The fix is always: define `~NetworkClient()` in the `.cpp` file, even as `= default`.

```cpp
// WRONG -- in header, Impl is incomplete when unique_ptr destructor instantiates
class NetworkClient {
    ~NetworkClient() = default;  // Compiler error: incomplete type Impl
    std::unique_ptr<Impl> impl_;
};

// CORRECT -- destructor defined in .cpp where Impl is fully defined
// header:  ~NetworkClient();
// .cpp:    NetworkClient::~NetworkClient() = default;
```

Same applies to move operations if the default requires `Impl` to be destructible.

### Pimpl with Shared Ownership

If you need copyable Pimpl semantics (the copy gets its own implementation), use `unique_ptr` and implement a deep-copy constructor:

```cpp
// In .cpp only:
NetworkClient::NetworkClient(const NetworkClient& other)
    : impl_(std::make_unique<Impl>(*other.impl_))
{}
```

If multiple handles should share the same implementation (reference semantics), use `shared_ptr<Impl>` instead. Be aware that `shared_ptr` adds atomic reference counting overhead on every copy.

### Go Comparison: Interface-Based Encapsulation

Go engineers achieve similar encapsulation through unexported types and interfaces:

```go
// Go: callers see only the interface, implementation is hidden
type NetworkClient interface {
    Get(path string) (string, error)
    Post(path string, body string) error
    IsConnected() bool
}

type networkClientImpl struct {  // unexported: callers can't see internals
    host    string
    port    uint16
    tlsCfg  *tls.Config
    pool    *connectionPool
}

func NewNetworkClient(host string, port uint16) NetworkClient {
    return &networkClientImpl{
        host: host,
        port: port,
    }
}
```

Go's approach is arguably simpler: the language enforces encapsulation through package boundaries and unexported identifiers. C++ Pimpl achieves the same effect in a language without package-level encapsulation, at the cost of extra indirection (a heap allocation for `Impl`) and boilerplate.

### When to Use Pimpl

Use Pimpl when:
- A class includes expensive headers (Boost, OpenSSL, platform APIs) that would cascade into caller build times.
- You are shipping a library and want a stable ABI, Pimpl makes it possible to change the implementation without recompiling callers.
- You need a "compiler firewall" for frequently-modified internal classes.

Skip Pimpl when:
- The class is internal and not on a hot path (the extra heap indirection has cost).
- The class is a value type designed for stack allocation.
- Build times are not a concern (small codebase, fast hardware).

The one-indirection cost is typically 1-5 ns, invisible unless the method is called in a tight loop millions of times per second.

---
