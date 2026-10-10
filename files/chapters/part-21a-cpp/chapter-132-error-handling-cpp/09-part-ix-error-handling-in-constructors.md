## Part IX: Error Handling in Constructors

Constructors are a special problem because they have no return value. There are three approaches.

### Approach 1: Throw from the Constructor

The most idiomatic C++ approach:

```cpp
#include <stdexcept>
#include <string>
#include <fstream>
#include <memory>

class ConfigFile {
public:
    explicit ConfigFile(const std::string& path) {
        file_.open(path);
        if (!file_.is_open()) {
            throw std::runtime_error("Cannot open config file: " + path);
        }

        // Parse the file
        std::string line;
        while (std::getline(file_, line)) {
            auto pos = line.find('=');
            if (pos == std::string::npos) {
                throw std::runtime_error("Invalid config line: " + line);
            }
            entries_[line.substr(0, pos)] = line.substr(pos + 1);
        }
    }

    const std::string& get(const std::string& key) const {
        auto it = entries_.find(key);
        if (it == entries_.end()) {
            throw std::out_of_range("Config key not found: " + key);
        }
        return it->second;
    }

private:
    std::ifstream file_;
    std::map<std::string, std::string> entries_;
};
```

If the constructor throws, the object was never constructed. The destructor is not called (only fully-constructed sub-objects are destroyed). This is clean and safe.

### Approach 2: Factory Functions

When exceptions are banned or when construction is complex:

```cpp
#include <expected>
#include <memory>
#include <string>

class DatabaseConnection {
public:
    // Factory function returns expected
    static std::expected<DatabaseConnection, std::string>
    create(const std::string& connection_string) {
        // Validate the connection string
        if (connection_string.empty()) {
            return std::unexpected("Empty connection string");
        }

        // Attempt connection
        void* handle = connect_to_db(connection_string);
        if (!handle) {
            return std::unexpected("Failed to connect to: " + connection_string);
        }

        // Private constructor - can only be called from factory
        return DatabaseConnection(handle, connection_string);
    }

    // For heap allocation (unique_ptr)
    static std::expected<std::unique_ptr<DatabaseConnection>, std::string>
    create_unique(const std::string& connection_string) {
        auto result = create(connection_string);
        if (!result) {
            return std::unexpected(result.error());
        }
        return std::make_unique<DatabaseConnection>(std::move(*result));
    }

    ~DatabaseConnection() {
        if (handle_) disconnect(handle_);
    }

    // Move-only (connections should not be copied)
    DatabaseConnection(DatabaseConnection&& other) noexcept
        : handle_(std::exchange(other.handle_, nullptr))
        , conn_str_(std::move(other.conn_str_)) {}

    DatabaseConnection& operator=(DatabaseConnection&& other) noexcept {
        if (this != &other) {
            if (handle_) disconnect(handle_);
            handle_ = std::exchange(other.handle_, nullptr);
            conn_str_ = std::move(other.conn_str_);
        }
        return *this;
    }

    DatabaseConnection(const DatabaseConnection&) = delete;
    DatabaseConnection& operator=(const DatabaseConnection&) = delete;

private:
    // Private constructor - only factory can call
    DatabaseConnection(void* handle, std::string conn_str)
        : handle_(handle), conn_str_(std::move(conn_str)) {}

    static void* connect_to_db(const std::string&);
    static void disconnect(void*);

    void* handle_ = nullptr;
    std::string conn_str_;
};

// Usage
void example() {
    auto conn = DatabaseConnection::create("host=localhost;db=myapp");
    if (!conn) {
        std::cerr << "Connection failed: " << conn.error() << "\n";
        return;
    }

    // Use *conn safely
    process_data(*conn);
}
```

### Approach 3: Two-Phase Initialization (Legacy Pattern)

This pattern separates construction from initialization. It is generally considered an anti-pattern in modern C++ but exists in many legacy codebases:

```cpp
class LegacyResource {
public:
    LegacyResource() = default;  // Phase 1: trivial construction

    // Phase 2: actual initialization that can fail
    bool initialize(const std::string& config) {
        handle_ = acquire_resource(config);
        if (!handle_) {
            error_message_ = "Failed to acquire resource";
            return false;
        }
        initialized_ = true;
        return true;
    }

    // Every method must check if initialized
    bool do_work() {
        if (!initialized_) {
            error_message_ = "Not initialized";
            return false;
        }
        // ... actual work
        return true;
    }

    const std::string& last_error() const { return error_message_; }

private:
    void* handle_ = nullptr;
    bool initialized_ = false;
    std::string error_message_;
};
```

**Why this is an anti-pattern:**

1. Every method must check `initialized_`. Forgetting one check is a bug.
2. The object exists in an invalid state between construction and initialization.
3. It is easy to use the object without calling `initialize()`.
4. The type system provides no compile-time enforcement.

Factory functions with `std::expected` solve all these problems while remaining exception-free.

---

### Junior → FAANG: Factory Functions as the Go-Friendly C++ Constructor Pattern

Go does not have constructors. It has factory functions (`NewFoo(args) (*Foo, error)`). The factory function pattern in C++ is the closest equivalent: a static method that returns `std::expected<Foo, Error>` or `absl::StatusOr<Foo>`. This pattern is preferred in exception-disabled codebases and is increasingly recommended even where exceptions are enabled because it makes error handling explicit in the type system.

Practice: take any C++ class that has a constructor that can fail and refactor it to use a factory function pattern. Verify that all callers handle the error case.

### Senior @ FAANG: Factory Functions, Two-Phase Initialization Trade-offs, and Type State

At the staff level, the choice between exceptions in constructors and factory functions is a design pattern choice with readability, safety, and ABI implications.

**Type state encoding.** A class that uses two-phase initialization (constructor + `Init()`) is in an "uninitialized" state between the constructor and `Init()`. If the `Init()` call is forgotten, all subsequent operations on the object are called on an invalid object. The fix: encode the state in the type. A factory function that returns `std::expected<Initialized, Error>` makes the uninitialized state unrepresentable, which is the strongest possible safety guarantee.

**ABI implications of factory functions.** A factory function that returns `absl::StatusOr<std::unique_ptr<Foo>>` has a stable ABI: the returned type is a standard Abseil type, and changes to `Foo`'s internal structure do not affect the ABI of the factory function signature (as long as the pointer type is unchanged). This is better than a constructor return type for shared library APIs. A staff engineer designing a shared library API defaults to factory functions for complex types.

