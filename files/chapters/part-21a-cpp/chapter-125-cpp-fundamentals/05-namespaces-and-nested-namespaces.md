## Namespaces and Nested Namespaces

Go organizes code into packages. C++ uses namespaces, which serve a similar purpose but with different semantics.

### Basic Namespaces

**In Go:**

```go
// File: mathutil/mathutil.go
package mathutil

func Add(a, b int) int {
    return a + b
}
```

```go
// File: main.go
package main

import "myproject/mathutil"

func main() {
    _ = mathutil.Add(1, 2)
}
```

**In C++:**

```cpp
// Declaring a namespace
namespace mathutil {
    int add(int a, int b) {
        return a + b;
    }

    double pi() {
        return 3.14159265358979323846;
    }
}

// Using the namespace
int main() {
    int result = mathutil::add(1, 2);  // :: is the scope resolution operator
    double p = mathutil::pi();
    return 0;
}
```

### Nested Namespaces

**In Go:**

```go
// File: myproject/cloud/storage/client.go
package storage

type Client struct{}

func NewClient() *Client {
    return &Client{}
}
```

```go
// File: myproject/main.go
package main

import "myproject/cloud/storage"

func main() {
    c := storage.NewClient()
    _ = c
}
```

**In C++:**

```cpp
// C++17 nested namespace syntax (compact)
namespace company::cloud::storage {
    class Client {
    public:
        void connect() { /* ... */ }
    };
}

// Pre-C++17 (verbose)
namespace company {
    namespace cloud {
        namespace storage {
            class Client {
            public:
                void connect() { /* ... */ }
            };
        }
    }
}

// Usage
company::cloud::storage::Client client;
client.connect();

// Using declarations to shorten names
using company::cloud::storage::Client;
Client client2;

// Using directive (imports entire namespace - use sparingly)
using namespace company::cloud::storage;
Client client3;
```

### Key Differences: Namespaces vs Packages

| Feature | Go Packages | C++ Namespaces |
|---|---|---|
| Access control | Uppercase = exported | `public`/`private` in classes. Everything in namespace is accessible |
| File mapping | One package per directory | Namespaces can span multiple files |
| Nesting | Via directory structure | Directly in code |
| Aliasing | `import alias "path"` | `namespace alias = long::name::space;` |
| Using | Always qualified (`pkg.Name`) | `using` declarations or `::` |
| Cyclic deps | Forbidden | Allowed (but discouraged) |

### The `using namespace std;` Debate

You will see `using namespace std;` in many tutorials. In production code, this is considered harmful because it pollutes the global namespace and can cause name collisions.

```cpp
// BAD: in header files or large scopes
using namespace std;  // pulls ALL of std into scope
// Now if you have a function called "count" or "find",
// it collides with std::count and std::find

// OK: in a small, local scope
void process() {
    using namespace std; // limited to this function
    cout << "hello\n";
}

// BEST: use specific declarations
using std::cout;
using std::string;
using std::vector;

// Or just use the full qualification (recommended)
std::cout << "hello\n";
std::vector<int> v;
```

---

### Junior → FAANG: Namespace Hygiene as a Professionalism Signal

The biggest namespace mistake for beginners is `using namespace std;` at file or global scope. It pollutes the global namespace and can cause silent name collisions that produce wrong behavior without any compiler error. In a FAANG codebase, this is an instant code review rejection. Practice writing `std::` explicitly until it is automatic.

The second common mistake is not understanding that `using` declarations in header files affect every file that includes that header. This is how one careless `using namespace foo;` in a widely-included header can silently change name resolution in hundreds of translation units. Never put `using namespace` in a header file.

Interview note: "explain ADL (Argument-Dependent Lookup)" is a common C++ interview question at L5+. The short answer: when you call a function without qualification (`swap(a, b)`), the compiler also searches the namespace of the argument types. This is why `std::swap` is found without `std::` when `a` and `b` are `std` types. It is also why customization points (your own `swap` for your type) work without the caller knowing your namespace.

### Senior @ FAANG: Namespace Policy, Inline Namespaces for Versioning, and ADL Pitfalls at Scale

At the staff level, namespace structure is an API design decision with long-term versioning implications.

**Inline namespaces for ABI versioning.** When your library evolves and you need to ship `v2` of a type that is ABI-incompatible with `v1`, inline namespaces let you maintain both simultaneously. The outer namespace (`mylib`) contains an inline namespace (`mylib::v2`, inline, so `mylib::Foo` resolves to `mylib::v2::Foo`). Old compiled code that linked against `mylib::v1::Foo` still works because the symbol name is `mylib::v1::Foo`. This pattern is used in Abseil and libc++ for exactly this purpose. A staff engineer designing a library that may need ABI-compatible evolution should understand and plan for inline namespace versioning from the start.

**Namespace organization for large codebases.** A 10M LOC codebase cannot have flat namespaces. Google's internal codebase uses deep namespaces that mirror directory structure. Abseil uses `absl::`. Folly uses `folly::`. The convention matters for discoverability and for reducing ADL ambiguity. A staff engineer defines the namespace policy: what is the top-level namespace for the org's code, what are the rules for subnamespace creation, and how are internal (implementation-detail) namespaces named (`detail::`, `internal::`, `impl::`)?

**ADL in generic code at scale.** ADL is a correctness hazard in generic (template) code. When a template function calls `to_string(x)` without qualification, ADL finds the `to_string` in `x`'s namespace. If two different types have incompatible `to_string` overloads in different namespaces, the template may behave differently for each type in ways that are hard to trace. The safe pattern for generic code: use explicit namespace qualification for all non-customization-point functions, and use Niebloids (function objects, not free functions) for customization points that should be overridable. This is the approach taken by C++20 ranges.

