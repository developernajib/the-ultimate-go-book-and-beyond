## Virtual Functions and the vtable

### How Virtual Dispatch Works

When you declare a function `virtual`, the compiler generates a virtual function table (vtable) for that class. Each object of that class contains a hidden pointer (vptr) to its class's vtable.

```
                   vtable for Circle
                   +-------------------+
Circle object      | &Circle::area     |
+----------+       | &Circle::name     |
| vptr ----+------>| &Shape::color     |
| color_   |       +-------------------+
| radius_  |
+----------+

                   vtable for Rectangle
                   +-------------------+
Rectangle object   | &Rectangle::area  |
+----------+       | &Rectangle::name  |
| vptr ----+------>| &Shape::color     |
| color_   |       +-------------------+
| width_   |
| height_  |
+----------+
```

When you call `shape.area()` through a base class pointer or reference, the compiler:
1. Reads the `vptr` from the object
2. Looks up the `area` slot in the vtable
3. Calls the function pointer found there

This is a single indirection, typically one cache miss for the vtable lookup.

### Non-virtual vs Virtual vs Pure Virtual

Virtual dispatch enables runtime polymorphism: the compiler inserts an indirect call through a vtable so that the correct derived-class method is invoked regardless of the static pointer type. Understanding vtable layout and the overhead of virtual calls is important when designing hot paths in performance-sensitive code.
```cpp
class Base {
public:
    // Non-virtual: resolved at compile time (static dispatch)
    void nonVirtual() {
        std::cout << "Base::nonVirtual\n";
    }

    // Virtual: resolved at runtime (dynamic dispatch)
    virtual void virtualFunc() {
        std::cout << "Base::virtualFunc\n";
    }

    // Pure virtual: no implementation, forces derived classes to implement
    virtual void pureVirtual() = 0;

    virtual ~Base() = default;
};

class Derived : public Base {
public:
    void nonVirtual() { // hides Base::nonVirtual, does NOT override
        std::cout << "Derived::nonVirtual\n";
    }

    void virtualFunc() override { // overrides via vtable
        std::cout << "Derived::virtualFunc\n";
    }

    void pureVirtual() override { // must implement
        std::cout << "Derived::pureVirtual\n";
    }
};

Base* ptr = new Derived();
ptr->nonVirtual();    // "Base::nonVirtual" (static dispatch)
ptr->virtualFunc();   // "Derived::virtualFunc" (dynamic dispatch via vtable)
ptr->pureVirtual();   // "Derived::pureVirtual" (dynamic dispatch via vtable)
delete ptr;
```

### Performance Cost of Virtual Dispatch

Virtual function calls have a small but measurable cost compared to direct calls:

1. **Memory overhead:** Each object with virtual functions carries a hidden `vptr` (typically 8 bytes on 64-bit systems). Each class with virtual functions has a vtable stored in the binary's read-only data section.

2. **Runtime overhead:** A virtual call requires loading the vptr from the object, indexing into the vtable, and calling through the function pointer. This is typically 1-2 extra memory accesses compared to a direct call.

3. **Inlining prevention:** The compiler cannot inline virtual calls through base class pointers because the target is unknown at compile time. This is often the larger performance cost, as inlining enables further optimizations like constant folding and dead code elimination.

4. **Branch prediction:** Modern CPUs predict virtual call targets reasonably well when the same concrete type is called repeatedly. Polymorphic call sites with many different types cause more branch mispredictions.

```cpp
// Direct call: compiler can inline and optimize
void processDirectly(Circle& c) {
    double a = c.area(); // compiler knows this is Circle::area, can inline
}

// Virtual call: must go through vtable
void processVirtually(Shape& s) {
    double a = s.area(); // must read vptr, look up vtable, call through pointer
}
```

**Go comparison:** Go interface dispatch is similar to vtable dispatch but uses a different mechanism called an itable (interface table). When you assign a concrete type to an interface variable, Go creates or looks up an itable that maps the interface's methods to the concrete type's methods. The cost is comparable: one or two extra indirections per call. However, Go's escape analysis and inlining optimizations can sometimes devirtualize interface calls when the concrete type is known at compile time.

### Covariant Return Types

A virtual function override can return a more specific (derived) type than the base class version. This is called a covariant return type:

```cpp
class Animal {
public:
    virtual ~Animal() = default;
    virtual Animal* clone() const = 0;
};

class Dog : public Animal {
public:
    // Returns Dog* instead of Animal* (covariant return)
    Dog* clone() const override {
        return new Dog(*this);
    }
};

Animal* original = new Dog();
Animal* copy = original->clone(); // returns a Dog* implicitly converted to Animal*
delete copy;
delete original;
```

Go does not have covariant return types because Go does not have inheritance. The typical Go pattern uses a `Clone()` method that returns the interface type, and the caller uses a type assertion if they need the concrete type.

### Abstract Classes

A class with at least one pure virtual function is abstract and cannot be instantiated:

```cpp
class Database {
public:
    virtual ~Database() = default;

    virtual void connect(const std::string& connStr) = 0;
    virtual void disconnect() = 0;
    virtual std::vector<std::string> query(const std::string& sql) = 0;
    virtual void execute(const std::string& sql) = 0;

    // Non-pure virtual: provides default implementation
    virtual void ping() {
        auto result = query("SELECT 1");
        if (result.empty()) {
            throw std::runtime_error("Ping failed");
        }
    }
};

class PostgresDB : public Database {
public:
    void connect(const std::string& connStr) override {
        // Postgres-specific connection logic
        connected_ = true;
    }

    void disconnect() override { connected_ = false; }

    std::vector<std::string> query(const std::string& sql) override {
        // Postgres-specific query
        return {"result1", "result2"};
    }

    void execute(const std::string& sql) override {
        // Postgres-specific execution
    }

private:
    bool connected_ = false;
};
```

### The `override` and `final` Keywords

`override` tells the compiler you intend to override a virtual function. If the base class function signature does not match, you get a compile error instead of a silent bug:

```cpp
class Base {
public:
    virtual void process(int value) const = 0;
    virtual ~Base() = default;
};

class Derived : public Base {
public:
    // void process(int value) override {}       // ERROR: missing const
    void process(int value) const override {}    // OK: signature matches
};
```

`final` prevents further overriding or inheritance:

```cpp
class FinalClass final {
    // no class can inherit from FinalClass
};

class Base {
public:
    virtual void method() {}
};

class Middle : public Base {
public:
    void method() final {} // no further overriding allowed
};

class Bottom : public Middle {
    // void method() override {} // ERROR: method is final in Middle
};
```

---

### Junior → FAANG: The Cost of Virtual Dispatch in Hot Paths

Virtual function calls cost approximately 1 to 5 nanoseconds more than direct calls on modern hardware, due to the vtable lookup and the indirect call (which prevents branch prediction and inlining). For most code paths, this is irrelevant. For a function called 100 million times per second, it is 100 to 500 ms of overhead per second.

Develop the intuition for when virtual dispatch matters: if the function is in an inner loop (parsing each byte of a network packet, comparing each record in a sorted scan, dispatching each event in an event loop), virtual dispatch is worth measuring. If it is on a per-request basis for a service that handles 1000 RPS, it is not measurable.

Interview entry point: "how does virtual dispatch work?" should lead to: vtable per class, vptr per object, two-pointer-hop call sequence. Then: "when would you avoid it?" should cite: templates (compile-time polymorphism with no vtable), `std::variant` + `std::visit` (direct dispatch via index), and CRTP (Curiously Recurring Template Pattern for static dispatch).

### Senior @ FAANG: Devirtualization, Sealed Classes, and Virtual Dispatch Governance

At the staff level, virtual dispatch performance is an optimization opportunity with tooling support.

**Devirtualization by the compiler.** Modern compilers (Clang, GCC) can devirtualize virtual calls when they can prove the dynamic type at compile time. Profile-Guided Optimization (PGO) extends this: after a profiling run, the compiler knows which virtual dispatch sites are monomorphic (always the same type) and can speculatively devirtualize them with an inline type check. A staff engineer evaluating a class hierarchy for performance opportunities checks PGO devirtualization reports to identify which virtual call sites are monomorphic in production and are candidates for static dispatch refactoring.

**`final` and sealed classes.** The `final` specifier on a class or virtual function tells the compiler that no further overriding is possible. This enables devirtualization for calls to `final` classes even without PGO. Use `final` on any class that is not intended to be further subclassed. Use `final` on virtual functions that represent the terminal specialization. This is both a performance hint and a documentation signal.

**Virtual dispatch governance.** In a performance-critical codebase, a staff engineer sets a policy: new virtual functions in hot paths require a performance justification. The code review asks: can this be expressed as a template parameter, a `std::variant`, or a function pointer with less indirection? The justification for virtual dispatch should reference the design benefit (extensibility, testability) and the measured performance impact (negligible at the call rate of this path). Absent that, the default is non-virtual.

