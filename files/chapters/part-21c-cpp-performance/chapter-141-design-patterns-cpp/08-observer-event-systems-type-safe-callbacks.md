## Observer/Event Systems with Type-Safe Callbacks

The classic Observer pattern, a subject notifying a list of observers through a virtual `update()` method, breaks down in production for two reasons: lifetime management (dangling observer pointers after observers are destroyed) and type safety (all observers receive the same opaque notification). Modern C++ fixes both with `std::function`, `weak_ptr`, and templated event buses.

### The Classic Observer Problem

The classic observer stores raw pointers to `EventListener` objects, creating a dangling-pointer hazard when an observer is destroyed before unregistering itself from the subject. The code below shows the minimal form of this pattern so the lifetime and type-safety deficiencies become explicit before the modern `std::function`/`weak_ptr` replacement is introduced.
```cpp
// Classic: observers must outlive the subject, no way to enforce this
class EventListener {
public:
    virtual void on_event(const std::string& event) = 0;
    virtual ~EventListener() = default;
};

class Button {
    std::vector<EventListener*> listeners_;

public:
    void add_listener(EventListener* l) { listeners_.push_back(l); }

    void click() {
        for (auto* l : listeners_) l->on_event("click");
        // If any listener was destroyed: undefined behavior, silent crash
    }
};
```

Three problems: raw pointers can dangle, all events are `std::string` (unsafe), and removing a listener requires O(n) scan.

### std::function Observer with Registration Handles

Replace raw pointers with `std::function` and return a registration handle that unregisters on destruction:

```cpp
#include <functional>
#include <vector>
#include <cstdint>
#include <algorithm>

class Signal {
public:
    using Callback   = std::function<void()>;
    using HandleId   = std::uint64_t;

    struct Handle {
        Signal*  signal = nullptr;
        HandleId id     = 0;

        Handle() = default;
        Handle(Signal* s, HandleId i) : signal(s), id(i) {}

        Handle(const Handle&) = delete;
        Handle& operator=(const Handle&) = delete;

        Handle(Handle&& o) noexcept : signal(o.signal), id(o.id) {
            o.signal = nullptr;
        }
        Handle& operator=(Handle&& o) noexcept {
            disconnect();
            signal = o.signal; id = o.id;
            o.signal = nullptr;
            return *this;
        }

        // RAII: auto-disconnect when handle is destroyed
        ~Handle() { disconnect(); }

        void disconnect() {
            if (signal) {
                signal->unsubscribe(id);
                signal = nullptr;
            }
        }
    };

    [[nodiscard]] Handle subscribe(Callback cb) {
        HandleId id = next_id_++;
        callbacks_.push_back({id, std::move(cb)});
        return Handle{this, id};
    }

    void emit() {
        // Copy to allow callbacks to modify callbacks_ safely
        auto snapshot = callbacks_;
        for (auto& [id, cb] : snapshot) cb();
    }

private:
    void unsubscribe(HandleId id) {
        auto it = std::find_if(callbacks_.begin(), callbacks_.end(),
            [id](const auto& entry) { return entry.first == id; });
        if (it != callbacks_.end()) callbacks_.erase(it);
    }

    std::vector<std::pair<HandleId, Callback>> callbacks_;
    HandleId next_id_ = 1;
};
```

The handle's destructor calls `disconnect()` automatically, RAII lifetime management for subscriptions:

```cpp
void setup_ui() {
    Button btn;
    Signal on_click;

    // handle keeps the subscription alive - when handle goes out of scope,
    // the callback is automatically removed from on_click's list
    auto handle = on_click.subscribe([]{ std::cout << "clicked\n"; });

    on_click.emit();  // Fires
    // handle destroyed here: subscription removed automatically
    on_click.emit();  // Does not fire
}
```

### Type-Safe Event Bus with Templates

A real application has dozens of event types. A single-signal class per event type does not scale. A templated event bus allows each event type to have its own strongly-typed subscribers:

```cpp
#include <functional>
#include <unordered_map>
#include <typeindex>
#include <any>
#include <vector>
#include <memory>

class EventBus {
public:
    template <typename EventType>
    using Handler = std::function<void(const EventType&)>;

    template <typename EventType>
    [[nodiscard]] Signal::Handle subscribe(Handler<EventType> handler) {
        auto& list = get_list<EventType>();
        return list.subscribe([h = std::move(handler)](const void* ev) {
            h(*static_cast<const EventType*>(ev));
        });
    }

    template <typename EventType>
    void publish(const EventType& event) {
        auto& list = get_list<EventType>();
        list.emit_typed(&event);
    }

private:
    struct TypedSignal {
        using RawCallback = std::function<void(const void*)>;
        std::vector<std::pair<std::uint64_t, RawCallback>> callbacks;
        std::uint64_t next_id = 1;

        std::uint64_t subscribe(RawCallback cb) {
            auto id = next_id++;
            callbacks.push_back({id, std::move(cb)});
            return id;
        }

        void unsubscribe(std::uint64_t id) {
            auto it = std::find_if(callbacks.begin(), callbacks.end(),
                [id](const auto& p){ return p.first == id; });
            if (it != callbacks.end()) callbacks.erase(it);
        }

        void emit_typed(const void* ev) {
            auto snap = callbacks;
            for (auto& [id, cb] : snap) cb(ev);
        }
    };

    template <typename EventType>
    TypedSignal& get_list() {
        auto key = std::type_index(typeid(EventType));
        return signals_[key];
    }

    std::unordered_map<std::type_index, TypedSignal> signals_;
};

// ---- Usage -----------------------------------------------------------------

struct PlayerDied   { int player_id; std::string cause; };
struct ScoreChanged { int player_id; int new_score; };
struct GameOver     { int winner_id; };

void demo_event_bus() {
    EventBus bus;

    auto h1 = bus.subscribe<PlayerDied>([](const PlayerDied& ev) {
        std::cout << "Player " << ev.player_id
                  << " died: " << ev.cause << '\n';
    });

    auto h2 = bus.subscribe<ScoreChanged>([](const ScoreChanged& ev) {
        std::cout << "Score[" << ev.player_id << "] = " << ev.new_score << '\n';
    });

    bus.publish(ScoreChanged{ .player_id = 1, .new_score = 100 });
    bus.publish(PlayerDied{   .player_id = 2, .cause = "fall damage" });
    // h1 and h2 unsubscribe automatically when destroyed
}
```

### Thread-Safe Event Dispatch

For multi-threaded systems, protect the subscriber list with a mutex and dispatch on a dedicated thread:

```cpp
#include <mutex>
#include <queue>
#include <thread>
#include <condition_variable>

template <typename EventType>
class AsyncEventBus {
    using Handler = std::function<void(const EventType&)>;

    std::vector<Handler>    handlers_;
    std::queue<EventType>   queue_;
    mutable std::mutex      mu_;
    std::condition_variable cv_;
    std::thread             dispatcher_;
    bool                    running_ = true;

public:
    AsyncEventBus() {
        dispatcher_ = std::thread([this] {
            std::unique_lock lock(mu_);
            while (running_ || !queue_.empty()) {
                cv_.wait(lock, [this]{ return !queue_.empty() || !running_; });
                while (!queue_.empty()) {
                    auto ev = std::move(queue_.front());
                    queue_.pop();
                    lock.unlock();
                    for (auto& h : handlers_) h(ev);
                    lock.lock();
                }
            }
        });
    }

    ~AsyncEventBus() {
        { std::lock_guard lock(mu_); running_ = false; }
        cv_.notify_all();
        dispatcher_.join();
    }

    void subscribe(Handler h) {
        std::lock_guard lock(mu_);
        handlers_.push_back(std::move(h));
    }

    void publish(EventType ev) {
        { std::lock_guard lock(mu_); queue_.push(std::move(ev)); }
        cv_.notify_one();
    }
};
```

### Go Comparison: Channels as Event Buses

Go engineers typically use channels as event buses:

```go
type PlayerDied struct { PlayerID int; Cause string }

bus := make(chan PlayerDied, 100)

// Subscriber
go func() {
    for ev := range bus {
        fmt.Printf("Player %d died: %s\n", ev.PlayerID, ev.Cause)
    }
}()

// Publisher
bus <- PlayerDied{PlayerID: 2, Cause: "fall damage"}
```

Go channels are inherently type-safe per channel and provide natural backpressure. The limitation: a channel is single-type and single-subscriber (or requires fan-out machinery). The C++ event bus above supports multiple subscribers and multiple event types through one registration point. Go would need a separate channel per event type, plus goroutines for fan-out, more infrastructure but more explicit about concurrency.

---
