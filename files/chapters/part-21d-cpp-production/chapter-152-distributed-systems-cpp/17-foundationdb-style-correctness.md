## FoundationDB-Style Correctness: Simulation-Driven Testing

FoundationDB is unique among production distributed databases in how it is tested. The entire system runs deterministically inside a single process. The test harness injects faults (network partitions, slow disks, clock skew, message loss) and runs millions of simulated cluster-hours per real hour. Bugs that would surface once a year in production show up in 30 minutes of simulation. The talk by Will Wilson at Strange Loop 2014 ("Testing Distributed Systems with Deterministic Simulation") is the canonical introduction.

This section describes the methodology and shows how to apply it in pure C++.

### The Problem with Conventional Testing

Distributed systems fail in ways that are hard to reproduce. A race that fires once in a million scheduling decisions, a bug that needs three specific clock skews and a partition, a tail-latency spike that emerges only under load. Unit tests cover one process, integration tests run too slowly to find rare bugs, production is where the bugs end up surfacing.

Simulation testing eliminates all three limitations:
1. Deterministic: same seed produces the same execution.
2. Fast: simulated time moves as quickly as the CPU can chew through the work.
3. Comprehensive: fault injection covers cases real networks rarely produce.

### The FoundationDB Approach

FoundationDB is implemented in *Flow*, a custom C++ extension that adds futures, actor-style state machines, and deterministic execution. Every I/O operation, every clock read, every random number, every thread (actually they have only one) goes through the simulation framework. In simulation mode, all of these are replaced with deterministic, replayable equivalents.

The FoundationDB engineering team estimates that simulation testing has caught bugs that would have taken years to surface in production. The Apple acquisition of FoundationDB and the subsequent open-sourcing made the methodology widely visible.

### Building Determinism in Pure C++

You do not need a custom language. You need to wrap every nondeterministic primitive.

#### Step 1: Wrap Time

```cpp
class SimClock {
public:
    void Advance(std::chrono::nanoseconds d) { now_ += d; }
    std::chrono::steady_clock::time_point Now() const {
        return std::chrono::steady_clock::time_point{} + now_;
    }
private:
    std::chrono::nanoseconds now_{0};
};
```

In production, this is a thin wrapper over `steady_clock::now()`. In simulation, time only advances when the test harness says so.

#### Step 2: Wrap Randomness

```cpp
class SimRng {
public:
    explicit SimRng(uint64_t seed) : engine_(seed) {}
    uint64_t Next() { return engine_(); }
private:
    std::mt19937_64 engine_;
};
```

Every place in the codebase that needs randomness takes a `SimRng&` parameter. No `std::random_device`, no thread-local global RNGs, no time-based seeding inside the system under test.

#### Step 3: Wrap Networking

The most important wrapping. All sends, receives, and connect operations go through a `Network` interface. In production, the implementation calls into Asio. In simulation, it queues messages onto the simulator's event queue, with optional fault injection.

```cpp
class Network {
public:
    virtual void Send(NodeId dst, std::string_view payload) = 0;
    virtual std::optional<Message> Receive(NodeId self, std::chrono::nanoseconds timeout) = 0;
    virtual ~Network() = default;
};

class SimNetwork : public Network {
public:
    void Send(NodeId dst, std::string_view payload) override {
        if (rng_->Next() % 100 < drop_pct_) return;  // fault injection: drop.
        auto delay = std::chrono::microseconds(rng_->Next() % max_delay_us_);
        sim_clock_->ScheduleAt(sim_clock_->Now() + delay,
            [this, dst, p = std::string(payload)] { Deliver(dst, p); });
    }

    std::optional<Message> Receive(NodeId self, std::chrono::nanoseconds timeout) override {
        auto deadline = sim_clock_->Now() + timeout;
        while (!HasMessage(self) && sim_clock_->Now() < deadline) {
            sim_clock_->RunOneEvent();
        }
        return PopMessage(self);
    }

private:
    SimClock* sim_clock_;
    SimRng* rng_;
    int drop_pct_ = 5;
    int max_delay_us_ = 50000;
};
```

#### Step 4: Wrap Disk

Same pattern. Reads, writes, fsyncs go through an interface. The simulator can inject latency, corruption, or full disk failures.

#### Step 5: A Single-Threaded Event Loop

Distributed-system code is naturally cooperative. A node processes one event (RPC arrival, timer fire, disk completion) at a time. If you build the system on this model from the start, simulation is a drop-in replacement for the production event loop.

```cpp
class EventLoop {
public:
    void RunUntil(std::chrono::nanoseconds deadline) {
        while (!queue_.empty() && queue_.top().when <= clock_->Now() + deadline) {
            auto e = queue_.top(); queue_.pop();
            clock_->AdvanceTo(e.when);
            e.fn();
        }
    }

    void ScheduleAt(std::chrono::steady_clock::time_point when, std::function<void()> fn) {
        queue_.push({when, std::move(fn)});
    }

private:
    struct Event {
        std::chrono::steady_clock::time_point when;
        std::function<void()> fn;
        bool operator<(const Event& o) const { return when > o.when; }  // min-heap
    };
    std::priority_queue<Event> queue_;
    SimClock* clock_;
};
```

This event loop is identical in structure to what FoundationDB's Flow runtime provides. Asio's `io_context` is its production cousin.

### Fault Injection

The simulator picks faults to inject:
- Drop a message with probability p.
- Delay a message by a random amount drawn from a heavy-tailed distribution.
- Reorder messages within a stream.
- Crash a node, optionally restoring it later.
- Partition the network, with the partition shifting over time.
- Slow a disk, sometimes failing writes silently.
- Skew a clock by an interval drawn from the simulator's time-skew distribution.

The fault distribution should be aggressive: more failures than production, more partitions than realistic, more clock skew than the OS would allow. The point is to find bugs, not to reproduce production.

### Property-Based Assertions

The simulator runs the system under fault injection and checks invariants periodically:

- Linearizability: collect operations and timestamps, check serializability.
- Causality: any read returns a value at least as new as the most recent write that returned to the client.
- No data loss: every committed write is readable later.
- Liveness: the cluster eventually accepts new writes (no permanent stall).

When an invariant fails, log the seed, the wall-clock time, and the simulated event sequence. The seed is the only thing the developer needs to reproduce the bug.

### A Production-Grade C++ Simulation Harness

```cpp
class Simulator {
public:
    void RunSeed(uint64_t seed, std::chrono::seconds budget) {
        SimRng rng(seed);
        SimClock clock;
        EventLoop loop(&clock);
        SimNetwork net(&clock, &rng);

        std::vector<std::unique_ptr<RaftNode>> nodes;
        for (int i = 0; i < 5; ++i) nodes.push_back(std::make_unique<RaftNode>(i, &net, &clock));

        // Inject workload.
        loop.ScheduleAt(clock.Now() + 1s, [&] { ClientPropose(nodes, "set x 1"); });

        // Inject faults.
        for (int t = 0; t < 30; ++t) {
            loop.ScheduleAt(clock.Now() + std::chrono::seconds(t),
                            [&] { net.PartitionRandom(&rng); });
        }

        loop.RunUntil(budget);

        CheckInvariants(nodes);
    }
};

int main(int argc, char** argv) {
    Simulator sim;
    for (uint64_t seed = 1; seed < 1'000'000; ++seed) {
        sim.RunSeed(seed, 60s);
    }
}
```

A million seeds in a CI run, each simulating a minute of cluster behavior, finds bugs that real production rarely surfaces.

### Common Bugs Surface Patterns

Patterns the simulator catches reliably:

- A Raft pre-vote bug where a partitioned candidate inflates its term and disrupts the cluster on rejoin.
- A 2PC coordinator that loses a participant's prepare vote and commits anyway.
- A snapshot that races with apply and produces a state hash mismatch.
- A clock-skew assumption that holds in production but breaks under the simulator's adversarial scheduler.

Each of these is a real bug class found by simulation in production systems.

### Why Most Teams Do Not Do This

Building a deterministic simulator is engineering work. Wrapping every nondeterministic primitive is invasive: you cannot drop in a random library that calls `time()` internally. The codebase must be designed for it from the start. Retrofitting an existing system is feasible but expensive.

The teams that have built simulators (FoundationDB, TigerBeetle, the Antithesis platform, parts of Google's Spanner team) report that the upfront cost pays back many times over. The teams that haven't ship subtle bugs and find them in production.

For a new C++ distributed system in 2026, the simulation-first approach is the senior-engineer default. The cost is high, the alternative is bugs that surface at 3 AM.

### Junior at FAANG: The Testing Question

When asked "how do you test a distributed system?", do not say "we use unit tests and integration tests." Say: "We use simulation-driven testing. Every nondeterministic primitive is wrapped behind an interface. The simulator runs the system in a single deterministic process under aggressive fault injection. Bugs are reproducible from a seed. This is the FoundationDB approach. The alternative is finding bugs in production."

That answer is the litmus test for engineers who have done this work versus engineers who have heard about it.

---
