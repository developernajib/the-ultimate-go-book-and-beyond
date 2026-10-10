## Builder with Method Chaining

Constructors with many parameters are unreadable: `HttpRequest(host, port, path, method, body, timeout, retry_count, follow_redirects, auth_header, content_type)`, which argument is which? The Builder pattern with method chaining (the "fluent interface") solves this with named, composable configuration calls. C++ adds an interesting wrinkle: CRTP allows builder inheritance without repeated boilerplate.

### The Named Parameter Problem

A ten-parameter constructor like `HttpRequest("api.example.com", 443, "/users/42", "GET", "", 5000, 3, true, "Bearer xyz", "application/json")` is impossible to read at the call site, positional arguments carry no names, and swapping two `bool` or `int` arguments silently compiles. The fluent builder below eliminates this hazard by making every option self-documenting and independently defaultable.
```cpp
// Unreadable: what do these arguments mean?
auto req = HttpRequest("api.example.com", 443, "/users/42",
                       "GET", "", 5000, 3, true, "Bearer xyz", "application/json");

// Readable: intent is clear, order doesn't matter, defaults apply
auto req = HttpRequestBuilder()
    .host("api.example.com")
    .port(443)
    .path("/users/42")
    .method(HttpMethod::GET)
    .timeout(std::chrono::milliseconds(5000))
    .retries(3)
    .follow_redirects(true)
    .auth_bearer("Bearer xyz")
    .content_type("application/json")
    .build();
```

### Full HttpRequestBuilder Implementation

`HttpRequestBuilder` stores configuration as private member fields and returns `*this` from every setter so calls can be chained. The terminal `build()` method validates required fields and constructs the immutable `HttpRequest`, ensuring an invalid configuration cannot escape the builder without a compile-time or explicit runtime error.
```cpp
#include <string>
#include <optional>
#include <chrono>
#include <stdexcept>
#include <unordered_map>

enum class HttpMethod { GET, POST, PUT, DELETE, PATCH, HEAD };

struct HttpRequest {
    std::string                                host;
    uint16_t                                   port          = 443;
    std::string                                path          = "/";
    HttpMethod                                 method        = HttpMethod::GET;
    std::string                                body;
    std::chrono::milliseconds                  timeout       = std::chrono::seconds(30);
    int                                        max_retries   = 0;
    bool                                       follow_redirects = true;
    std::unordered_map<std::string, std::string> headers;
};

class HttpRequestBuilder {
    HttpRequest req_;

public:
    // Each setter returns *this by reference for chaining
    HttpRequestBuilder& host(std::string h) {
        req_.host = std::move(h);
        return *this;
    }

    HttpRequestBuilder& port(uint16_t p) {
        req_.port = p;
        return *this;
    }

    HttpRequestBuilder& path(std::string p) {
        req_.path = std::move(p);
        return *this;
    }

    HttpRequestBuilder& method(HttpMethod m) {
        req_.method = m;
        return *this;
    }

    HttpRequestBuilder& body(std::string b) {
        req_.body = std::move(b);
        return *this;
    }

    HttpRequestBuilder& timeout(std::chrono::milliseconds ms) {
        req_.timeout = ms;
        return *this;
    }

    HttpRequestBuilder& retries(int n) {
        req_.max_retries = n;
        return *this;
    }

    HttpRequestBuilder& follow_redirects(bool f = true) {
        req_.follow_redirects = f;
        return *this;
    }

    HttpRequestBuilder& header(std::string key, std::string value) {
        req_.headers[std::move(key)] = std::move(value);
        return *this;
    }

    HttpRequestBuilder& auth_bearer(std::string token) {
        return header("Authorization", "Bearer " + std::move(token));
    }

    HttpRequestBuilder& content_type(std::string ct) {
        return header("Content-Type", std::move(ct));
    }

    HttpRequestBuilder& json_body(std::string json) {
        content_type("application/json");
        return body(std::move(json));
    }

    // Validation on build -- ensures required fields are set
    [[nodiscard]] HttpRequest build() {
        if (req_.host.empty()) {
            throw std::invalid_argument("HttpRequest: host is required");
        }
        if (req_.path.empty() || req_.path[0] != '/') {
            throw std::invalid_argument("HttpRequest: path must start with '/'");
        }
        if (req_.method == HttpMethod::POST || req_.method == HttpMethod::PUT) {
            if (req_.body.empty()) {
                req_.headers.emplace("Content-Length", "0");
            }
        }
        return std::move(req_);
    }
};

// ---- Usage -----------------------------------------------------------------

HttpRequest get_user(int user_id, const std::string& token) {
    return HttpRequestBuilder()
        .host("api.example.com")
        .path("/users/" + std::to_string(user_id))
        .method(HttpMethod::GET)
        .auth_bearer(token)
        .timeout(std::chrono::seconds(10))
        .retries(2)
        .build();
}

HttpRequest create_post(const std::string& json_body, const std::string& token) {
    return HttpRequestBuilder()
        .host("api.example.com")
        .path("/posts")
        .method(HttpMethod::POST)
        .json_body(json_body)
        .auth_bearer(token)
        .build();
}
```

### Returning by Value vs Returning *this

The example above returns `*this` by reference. An alternative is to return a new builder by value on each call. This enables immutable builder chaining, useful if you want to fork configurations:

```cpp
// Immutable builder: each call returns a NEW builder (copy of current state)
class ImmutableBuilder {
    HttpRequest req_;

public:
    [[nodiscard]] ImmutableBuilder host(std::string h) const {
        auto copy = *this;
        copy.req_.host = std::move(h);
        return copy;  // Returns new builder, original unchanged
    }
    // ... other setters ...
};

// Fork: two requests sharing a base configuration
auto base = ImmutableBuilder().host("api.example.com").timeout(seconds(30));
auto get  = base.path("/users").method(HttpMethod::GET).build();
auto post = base.path("/users").method(HttpMethod::POST).json_body(body).build();
```

The mutable reference-returning approach is more efficient (no copies). The immutable value-returning approach is safer when building request templates that are reused.

### CRTP for Builder Inheritance

If your builder has a base class (e.g., `BaseRequestBuilder` and `AuthenticatedRequestBuilder`), returning `*this` from base class methods returns a `BaseRequestBuilder&`, not the derived type, breaking the fluent chain. CRTP (Curiously Recurring Template Pattern) fixes this:

```cpp
template <typename Derived>
class BaseBuilder {
protected:
    HttpRequest req_;

    Derived& self() { return static_cast<Derived&>(*this); }

public:
    Derived& host(std::string h)  { req_.host = std::move(h); return self(); }
    Derived& path(std::string p)  { req_.path = std::move(p); return self(); }
    Derived& timeout(std::chrono::milliseconds ms) {
        req_.timeout = ms;
        return self();
    }
};

// Derived builder adds auth methods, inherits all base methods
class AuthRequestBuilder : public BaseBuilder<AuthRequestBuilder> {
public:
    AuthRequestBuilder& bearer_token(std::string token) {
        req_.headers["Authorization"] = "Bearer " + std::move(token);
        return *this;
    }

    AuthRequestBuilder& api_key(std::string key) {
        req_.headers["X-API-Key"] = std::move(key);
        return *this;
    }

    [[nodiscard]] HttpRequest build() { return std::move(req_); }
};

// Chain works correctly: host() returns AuthRequestBuilder&, not BaseBuilder&
auto req = AuthRequestBuilder()
    .host("api.example.com")   // Returns AuthRequestBuilder& (via CRTP)
    .path("/data")             // Returns AuthRequestBuilder& (via CRTP)
    .bearer_token("xyz")       // Returns AuthRequestBuilder& (defined in derived)
    .build();
```

### Go Comparison: Functional Options

Go engineers typically solve this with the functional options pattern:

```go
package main

import "time"

type HttpRequest struct {
    Host    string
    Port    uint16
    Path    string
    Timeout time.Duration
}

type Option func(*HttpRequest)

func WithPort(p uint16) Option { return func(r *HttpRequest) { r.Port = p } }
func WithTimeout(d time.Duration) Option { return func(r *HttpRequest) { r.Timeout = d } }

func NewHttpRequest(host string, opts ...Option) HttpRequest {
    r := HttpRequest{Host: host, Port: 443, Timeout: 30 * time.Second}
    for _, opt := range opts {
        opt(&r)
    }
    return r
}

func main() {
    // Usage
    req := NewHttpRequest("api.example.com",
        WithPort(8443),
        WithTimeout(10*time.Second),
    )
    _ = req
}
```

Go's functional options are idiomatic, composable, and allow default values. The C++ Builder pattern is equivalent but uses method chaining instead of closures. The Go approach is slightly more extensible (anyone can add new option functions without modifying the builder), while the C++ builder centralizes validation in `build()`. For complex validation logic, the C++ builder is cleaner. For open extension points, functional options win.

---
