## Inheritance

### Single Inheritance

C++ supports classical inheritance with `public`, `protected`, and `private` modes:

```cpp
class Shape {
public:
    Shape(const std::string& color) : color_(color) {}
    virtual ~Shape() = default;

    std::string color() const { return color_; }
    virtual double area() const = 0;         // pure virtual
    virtual std::string name() const = 0;    // pure virtual

private:
    std::string color_;
};

class Circle : public Shape {
public:
    Circle(const std::string& color, double radius)
        : Shape(color), radius_(radius) {}

    double area() const override {
        return 3.14159265358979 * radius_ * radius_;
    }

    std::string name() const override { return "Circle"; }

private:
    double radius_;
};

class Rectangle : public Shape {
public:
    Rectangle(const std::string& color, double w, double h)
        : Shape(color), width_(w), height_(h) {}

    double area() const override { return width_ * height_; }
    std::string name() const override { return "Rectangle"; }

private:
    double width_;
    double height_;
};

void printShape(const Shape& s) {
    std::cout << s.name() << " (" << s.color() << "): area = "
              << s.area() << "\n";
}
```

### Go's Composition Model

Go achieves the same polymorphism through interfaces and embedding, without inheritance:

```go
type Shape interface {
    Area() float64
    Name() string
    Color() string
}

type baseShape struct {
    color string
}

func (b baseShape) Color() string { return b.color }

type Circle struct {
    baseShape
    Radius float64
}

func (c Circle) Area() float64 { return math.Pi * c.Radius * c.Radius }
func (c Circle) Name() string  { return "Circle" }

type Rectangle struct {
    baseShape
    Width, Height float64
}

func (r Rectangle) Area() float64 { return r.Width * r.Height }
func (r Rectangle) Name() string  { return "Rectangle" }

func printShape(s Shape) {
    fmt.Printf("%s (%s): area = %.2f\n", s.Name(), s.Color(), s.Area())
}
```

### Inheritance Mode Comparison

Inheritance allows a derived class to reuse and extend the interface and implementation of a base class, forming an "is-a" relationship expressed at the type system level. In C++ this includes both public inheritance for polymorphism and private inheritance for implementation reuse without exposing the base interface.
```cpp
class Base {
public:    int pub;
protected: int prot;
private:   int priv;
};

class PubDerived : public Base {
    // pub   -> public
    // prot  -> protected
    // priv  -> inaccessible
};

class ProtDerived : protected Base {
    // pub   -> protected
    // prot  -> protected
    // priv  -> inaccessible
};

class PrivDerived : private Base {
    // pub   -> private
    // prot  -> private
    // priv  -> inaccessible
};
```

`public` inheritance is the most common and models the "is-a" relationship. `private` inheritance models "is-implemented-in-terms-of" (similar to Go embedding, which is composition).

### Multiple Inheritance

C++ allows a class to inherit from multiple base classes:

```cpp
class Printable {
public:
    virtual ~Printable() = default;
    virtual std::string toString() const = 0;
};

class Serializable {
public:
    virtual ~Serializable() = default;
    virtual std::vector<uint8_t> serialize() const = 0;
};

class LogEntry : public Printable, public Serializable {
public:
    LogEntry(std::string msg, int level)
        : message_(std::move(msg)), level_(level) {}

    std::string toString() const override {
        return "[" + std::to_string(level_) + "] " + message_;
    }

    std::vector<uint8_t> serialize() const override {
        auto s = toString();
        return {s.begin(), s.end()};
    }

private:
    std::string message_;
    int level_;
};
```

**Go comparison:** Go interfaces provide multiple inheritance of behavior contracts naturally, since a type can implement any number of interfaces without declaring it:

```go
type Printable interface {
    String() string
}

type Serializable interface {
    Serialize() []byte
}

type LogEntry struct {
    Message string
    Level   int
}

func (e LogEntry) String() string {
    return fmt.Sprintf("[%d] %s", e.Level, e.Message)
}

func (e LogEntry) Serialize() []byte {
    return []byte(e.String())
}
// LogEntry implicitly satisfies both Printable and Serializable
```

### The Diamond Problem

When two base classes share a common ancestor, you get the diamond problem:

```
        Animal
       /      \
    Mammal   Bird
       \      /
        Bat
```

Without virtual inheritance, `Bat` would contain two copies of `Animal`'s data:

```cpp
class Animal {
public:
    Animal(const std::string& name) : name_(name) {
        std::cout << "Animal(" << name_ << ") constructed\n";
    }
    std::string name() const { return name_; }
protected:
    std::string name_;
};

// WITHOUT virtual inheritance: diamond problem
class Mammal : public Animal {
public:
    Mammal(const std::string& name) : Animal(name) {}
    void breathe() { std::cout << name_ << " breathes with lungs\n"; }
};

class Bird : public Animal {
public:
    Bird(const std::string& name) : Animal(name) {}
    void fly() { std::cout << name_ << " flies\n"; }
};

class Bat : public Mammal, public Bird {
public:
    // Problem: which Animal constructor? Both Mammal and Bird construct one.
    Bat(const std::string& name) : Mammal(name), Bird(name) {}

    // bat.name() is ambiguous: Mammal::name() or Bird::name()?
    // Must disambiguate: bat.Mammal::name() or bat.Bird::name()
};
```

### Virtual Inheritance Solves the Diamond

Virtual inheritance ensures that only one shared instance of the common base class (`Animal`) exists in the final derived class (`Bat`), eliminating duplicate subobjects and member name ambiguities:
```cpp
class Animal {
public:
    Animal(const std::string& name) : name_(name) {}
    std::string name() const { return name_; }
protected:
    std::string name_;
};

class Mammal : virtual public Animal {
public:
    Mammal(const std::string& name) : Animal(name) {}
    void breathe() { std::cout << name_ << " breathes with lungs\n"; }
};

class Bird : virtual public Animal {
public:
    Bird(const std::string& name) : Animal(name) {}
    void fly() { std::cout << name_ << " flies\n"; }
};

class Bat : public Mammal, public Bird {
public:
    // With virtual inheritance, Bat must directly call Animal's constructor
    Bat(const std::string& name)
        : Animal(name), Mammal(name), Bird(name) {}
};

Bat bat("Stellaluna");
bat.breathe();        // works
bat.fly();            // works
std::cout << bat.name(); // unambiguous: single Animal subobject
```

**Go avoids this entirely.** Embedding is not inheritance. If you embed two types that both have a `Name` field, the compiler requires you to disambiguate, and there is no shared base:

```go
type Mammal struct{ Name string }
type Bird struct{ Name string }

type Bat struct {
    Mammal
    Bird
}

// b := Bat{}
// b.Name          // compile error: ambiguous selector Name
// b.Mammal.Name   // OK
// b.Bird.Name     // OK
```

---

### Junior → FAANG: Using Inheritance Judiciously

Go deliberately omitted inheritance, and for good reason: deep inheritance hierarchies create tight coupling, make code hard to reason about, and create fragile base class problems. C++ gives you inheritance. It does not force you to use it deeply.

Rule for beginners: never go more than two levels deep in an inheritance hierarchy without a design review. If you find yourself writing `class C : public B` where `B : public A`, stop and ask whether `C` can instead hold a `B` by composition and implement the required interface explicitly. The answer is almost always yes.

Interview note: "what is the diamond problem in multiple inheritance?" The answer: when `class D` inherits from both `B` and `C`, and both `B` and `C` inherit from `A`, there are two copies of `A`'s data in `D`. Virtual inheritance (`virtual public A`) solves this but adds complexity. The Go community avoids this entirely by using interface composition instead of class inheritance.

### Senior @ FAANG: Inheritance as a Legacy Code Problem

At the staff level, you are more likely to be managing existing deep inheritance hierarchies than designing new ones. The question is: how do you refactor a legacy hierarchy without breaking the existing API contract?

**Strangler fig pattern for inheritance hierarchies.** The safe migration is: introduce a new abstract interface that captures the required behavior (without the inherited implementation), implement that interface in the existing base class, and gradually migrate callers from the inheritance-based API to the interface-based API. Once all callers use the interface, the inheritance relationship can be removed. This is the strangler fig pattern applied to OOP design debt.

**Virtual inheritance performance implications.** Virtual inheritance (used to solve the diamond problem) adds a level of indirection to every access of the virtual base class's data members. In a hot path, this is measurable. A staff engineer profiling a class hierarchy for performance first checks for virtual inheritance and, if present, evaluates whether the design can be restructured to eliminate it.

