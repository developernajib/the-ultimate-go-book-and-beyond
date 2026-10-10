## Slicing and Virtual Move

Inheritance and value semantics make uneasy roommates. The mechanism that lets a derived class extend a base also creates the slicing bug: assigning a `Derived` to a `Base` lvalue chops off the derived part. The same hazard applies to move construction. Patterns like virtual cloning and polymorphic value types exist to bridge value semantics with polymorphism.

### What Slicing Is

```cpp
struct Base { int b = 1; virtual ~Base() = default; };
struct Derived : Base { int d = 2; };

Derived dr;
Base bb = dr; // copy slicing: dr's d is dropped, bb has only b
```

The compiler invoked `Base(const Base&)`. The `Derived` part was not present in the destination type, so it had no copy. The dynamic type of `bb` is `Base`, not `Derived`.

Move slicing is the same:

```cpp
Base bb2 = std::move(dr); // move slicing: dr's d is gone (depending on Base's move logic)
```

The `Base&&` is bound to the derived rvalue (upcast is implicit). The `Base` move constructor moves only the `Base` subobject. The `Derived` part is destroyed when `dr` goes out of scope, never having migrated.

### Slicing in Function Parameters

```cpp
void process(Base b);
process(Derived{}); // slices
```

Pass-by-value parameters slice. Pass-by-reference does not. Pass-by-pointer does not. Most codebases enforce "polymorphic types are passed by reference or pointer" for this reason.

### Containers and Slicing

`std::vector<Base>` storing `Derived` objects is impossible without slicing:

```cpp
std::vector<Base> v;
v.push_back(Derived{}); // sliced into Base
```

The vector's element type is `Base`. Each cell is sizeof(Base). There is no room for the derived part.

The fix is `std::vector<std::unique_ptr<Base>>` or `std::vector<std::shared_ptr<Base>>`. The vector stores pointers, the polymorphic objects live on the heap, and slicing cannot occur because no copy of the value exists at the base type.

### Virtual Move Is Not Standard

C++ has virtual functions for ordinary methods but no virtual constructors. The move constructor cannot be virtual, because at construction time, the dynamic type is being established. Standard idiom: simulate virtual construction with a `clone()` method.

```cpp
struct Shape {
    virtual ~Shape() = default;
    virtual std::unique_ptr<Shape> clone() const = 0;
    virtual std::unique_ptr<Shape> move_clone() && = 0;
};

struct Circle : Shape {
    double r;
    Circle(double r) : r(r) {}
    std::unique_ptr<Shape> clone() const override {
        return std::make_unique<Circle>(*this);
    }
    std::unique_ptr<Shape> move_clone() && override {
        return std::make_unique<Circle>(std::move(*this));
    }
};
```

`clone()` makes a deep copy of the actual derived type. `move_clone() &&` does the same with move semantics. The ref-qualifier `&&` ensures `move_clone` can be called only on rvalues, preventing accidental moves from lvalues.

### Curiously Recurring Template Pattern for Cloning

Writing `clone` for every derived class is boilerplate. CRTP automates it:

```cpp
template <class Base, class Derived>
struct Cloneable : Base {
    std::unique_ptr<Base> clone() const override {
        return std::make_unique<Derived>(static_cast<const Derived&>(*this));
    }
    std::unique_ptr<Base> move_clone() && override {
        return std::make_unique<Derived>(std::move(static_cast<Derived&>(*this)));
    }
};

struct Shape {
    virtual ~Shape() = default;
    virtual std::unique_ptr<Shape> clone() const = 0;
    virtual std::unique_ptr<Shape> move_clone() && = 0;
};

struct Circle : Cloneable<Shape, Circle> {
    double r;
    Circle(double r) : r(r) {}
};
```

Now every derived class gets `clone` and `move_clone` for free, as long as it inherits from `Cloneable<Base, Self>`. There are subtleties around abstract intermediate classes, but the pattern is standard.

### Polymorphic Value Types

The opposite goal: keep value semantics on the outside while allowing polymorphism inside. A polymorphic value type wraps a `unique_ptr<Base>` and provides copy via `clone`:

```cpp
class Shape {
public:
    template <class T>
        requires (!std::same_as<std::remove_cvref_t<T>, Shape>)
    Shape(T impl)
        : impl_(std::make_unique<Model<T>>(std::move(impl))) {}

    Shape(const Shape& o) : impl_(o.impl_->clone()) {}
    Shape(Shape&&) noexcept = default;
    Shape& operator=(const Shape& o) {
        if (this != &o) impl_ = o.impl_->clone();
        return *this;
    }
    Shape& operator=(Shape&&) noexcept = default;

    double area() const { return impl_->area(); }

private:
    struct Concept {
        virtual ~Concept() = default;
        virtual std::unique_ptr<Concept> clone() const = 0;
        virtual double area() const = 0;
    };
    template <class T>
    struct Model : Concept {
        T data;
        Model(T t) : data(std::move(t)) {}
        std::unique_ptr<Concept> clone() const override {
            return std::make_unique<Model>(*this);
        }
        double area() const override { return data.area(); }
    };

    std::unique_ptr<Concept> impl_;
};
```

This is the type-erasure pattern Sean Parent popularized. `Shape` acts like a value: copyable, movable, with `area()`. Inside, it dispatches to whatever type was stored.

Trade-offs:

- Heap allocation per Shape (mitigatable with small-object optimization).
- Virtual dispatch on every method call.
- No explicit inheritance hierarchy from the user's side.

Use when you need polymorphic behavior with value semantics and the dispatch overhead is acceptable.

### std::any vs Polymorphic Copy

`std::any` is type-erased value storage with copy support. It does not provide a polymorphic interface, only `any_cast`. Use `std::any` when:

- Storage is heterogeneous and operations are uniform (any_cast or visitor).
- You want value semantics across types with no shared base.

Use polymorphic value types when:

- A common interface exists.
- You want method dispatch without `any_cast`.

`std::variant<A, B, C>` is a third option for closed sets of types: no heap allocation, compile-time-known set, std::visit for dispatch.

### Mixing Virtual Destructors with Move

A virtual destructor is needed for delete-through-base. Declaring it suppresses implicit move generation. Default the moves explicitly:

```cpp
struct Base {
    virtual ~Base() = default;
    Base() = default;
    Base(const Base&) = default;
    Base& operator=(const Base&) = default;
    Base(Base&&) noexcept = default;
    Base& operator=(Base&&) noexcept = default;
};
```

Or, in the modern polymorphic style, delete copy and move on the base because polymorphic objects are owned through pointers, and slicing or sliced moves are bugs to prevent at compile time:

```cpp
struct Base {
    virtual ~Base() = default;
    Base() = default;
    Base(const Base&) = delete;
    Base& operator=(const Base&) = delete;
    Base(Base&&) = delete;
    Base& operator=(Base&&) = delete;
    virtual std::unique_ptr<Base> clone() const = 0;
};
```

This is the more defensive choice. It costs nothing if you always own through `unique_ptr<Base>`.

### Move-Slicing in Standard Library

```cpp
std::vector<Base> v;
v.emplace_back(); // ok, constructs Base
Derived d;
v.emplace_back(std::move(d)); // slice: Base move ctor takes Base subobject
```

The vector cannot store `Derived` because its element type is `Base`. This is a logic error, not a compiler error. The compiler accepts it because `Derived&&` converts to `Base&&`.

Linters and review checklists catch these. The structural fix is to use `std::vector<std::unique_ptr<Base>>`.

### Junior at FAANG vs Senior at FAANG

Junior puts a `std::vector<Animal>` in their code, pushes `Dog` and `Cat` instances, and is confused why all elements behave like `Animal`. Senior reaches for `std::vector<std::unique_ptr<Animal>>` (or a polymorphic value wrapper, or `std::variant<Dog, Cat>`) without thinking. Senior also knows that `Animal` should have a virtual destructor or deleted copy/move to make slicing impossible at compile time, and chooses based on whether downstream code wants value semantics or pointer semantics.

### Drill

1. Why does `std::vector<Base>` slice when storing `Derived`? Element storage is `sizeof(Base)`, the derived part has no room.
2. What's a virtual constructor in C++? There is none. Use `clone()`.
3. What does `move_clone() &&` accomplish? Provides a move-based clone, callable only on rvalues.
4. Why might a polymorphic base delete copy and move? To prevent slicing at compile time and force ownership through pointers.
5. What pattern wraps a polymorphic implementation in a value type with copy semantics? Type erasure with a Concept/Model and a clone-based copy.
