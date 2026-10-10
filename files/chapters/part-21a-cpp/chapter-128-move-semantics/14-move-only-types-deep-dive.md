## Move-Only Types Deep Dive

Move-only types model unique ownership. Copying would either be incorrect (two file descriptors pointing at the same kernel handle, both running close in their destructors) or expensive enough that the type prefers to forbid it (`std::thread` cannot be reasonably duplicated). Knowing the standard library's move-only types and how to build your own is fundamental for resource-owning code.

### std::unique_ptr

The canonical move-only type. The copy constructor and copy assignment are deleted. The move operations are noexcept and reset the source to null.

```cpp
template <class T, class D = std::default_delete<T>>
class unique_ptr {
public:
    unique_ptr(const unique_ptr&) = delete;
    unique_ptr& operator=(const unique_ptr&) = delete;

    unique_ptr(unique_ptr&& other) noexcept
        : ptr(std::exchange(other.ptr, nullptr)) {}

    unique_ptr& operator=(unique_ptr&& other) noexcept {
        reset(other.release());
        return *this;
    }
};
```

`std::exchange(target, new_value)` returns the old value while assigning the new one. This is the canonical move-source idiom. After the move, `other.ptr` is null and the destructor on `other` is a no-op.

The deleter `D` complicates moves. If `D` is stateful and not nothrow-move-constructible, the unique_ptr's move operations are not noexcept either. Standard `default_delete<T>` is empty and noexcept-trivial, so `unique_ptr<T>` is always noexcept-movable in practice.

### std::thread and std::jthread

`std::thread` owns a kernel-managed thread of execution. It is move-only because two `std::thread` objects cannot manage the same OS thread (joining twice is UB).

```cpp
std::thread t1([]{ work(); });
std::thread t2 = std::move(t1); // t1 now empty (joinable() == false)
t2.join();
```

If a `std::thread` is destroyed while still joinable, `std::terminate` fires. This is a footgun that `std::jthread` (C++20) addresses: jthread joins on destruction (RAII). It also carries a `std::stop_token`:

```cpp
std::jthread t([](std::stop_token st) {
    while (!st.stop_requested()) {
        work_step();
    }
});
// destructor calls request_stop() then join()
```

Both are move-only with the same rationale: the OS handle is unique.

### std::promise, std::future, std::packaged_task

The `<future>` family is move-only. A `promise<T>` owns the producer end of a shared state. A `future<T>` owns the consumer end. Copying would create ambiguity about who fulfills or consumes.

```cpp
std::promise<int> p;
std::future<int>  f = p.get_future();

std::thread worker([p = std::move(p)]() mutable {
    p.set_value(42);
});

int v = f.get(); // blocks until set_value
worker.join();
```

`std::packaged_task<R(Args...)>` wraps a callable and a future. It is move-only because the bound callable plus the shared state form a unique work item. You move it into a thread or thread pool's queue.

`std::shared_future<T>` is the copyable variant. It exists because some patterns (broadcast results to multiple consumers) require copy.

### Custom Move-Only Types

The pattern: own a resource with a destructor. Delete copy. Define move to transfer the resource and null out the source. The standard library calls these the "rule of zero" if you wrap a `unique_ptr`, or the "rule of five" if you manage the handle directly.

#### File handle

```cpp
class File {
    int fd_ = -1;
public:
    File() = default;
    explicit File(const char* path, int flags)
        : fd_(::open(path, flags)) {
        if (fd_ < 0) throw std::system_error(errno, std::generic_category());
    }

    File(const File&)            = delete;
    File& operator=(const File&) = delete;

    File(File&& o) noexcept
        : fd_(std::exchange(o.fd_, -1)) {}

    File& operator=(File&& o) noexcept {
        if (this != &o) {
            close_();
            fd_ = std::exchange(o.fd_, -1);
        }
        return *this;
    }

    ~File() { close_(); }

    int get() const noexcept { return fd_; }

private:
    void close_() noexcept {
        if (fd_ >= 0) ::close(fd_);
        fd_ = -1;
    }
};
```

Notes:

- The sentinel value `-1` says "empty". Any handle representable by `int` works as long as you reserve one.
- `noexcept` on move operations enables `vector<File>` to grow with moves rather than copies (move-if-noexcept).
- Self-move-assignment is guarded by `this != &o`. After the guard, close-then-take is correct.

#### Socket

Same pattern, different sentinel (`INVALID_SOCKET` on Windows, `-1` on POSIX). On Windows the close call is `closesocket`. The structure is identical.

#### Cuda allocation, GL texture, mutex lock

Any unique resource fits the pattern. The rule: a noexcept move that swaps state with a sentinel, a destructor that releases when not in the sentinel state, deleted copy operations.

### Why std::function Is Not Move-Only

`std::function<R(Args...)>` is copy-constructible. This forces every callable stored inside to be copy-constructible. A lambda capturing a `unique_ptr` is move-only. It cannot be stored in `std::function`. The compile error reads "no matching constructor" and points at the type-erasure machinery.

Workarounds before C++23:

- Wrap the lambda's captures in `std::shared_ptr` so the lambda is copyable.
- Use a third-party `function2::unique_function` or absl's `AnyInvocable`.
- Hand-roll a move-only type-erased callable.

### std::move_only_function (C++23)

C++23 added `std::move_only_function`. It is a type-erased callable like `std::function` but movable-only. It can store move-only callables.

```cpp
#include <functional> // C++23

std::move_only_function<void()> task = [p = std::make_unique<int>(7)]() {
    std::cout << *p << '\n';
};

auto task2 = std::move(task); // ok
// auto task3 = task2;        // ill-formed: copy deleted
task2();
```

It also supports cv- and ref-qualifiers in the call signature: `std::move_only_function<R(Args...) const>`, `... && >`, etc. This lets you express "callable once" by qualifying with `&&`:

```cpp
std::move_only_function<void() &&> one_shot = [p = std::move(resource)]() mutable {
    consume(std::move(p));
};
std::move(one_shot)(); // explicit consumption
```

C++26 is expected to add `std::copyable_function` for the symmetric case.

`std::move_only_function` is implemented in libstdc++ 14, libc++ 18, MSVC STL VS 2022 17.10. Earlier, you used absl::AnyInvocable or function2::unique_function.

### Move-Only in Containers

`std::vector<unique_ptr<T>>` works. `push_back` and `emplace_back` use move construction. Reallocation uses move-if-noexcept (which prefers move because unique_ptr's move is noexcept).

`std::map<Key, MoveOnly>` works. Insertion takes by value or constructs in place. `try_emplace` and `insert_or_assign` (C++17) avoid unnecessary copies of keys.

`std::function<void()>` storing a move-only lambda? Fails. Use `std::move_only_function` (C++23).

`std::queue<T>`, `std::stack<T>`, `std::priority_queue<T>` work with move-only `T` as long as you respect their interfaces (`push(T&&)`, `emplace`).

### Move-Only Return Values

```cpp
std::unique_ptr<Widget> make() {
    return std::make_unique<Widget>();
}
```

Mandatory C++17 elision means the move constructor of `unique_ptr` is not even called. The constructed object lands in the caller's storage.

```cpp
std::unique_ptr<Widget> stash;

void capture() {
    stash = make(); // move assignment from rvalue
}
```

The temporary returned by `make()` is move-assigned into `stash`. The move is noexcept and cheap (pointer swap).

### Sinks and Pipelines

A function that takes ownership is called a sink. By value is the conventional spelling:

```cpp
class Manager {
    std::vector<std::unique_ptr<Job>> jobs_;
public:
    void submit(std::unique_ptr<Job> j) {
        jobs_.push_back(std::move(j));
    }
};
```

Callers write `mgr.submit(std::make_unique<Job>(args));`. The factory's prvalue initializes the parameter directly (mandatory elision). Inside, the parameter is moved into the vector. No copies anywhere.

### Pitfall: Returning std::move from a Local of Move-Only Type

```cpp
std::unique_ptr<Widget> make() {
    auto p = std::make_unique<Widget>();
    return std::move(p); // unnecessary: implicit move applies
}
```

Compilers warn (`-Wpessimizing-move`) because `std::move` here disables NRVO without benefit. Drop the move.

### Pitfall: Copying a Container of Move-Only

```cpp
std::vector<std::unique_ptr<int>> a;
std::vector<std::unique_ptr<int>> b = a; // ill-formed: vector's copy ctor instantiates element copy
```

The error is at the `vector::operator=` instantiation, not at your call site. Read the trailing line of the error template stack to find the deleted copy constructor.

The fix is `b = std::move(a);` if you wanted ownership transfer, or rebuild via cloning if you wanted true duplication.

### Junior at FAANG vs Senior at FAANG

Junior writes a class with `std::unique_ptr` members and forgets that the implicit copy is deleted as a result, then asks "why won't this compile". Senior reaches for the rule of zero (members handle ownership), explicitly defaults move operations if any user-declared destructor exists, and knows that returning a move-only type by value is the cheapest possible interface. Senior also knows `std::move_only_function` exists in C++23 and the `absl::AnyInvocable` predecessor for older toolchains.

### Drill

1. Why is `std::thread` move-only? Because two thread objects cannot manage the same OS thread.
2. What happens if a joinable `std::thread` destructs? `std::terminate`.
3. What is the C++23 fix for storing move-only lambdas in a type-erased callable? `std::move_only_function`.
4. Can `std::vector<std::unique_ptr<T>>` be sorted? Yes. Sort uses move construction and assignment.
5. What sentinel is conventional for an empty file handle? `-1` on POSIX, `INVALID_HANDLE_VALUE` on Windows.
