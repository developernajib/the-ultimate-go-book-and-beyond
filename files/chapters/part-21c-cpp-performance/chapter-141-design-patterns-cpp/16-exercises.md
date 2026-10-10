## Exercises

### Exercise 1: TransactionGuard with Nested Rollbacks

Implement a `NestedTransactionGuard` that supports savepoints. Each call to `savepoint()` pushes a new rollback lambda onto a stack. Calling `rollback_to_savepoint()` executes and pops the most recent savepoint's rollback but leaves the outer transaction active. Calling `commit()` clears all savepoints. Calling the destructor without committing runs all savepoint rollbacks in LIFO order.

Test it with a sequence of database operations where the middle step fails and should rollback only to the last savepoint, leaving earlier operations intact.

Requirements:
- The guard must be non-copyable and movable.
- Rollback functions must not throw. If they do, exceptions must be caught and logged.
- Demonstrate that on successful completion, no rollbacks execute.
- Demonstrate that on exception, all pending rollback steps run in correct order.

---

### Exercise 2: Pimpl + Move Semantics for a Thread Pool

Design a `ThreadPool` class using the Pimpl idiom. The public header must expose only:

```cpp
class ThreadPool {
public:
    explicit ThreadPool(std::size_t thread_count);
    ~ThreadPool();
    ThreadPool(ThreadPool&&) noexcept;
    ThreadPool& operator=(ThreadPool&&) noexcept;

    std::future<void> submit(std::function<void()> task);
    void              wait_all();
    std::size_t       pending_count() const noexcept;
};
```

The implementation must live entirely in a `.cpp` file. The `Impl` struct holds the thread vector, the task queue, mutexes, and condition variables. Verify that:

1. The header compiles without any threading or concurrency headers included.
2. Moving a `ThreadPool` transfers pending tasks to the new object.
3. The destructor waits for all running tasks to complete before joining threads.

---

### Exercise 3: Compile-Time Variant State Machine for a Vending Machine

Model a vending machine as a `std::variant` state machine with these states:

- `Idle`, no coins inserted
- `AcceptingCoins { int total_cents. }`, coins accumulating
- `ItemSelected { int total_cents. int item_id. int item_price_cents. }`, item chosen
- `Dispensing { int change_cents. }`, dispensing item and returning change
- `OutOfService { std::string reason. }`, maintenance mode

Events: `InsertCoin { int cents. }`, `SelectItem { int id. int price_cents. }`, `Dispense {}`, `Refund {}`, `ServiceMode { std::string reason. }`, `Restore {}`.

Requirements:
- Write the complete `transition(state, event) -> state` function using nested `std::visit`.
- Every valid (state, event) pair must return a new state.
- Every invalid pair must return the current state unchanged and log a warning.
- Verify compile-time exhaustiveness: add a new state type and confirm you get a compile error until you handle it in the transition function.
- Write a test sequence: insert 100 cents, select item costing 75 cents, dispense, verify 25 cents change in `Dispensing` state.

---

### Exercise 4: Type-Safe EventBus with Priority and Filtering

Extend the `EventBus` from this chapter with two features:

**Priority**: subscribers can specify a priority (integer). When an event is published, higher-priority handlers fire first. Same-priority handlers fire in subscription order.

**Filtering**: subscribers can provide a predicate `bool(const EventType&)`. The handler is only invoked if the predicate returns true.

```cpp
// Desired API
bus.subscribe<ScoreChanged>(
    [](const ScoreChanged& ev) { update_leaderboard(ev); },
    Priority{10},
    Filter{[](const ScoreChanged& ev) { return ev.new_score > 1000; }}
);
```

Requirements:
- The filter predicate must be stored as a `std::function<bool(const EventType&)>`.
- Priority ordering must be maintained after each new subscription.
- Auto-unsubscription via RAII handle must still work.
- Write tests covering: normal dispatch, filtered dispatch (predicate false = no call), priority ordering verified by recording call order.

---

### Exercise 5: Minimal ECS with Query API

Extend the ECS `World` from this chapter with a query interface that allows systems to request entities with a specific combination of components without manually intersecting sparse sets:

```cpp
// Desired system API
world.query<Position, Velocity>([](EntityId id, Position& pos, Velocity& vel) {
    pos.x += vel.dx * dt;
    pos.y += vel.dy * dt;
});

world.query<Position, Health>([](EntityId id, Position& pos, Health& hp) {
    if (hp.alive) render_at(pos.x, pos.y);
});
```

Implementation requirements:
- The query must iterate only entities that have ALL requested component types.
- Use the smallest component store as the iteration driver (to minimize iterations).
- The query lambda receives typed component references, no casting.
- Add a benchmark: create 100,000 entities where 80% have `Position`, 50% have `Velocity`, 20% have `Health`. Measure iteration time for `query<Position, Velocity>` and compare against a naive iteration that checks `has()` for every entity ID in sequence.
- Verify correctness: modify a component inside the query lambda and confirm the change persists after the query returns.

---
