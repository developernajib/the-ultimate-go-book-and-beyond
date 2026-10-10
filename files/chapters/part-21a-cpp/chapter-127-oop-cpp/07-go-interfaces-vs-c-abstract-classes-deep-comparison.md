## Go Interfaces vs C++ Abstract Classes: Deep Comparison

This is one of the most important conceptual differences between the two languages and a frequent interview topic.

### Structural vs Nominal Typing

**C++ abstract classes use nominal typing:** a derived class must explicitly declare inheritance.

```cpp
class Writer {
public:
    virtual ~Writer() = default;
    virtual void write(const std::string& data) = 0;
};

// FileWriter must explicitly inherit from Writer
class FileWriter : public Writer {
public:
    void write(const std::string& data) override {
        // write to file
    }
};
```

**Go interfaces use structural typing:** any type that has the right methods satisfies the interface, with no declaration required.

```go
type Writer interface {
    Write(data []byte) (int, error)
}

// FileWriter satisfies Writer without declaring it
type FileWriter struct{ /* ... */ }

func (fw *FileWriter) Write(data []byte) (int, error) {
    // write to file
    return len(data), nil
}
```

### Comparison Table

| Aspect | C++ Abstract Class | Go Interface |
|---|---|---|
| Coupling | Tight: derived class names the base | Loose: no declaration needed |
| Can hold state | Yes (data members in abstract class) | No (pure behavior contract) |
| Default implementations | Yes (non-pure virtual methods) | No (until Go 1.x. Use embedding for reuse) |
| Multiple inheritance | Yes (diamond problem possible) | Yes (no diamond problem. Method sets are flat) |
| Runtime cost | vtable pointer per object (8 bytes) | Interface value = (type pointer, data pointer) = 16 bytes |
| Retroactive conformance | No: cannot make existing class implement new base | Yes: existing type satisfies new interface automatically |
| Compile-time checking | At class definition | At point of use (assignment to interface variable) |
| Type assertions | `dynamic_cast<Derived*>(base)` (RTTI) | `value.(ConcreteType)` or type switch |
| Nil/null safety | Null pointer → undefined behavior | Nil interface value → runtime panic (but detectable) |

### Retroactive Interface Satisfaction

This is Go's killer feature. You can define an interface that existing types satisfy without modifying them:

```go
// You define this interface in YOUR package
type Stringer interface {
    String() string
}

// net.IP from the standard library already has a String() method
// It satisfies YOUR Stringer interface without any changes to net.IP
var s Stringer = net.IPv4(192, 168, 1, 1) // works
```

In C++, you cannot retroactively make `std::string` inherit from your new `Printable` class. You would need an adapter or wrapper:

```cpp
class Printable {
public:
    virtual ~Printable() = default;
    virtual std::string toString() const = 0;
};

// Cannot make std::string inherit from Printable
// Must create a wrapper:
class StringWrapper : public Printable {
public:
    StringWrapper(std::string s) : s_(std::move(s)) {}
    std::string toString() const override { return s_; }
private:
    std::string s_;
};
```

### When to Use Which

**Use C++ abstract classes when:**
- You need shared state or default implementations in the base
- You want compile-time enforcement of the inheritance relationship
- The type hierarchy is well-defined and unlikely to change
- Performance matters (vtable dispatch is slightly faster than Go interface dispatch)

**Use Go interfaces when:**
- You want maximum decoupling between producers and consumers
- You need retroactive conformance (wrapping third-party types)
- You prefer small, focused contracts (the "interface segregation" principle)
- You want testability (easy to mock any interface)

---

### Junior → FAANG: Knowing the Comparison Deeply Enough to Code Both Sides

The Go vs. C++ interface comparison is a classic interview question, but the useful version is not "which is better?" but "given this concrete scenario, which would you use and why?" Practice writing the same abstraction twice: once as a Go interface and once as a C++ pure abstract class. Note the differences in declaration (implicit vs. explicit), extension (Go: just implement the method, C++: inherit from the class), and mocking (Go: generate a mock with `mockgen`, C++: write a `MockShape : public Shape` by hand or use gMock).

Interview entry point: be prepared to explain retroactive interface implementation (Go allows it, C++ does not) and why that matters for library design. Go's model allows a third-party type to satisfy your interface without modifying the third-party code. C++'s model requires the third-party type to inherit from your class, which requires modifying the third-party code.

### Senior @ FAANG: Interface Design at API Boundary Scale

At the staff level, the Go vs. C++ interface tradeoff is most visible when designing a public API that must be extensible by external users.

**C++ interface design for extensibility.** A C++ pure abstract class as a public API requires: a virtual destructor (to prevent sliced deletions), careful versioning (adding a new pure virtual function breaks all existing implementations), and a stable vtable layout (changing the order of virtual functions breaks binary compatibility). These constraints make C++ abstract class APIs much harder to evolve than Go interfaces.

**The NVI (Non-Virtual Interface) idiom.** A staff engineer designing a C++ abstract class API uses NVI: public non-virtual functions that call private virtual functions. The benefit: the public API is stable and non-virtual (callable at full speed), while the private virtual functions are the extension points. The public functions can add pre/post conditions, logging, and validation without the caller needing to do anything. This is not possible with Go interfaces (all interface methods are the extension points).

**Testability as a design constraint.** A staff engineer designing either a Go interface or a C++ abstract class asks: can every implementation be easily mocked in tests? For Go, `mockgen` handles this automatically. For C++, gMock requires that every method that will be mocked has a virtual declaration in the base class. Design the abstract class so that every externally observable behavior is a virtual function, even if most implementations will not override all of them (use default implementations in the base class for non-critical behaviors).

