## Comprehensive Example: Putting It All Together

Here is a complete program that uses most of the concepts covered in this chapter, with annotations for Go developers.

```cpp
// config.h - header file with include guard
#pragma once

#include <string>
#include <cstdint>

namespace app::config {

    // constexpr: compile-time constants (like Go's const)
    constexpr int DEFAULT_PORT = 8080;
    constexpr int MAX_CONNECTIONS = 1000;
    constexpr const char* APP_NAME = "GoDevServer";

    // Struct with methods (like a Go struct with methods)
    struct ServerConfig {
        std::string host = "localhost";
        int port = DEFAULT_PORT;
        int max_connections = MAX_CONNECTIONS;
        bool tls_enabled = false;

        // Method to get the address string
        std::string address() const {
            return host + ":" + std::to_string(port);
        }
    };

    // Function overloading: create config from different inputs
    ServerConfig makeConfig();
    ServerConfig makeConfig(const std::string& host, int port);
    ServerConfig makeConfig(const std::string& address_string);

} // namespace app::config
```

```cpp
// config.cpp - implementation file
#include "config.h"
#include <stdexcept>

namespace app::config {

    // Default config
    ServerConfig makeConfig() {
        return ServerConfig{};  // uses all defaults
    }

    // Config from host and port
    ServerConfig makeConfig(const std::string& host, int port) {
        if (port < 1 || port > 65535) {
            throw std::invalid_argument("port out of range");
        }
        ServerConfig cfg;
        cfg.host = host;
        cfg.port = port;
        return cfg;
    }

    // Config from address string like "host:port"
    ServerConfig makeConfig(const std::string& address_string) {
        auto colon_pos = address_string.find(':');
        if (colon_pos == std::string::npos) {
            throw std::invalid_argument("invalid address format");
        }
        auto host = address_string.substr(0, colon_pos);
        auto port = std::stoi(address_string.substr(colon_pos + 1));
        return makeConfig(host, port);  // calls the two-argument overload
    }

} // namespace app::config
```

```cpp
// main.cpp
#include "config.h"
#include <iostream>
#include <vector>

int main() {
    using namespace app::config;

    // Using function overloading
    auto cfg1 = makeConfig();                        // default
    auto cfg2 = makeConfig("0.0.0.0", 443);         // host + port
    auto cfg3 = makeConfig("api.example.com:9090");  // address string

    // Range-based for loop over a vector of configs
    std::vector<ServerConfig> configs = {cfg1, cfg2, cfg3};

    for (const auto& cfg : configs) {  // const reference: no copy
        std::cout << "Server: " << cfg.address();
        if (cfg.tls_enabled) {
            std::cout << " (TLS)";
        }
        std::cout << "\n";
    }

    // If with initializer (C++17, like Go's if-init)
    if (auto port = cfg2.port; port == 443) {
        std::cout << "Using HTTPS default port\n";
    }

    // Switch with explicit break
    switch (cfg2.port) {
        case 80:
            std::cout << "HTTP\n";
            break;
        case 443:
            std::cout << "HTTPS\n";
            break;
        default:
            std::cout << "Custom port\n";
            break;
    }

    return 0;
}
```

**Build this project:**

```bash
g++ -std=c++17 -Wall -Wextra -Werror -O2 config.cpp main.cpp -o server
./server
```

**Output:**

```text
Server: localhost:8080
Server: 0.0.0.0:443
Server: api.example.com:9090
Using HTTPS default port
HTTPS
```

---

### Junior → FAANG: Reading Comprehensive Examples as Integration Tests of Your Knowledge

A comprehensive example like this one is the best diagnostic tool for identifying which fundamentals are still fuzzy. Read through it and, for every construct you encounter, mentally answer: what would this look like in Go, and what is the C++ behavior difference?

If any construct stops you, that is the construct to study next. Do not move on until you can trace the full program in your head, predict the output, and explain every type, every cast, and every namespace usage.

First-job habit: when you join a C++ team, find the team's integration test that exercises the most surface area and read it the same way. It reveals the actual patterns the team uses, which differ from textbook examples.

### Senior @ FAANG: Comprehensive Examples as Living Documentation

At the staff level, a comprehensive worked example serves as living documentation: it demonstrates the approved patterns for the team, serves as a reference implementation for new engineers, and is the first target for refactoring when patterns evolve.

**Owning the reference implementation.** A staff engineer ensures the team has at least one comprehensive worked example per major subsystem (network handler, storage abstraction, RPC handler). This example is reviewed on every major library upgrade, updated when style guide changes are adopted, and used as the canonical reference in onboarding. The cost of maintaining it is low. The benefit for new engineer productivity is high.

**Using comprehensive examples in interviews.** At the L6 panel level, asking a candidate to trace through a 50-line C++ program and explain every decision is a high-signal exercise. It reveals: do they know the compilation model (they can identify what each construct does), do they have UB intuition (they notice the dangerous pattern), and do they understand Go/C++ differences (they can articulate the equivalent Go and why C++ does it differently)? This is more diagnostic than abstract algorithmic questions for a C++ systems role.

