## State Machines with std::variant

State machines encoded as `enum + switch` are ubiquitous and fragile. Adding a state requires updating every switch, state-specific data gets folded into the parent struct as a tangle of optional fields, and the compiler cannot enforce transition correctness. Encoding states as `std::variant`, where each state is a distinct type holding only its relevant data, produces self-documenting, compiler-enforced state machines.

### The Problem with Enum State Machines

The enum-based TCP state machine below accumulates all possible state fields into one struct, so fields like `listen_backlog` are present even in the `Established` state where they are meaningless. This forces defensive null checks throughout and prevents the compiler from catching invalid state-field combinations at compile time.
```cpp
// Common approach: enum state + a blob of optional fields
enum class TcpState { Closed, Listen, SynReceived, Established, CloseWait };

struct TcpConnection {
    TcpState state = TcpState::Closed;

    // These fields are only meaningful in certain states, but the
    // struct always carries them. No compiler enforcement of validity.
    uint32_t remote_seq = 0;     // Only valid after SYN
    uint32_t local_seq  = 0;     // Only valid after SYN
    int      socket_fd  = -1;    // Only valid when Established
    uint16_t remote_port = 0;
};

void on_event(TcpConnection& conn, Event ev) {
    switch (conn.state) {
        case TcpState::Closed:
            if (ev == Event::Listen) {
                conn.state = TcpState::Listen;
            }
            break;
        // ... every state × every event ...
        // Missing a case is silently ignored
    }
}
```

The problem: `remote_seq` is only valid in `Established`, but nothing prevents you from reading it in `Closed`. The state machine's invariants live only in the programmer's head.

### States as Variant Types

Each state becomes a struct holding exactly the data that state needs:

```cpp
#include <variant>
#include <string>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <iostream>

// ---- State types: each holds only the data relevant to that state ----------

struct Closed   {};  // No data -- connection does not exist

struct Listening {
    uint16_t local_port;
};

struct SynReceived {
    uint16_t local_port;
    uint16_t remote_port;
    uint32_t their_seq;   // SYN sequence number from peer
    uint32_t our_seq;     // Our ISN
};

struct Established {
    uint16_t local_port;
    uint16_t remote_port;
    uint32_t their_seq;
    uint32_t our_seq;
    int      socket_fd;
};

struct CloseWait {
    uint16_t local_port;
    uint16_t remote_port;
    uint32_t their_seq;
    uint32_t our_seq;
};

using TcpState = std::variant<
    Closed,
    Listening,
    SynReceived,
    Established,
    CloseWait
>;

// ---- Event types: same approach --------------------------------------------

struct EvListen   { uint16_t port; };
struct EvSynRecv  { uint16_t remote_port; uint32_t their_seq; };
struct EvAck      {};
struct EvFinRecv  {};
struct EvClose    {};

using TcpEvent = std::variant<
    EvListen,
    EvSynRecv,
    EvAck,
    EvFinRecv,
    EvClose
>;
```

### Transition Table via std::visit

The transition function uses nested `std::visit` to match (state, event) pairs. Any unhandled combination is a compile error, or explicitly handled by a default:

```cpp
// Returns the new state. Transitions that are not valid throw.
TcpState transition(const TcpState& state, const TcpEvent& event) {
    return std::visit(overload{

        // --- From Closed ---
        [](const Closed&, const EvListen& ev) -> TcpState {
            std::cout << "Listening on port " << ev.port << '\n';
            return Listening{ .local_port = ev.port };
        },

        // --- From Listening ---
        [](const Listening& s, const EvSynRecv& ev) -> TcpState {
            uint32_t our_isn = 0x1234ABCD;  // In reality: ISN generation
            std::cout << "SYN received from port " << ev.remote_port << '\n';
            return SynReceived{
                .local_port  = s.local_port,
                .remote_port = ev.remote_port,
                .their_seq   = ev.their_seq,
                .our_seq     = our_isn
            };
        },

        // --- From SynReceived ---
        [](const SynReceived& s, const EvAck&) -> TcpState {
            std::cout << "Connection established\n";
            return Established{
                .local_port  = s.local_port,
                .remote_port = s.remote_port,
                .their_seq   = s.their_seq,
                .our_seq     = s.our_seq,
                .socket_fd   = /* accept() */ 42
            };
        },

        // --- From Established ---
        [](const Established& s, const EvFinRecv&) -> TcpState {
            std::cout << "FIN received, entering CloseWait\n";
            return CloseWait{
                .local_port  = s.local_port,
                .remote_port = s.remote_port,
                .their_seq   = s.their_seq,
                .our_seq     = s.our_seq
            };
        },
        [](const Established&, const EvClose&) -> TcpState {
            std::cout << "Active close\n";
            return Closed{};
        },

        // --- From CloseWait ---
        [](const CloseWait&, const EvClose&) -> TcpState {
            std::cout << "Connection closed\n";
            return Closed{};
        },

        // --- Invalid transitions ---
        [](const auto& s, const auto& ev) -> TcpState {
            // In production: log the invalid transition, return unchanged state
            throw std::logic_error("invalid state/event combination");
            return s;  // unreachable, but satisfies return type
        }

    }, state, event);
}
```

### The Connection Object

`TcpConnection` stores its current state as a `TcpState` variant and delegates event processing to a `transition` function that returns the next state. Each state struct carries only the fields relevant to that state, so the compiler enforces that `listen_backlog` cannot be accidentally accessed when the connection is `Established`.
```cpp
class TcpConnection {
    TcpState state_ = Closed{};

public:
    void process(const TcpEvent& event) {
        state_ = transition(state_, event);
    }

    bool is_established() const noexcept {
        return std::holds_alternative<Established>(state_);
    }

    // Access state-specific data -- returns nullptr if wrong state
    const Established* established_state() const noexcept {
        return std::get_if<Established>(&state_);
    }
};

// Usage -- no runtime panics for invalid data access
void demo() {
    TcpConnection conn;
    conn.process(EvListen{.port = 8080});
    conn.process(EvSynRecv{.remote_port = 54321, .their_seq = 100});
    conn.process(EvAck{});

    if (const auto* s = conn.established_state()) {
        std::cout << "fd: " << s->socket_fd << '\n';
        // s->their_seq, s->our_seq are all valid here -- state guarantees it
    }
}
```

### Go Comparison: Channels and Goroutines

Go state machines typically use channels and goroutines:

```go
type TcpConnection struct {
    events chan Event
    done   chan struct{}
    mu     sync.Mutex
    state  string  // "closed", "listening", etc. -- still stringly typed
}

func (c *TcpConnection) loop() {
    for ev := range c.events {
        switch c.state {
        case "closed":
            if ev.Type == "listen" { c.state = "listening" }
        // ...
        }
    }
}
```

Go's idiomatic approach uses concurrency as the state machine substrate: each goroutine is a state, channels are transitions. This is expressive for concurrent state machines but adds goroutine overhead even for simple sequential state tracking. The variant approach is appropriate for synchronous state machines embedded inside a larger system. Go's goroutine approach is appropriate when the state machine itself needs to be concurrent.

Neither enforces exhaustiveness at compile time in Go (type switches have a silent default). The variant approach in C++ does, any unhandled (state, event) pair is a compile error if you don't provide a default lambda.

---
