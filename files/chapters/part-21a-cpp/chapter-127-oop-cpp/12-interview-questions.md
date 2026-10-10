## Interview Questions

### Conceptual Questions

1. **What is the difference between `class` and `struct` in C++?**
   Only the default access level: `class` defaults to `private`, `struct` to `public`. They are otherwise identical in capability.

2. **Why should destructors of base classes be virtual?**
   When deleting a derived object through a base pointer, a non-virtual destructor calls only the base destructor, leaking derived resources. Virtual destructors ensure the derived destructor runs first, then the base.

3. **Explain the diamond problem and how virtual inheritance solves it.**
   When class D inherits from B and C, both of which inherit from A, D gets two copies of A's members. Virtual inheritance ensures only one shared A subobject exists. The most-derived class (D) must call A's constructor directly.

4. **What is the Rule of Five? When does Rule of Zero apply?**
   If you define any of {destructor, copy constructor, copy assignment, move constructor, move assignment}, you should define all five. Rule of Zero: if your class manages no resources directly (uses only RAII wrappers), define none.

5. **How does Go achieve polymorphism without inheritance?**
   Go uses interfaces (structural typing) and embedding (composition). Any type that implements the methods of an interface satisfies it implicitly. Embedding promotes methods from inner types, providing code reuse without inheritance.

6. **What is the vtable and when is it used?**
   The vtable is a per-class table of function pointers for virtual methods. Each object with virtual functions has a hidden vptr pointing to its class's vtable. At runtime, virtual calls go through the vptr to find the correct function, enabling polymorphic dispatch.

7. **Compare RAII with Go's `defer`. What are the trade-offs?**
   RAII ties cleanup to scope exit and works at any block level. `defer` ties cleanup to function return. RAII composes through object nesting. `defer` is flat. RAII has zero runtime overhead. `defer` has a small per-call cost. RAII works with exceptions. `defer` works with panic/recover.

8. **Why doesn't Go have operator overloading?**
   Go prioritizes readability and simplicity. The designers decided that `a.Add(b)` is clearer than `a + b` when the types are not numeric primitives. Operator overloading can make code harder to understand when operators have non-obvious semantics.

9. **What are the three types of inheritance access in C++ and when would you use each?**
   `public` inheritance models "is-a" (most common). `protected` inheritance models "is-a for derived classes only" (rare). `private` inheritance models "is-implemented-in-terms-of," similar to composition. Prefer composition over private inheritance in most cases. Use private inheritance only when you need access to protected members or must override virtual functions.

10. **What happens if you copy an object that manages a raw pointer but has no user-defined copy constructor?**
    The compiler-generated copy constructor performs a shallow (memberwise) copy. Both the original and the copy point to the same heap memory. When either is destroyed, the destructor frees the memory. When the other is destroyed, it frees the same memory again, causing undefined behavior (double free). This is why the Rule of Three/Five exists.

11. **How do `std::unique_ptr` and `std::shared_ptr` relate to the Rule of Zero?**
    They encapsulate resource management so that your class does not need custom special member functions. A class that holds a `std::unique_ptr` instead of a raw pointer gets correct move semantics automatically (unique_ptr is move-only). A class that holds `std::shared_ptr` gets correct copy and move semantics automatically (reference counting). This lets you follow the Rule of Zero.

12. **Explain `std::move` and what it actually does.**
    `std::move` does not move anything. It is a cast that converts an lvalue to an rvalue reference, signaling to the compiler that you are done with this object and its resources can be transferred. The actual move happens in the move constructor or move assignment operator of the target. After a move, the source object is in a valid but unspecified state.

### Coding Questions

13. **Implement a `SharedPtr` class** that uses reference counting to manage shared ownership of a heap-allocated object. Support copy, move, `operator*`, `operator->`, and `use_count()`. Handle thread safety with `std::atomic<int>` for the reference count.

    Skeleton to get started:
    ```cpp
    template <typename T>
    class SharedPtr {
    public:
        explicit SharedPtr(T* ptr = nullptr);
        ~SharedPtr();
        SharedPtr(const SharedPtr& other);
        SharedPtr& operator=(const SharedPtr& other);
        SharedPtr(SharedPtr&& other) noexcept;
        SharedPtr& operator=(SharedPtr&& other) noexcept;

        T& operator*() const;
        T* operator->() const;
        T* get() const;
        int use_count() const;
        explicit operator bool() const;

    private:
        T* ptr_;
        std::atomic<int>* ref_count_;

        void release();
    };
    ```

14. **Design a file system** (files and directories) using the Composite pattern in C++. Each directory can contain files and subdirectories. Support operations: `ls()`, `size()`, `find(name)`. Implement the same design in Go using interfaces and composition. Consider how the Composite pattern's virtual dispatch compares to Go's interface dispatch in implementation complexity.

15. **Implement an observer pattern** for a stock price ticker. Multiple observers (console display, alert system, logging) subscribe to price updates. Use `std::function` and `std::weak_ptr` to avoid preventing observer destruction. Then implement the same in Go using channels or callback functions.

16. **Design a thread-safe object pool** that reuses expensive-to-create objects (like database connections). Use RAII so that returning an object to the pool happens automatically when the handle goes out of scope. Compare with the Go approach using buffered channels as a pool:

    ```go
    // Go pool using channels
    type Pool struct {
        conns chan *Connection
    }

    func (p *Pool) Get() *Connection {
        return <-p.conns
    }

    func (p *Pool) Put(c *Connection) {
        p.conns <- c
    }
    ```

    The C++ RAII approach ensures return-to-pool via the destructor:
    ```cpp
    class PoolHandle {
    public:
        PoolHandle(Connection* conn, Pool* pool)
            : conn_(conn), pool_(pool) {}
        ~PoolHandle() { pool_->returnConnection(conn_); }
        Connection* operator->() { return conn_; }

        PoolHandle(const PoolHandle&) = delete;
        PoolHandle& operator=(const PoolHandle&) = delete;
        PoolHandle(PoolHandle&&) noexcept = default;
        PoolHandle& operator=(PoolHandle&&) noexcept = default;
    private:
        Connection* conn_;
        Pool* pool_;
    };
    ```

---

### Junior → FAANG: Interview Question Practice Protocol

Study these questions in pairs with a partner: one person asks, the other answers without notes. After the answer, the asker provides feedback on what was missing or imprecise. Then switch. This active recall practice is more effective than reading answers alone.

For conceptual questions (vtable, diamond problem, Rule of Five), aim for answers under 90 seconds that cover: what it is, what problem it solves, and one real-world example. For design questions (parking lot, LRU cache), aim for a 5-minute structured answer that follows the process outlined in the OOD section.

### Senior @ FAANG: Bar-Raiser Interview Design for C++ OOP

At the L6 panel level, the standard C++ OOP questions (vtable, Rule of Five, diamond problem) are table stakes, not differentiators. Use them to establish baseline, then follow up with governance and judgment questions.

Follow-up progression: after "explain the vtable," ask "how would you determine whether virtual dispatch is a performance bottleneck in a specific service?" After "explain the Rule of Five," ask "how would you migrate a legacy Rule of Three codebase to Rule of Zero across 500 classes?" After "design an LRU cache," ask "how would you monitor the cache hit rate in production and what would trigger a cache sizing change?"

These follow-ups assess whether the candidate can apply OOP knowledge to real production problems, which is the L6 signal. An L4 candidate answers the base question. An L6 candidate anticipates the follow-ups and addresses them proactively.

