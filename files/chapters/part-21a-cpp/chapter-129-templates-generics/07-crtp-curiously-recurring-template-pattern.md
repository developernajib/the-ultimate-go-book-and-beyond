## CRTP: Curiously Recurring Template Pattern

### Static Polymorphism

CRTP is a pattern where a class inherits from a template instantiation of itself. It enables static (compile-time) polymorphism, virtual function behavior without the vtable overhead.

```cpp
template <typename Derived>
class Shape {
public:
    double Area() const {
        // Call the derived class's implementation at compile time
        return static_cast<const Derived*>(this)->AreaImpl();
    }

    void Describe() const {
        std::cout << "Shape with area: " << Area() << "\n";
    }
};

class Circle : public Shape<Circle> {
    double radius_;
public:
    explicit Circle(double r) : radius_(r) {}
    double AreaImpl() const { return 3.14159265358979 * radius_ * radius_; }
};

class Rectangle : public Shape<Rectangle> {
    double width_, height_;
public:
    Rectangle(double w, double h) : width_(w), height_(h) {}
    double AreaImpl() const { return width_ * height_; }
};

int main() {
    Circle c(5.0);
    c.Describe();   // Shape with area: 78.5398

    Rectangle r(3.0, 4.0);
    r.Describe();   // Shape with area: 12
    return 0;
}
```

The key insight: `Shape<Circle>` and `Shape<Rectangle>` are different base classes. The call to `AreaImpl()` is resolved at compile time through the `static_cast`, not through a vtable lookup. There is zero runtime overhead.

**The tradeoff:** you cannot store `Circle` and `Rectangle` in the same container, because `Shape<Circle>` and `Shape<Rectangle>` are unrelated types. If you need heterogeneous collections, you need virtual dispatch.

### Mixin Pattern with CRTP

CRTP is often used as a mixin to add functionality to any class without virtual overhead.

```cpp
template <typename Derived>
class Printable {
public:
    void Print() const {
        const auto& self = static_cast<const Derived&>(*this);
        std::cout << self.ToString() << "\n";
    }

    friend std::ostream& operator<<(std::ostream& os, const Derived& d) {
        return os << d.ToString();
    }
};

template <typename Derived>
class Comparable {
public:
    bool operator!=(const Derived& other) const {
        const auto& self = static_cast<const Derived&>(*this);
        return !(self == other);
    }
    bool operator>(const Derived& other) const {
        return other < static_cast<const Derived&>(*this);
    }
    bool operator<=(const Derived& other) const {
        return !(static_cast<const Derived&>(*this) > other);
    }
    bool operator>=(const Derived& other) const {
        return !(static_cast<const Derived&>(*this) < other);
    }
};

class Temperature : public Printable<Temperature>,
                    public Comparable<Temperature> {
    double celsius_;
public:
    explicit Temperature(double c) : celsius_(c) {}

    std::string ToString() const {
        return std::to_string(celsius_) + "°C";
    }

    bool operator==(const Temperature& other) const {
        return celsius_ == other.celsius_;
    }

    bool operator<(const Temperature& other) const {
        return celsius_ < other.celsius_;
    }
};

int main() {
    Temperature boiling(100.0);
    Temperature freezing(0.0);

    boiling.Print();                          // 100.000000°C
    std::cout << (boiling > freezing) << "\n"; // 1
    std::cout << (boiling != freezing) << "\n"; // 1
    return 0;
}
```

By implementing `operator==` and `operator<`, the `Comparable` mixin automatically provides `!=`, `>`, `<=`, `>=`. This is similar in spirit to Go's approach of embedding interfaces, but it happens entirely at compile time.

Note: C++20's three-way comparison operator (`<=>`, the spaceship operator) provides a standard compiler-generated way to synthesize comparison operators (superseding and deprecating `std::rel_ops`), making CRTP-based comparison mixins less necessary in modern code. But the pattern remains important for other mixin use cases.

### CRTP for Compile-Time Counters and Registries

The `Registry<Derived>` base class uses a `static inline` vector (C++17) to maintain a list of all live instances of a given derived type. The base constructor pushes the correctly-typed pointer (via `static_cast<Derived*>(this)`) on creation and the destructor removes it on destruction, giving each concrete class its own independent registry with zero per-instance overhead.
```cpp
template <typename Derived>
class Registry {
    static inline std::vector<Derived*> instances_;
public:
    Registry() {
        instances_.push_back(static_cast<Derived*>(this));
    }
    ~Registry() {
        instances_.erase(
            std::remove(instances_.begin(), instances_.end(),
                        static_cast<Derived*>(this)),
            instances_.end()
        );
    }
    static const std::vector<Derived*>& GetAll() { return instances_; }
    static size_t Count() { return instances_.size(); }
};

class Widget : public Registry<Widget> {
    std::string name_;
public:
    explicit Widget(std::string name) : name_(std::move(name)) {}
    const std::string& Name() const { return name_; }
};

int main() {
    Widget a("button"), b("slider"), c("checkbox");
    std::cout << Widget::Count() << "\n";  // 3
    for (auto* w : Widget::GetAll()) {
        std::cout << w->Name() << "\n";
    }
    return 0;
}
```

Each class that inherits from `Registry<T>` gets its own independent registry. `Widget` instances are tracked separately from any other class that uses the pattern.

### Preventing CRTP Misuse

A common bug is inheriting from `Base<WrongType>`. C++20 makes it possible to guard against this:

```cpp
template <typename Derived>
class SafeBase {
    // Private constructor -- only Derived can construct via friendship
    SafeBase() {
        static_assert(std::is_base_of_v<SafeBase<Derived>, Derived>,
                      "CRTP misuse: Derived must inherit from SafeBase<Derived>");
    }
    friend Derived;

public:
    void DoWork() {
        static_cast<Derived*>(this)->DoWorkImpl();
    }
};
```

---
