## Compile-Time vs Runtime Polymorphism

### The Two Approaches

C++ offers two fundamentally different ways to achieve polymorphism:

**Runtime polymorphism (virtual dispatch):**

```cpp
class Animal {
public:
    virtual ~Animal() = default;
    virtual std::string Speak() const = 0;
    virtual std::string Name() const = 0;
};

class Dog : public Animal {
public:
    std::string Speak() const override { return "Woof!"; }
    std::string Name() const override { return "Dog"; }
};

class Cat : public Animal {
public:
    std::string Speak() const override { return "Meow!"; }
    std::string Name() const override { return "Cat"; }
};

void MakeNoise(const Animal& animal) {
    std::cout << animal.Name() << " says " << animal.Speak() << "\n";
}

int main() {
    Dog dog;
    Cat cat;
    MakeNoise(dog);  // Dog says Woof!
    MakeNoise(cat);  // Cat says Meow!

    // Heterogeneous collection
    std::vector<std::unique_ptr<Animal>> zoo;
    zoo.push_back(std::make_unique<Dog>());
    zoo.push_back(std::make_unique<Cat>());
    for (const auto& a : zoo) {
        MakeNoise(*a);
    }
    return 0;
}
```

**Compile-time polymorphism (templates):**

```cpp
class Dog {
public:
    std::string Speak() const { return "Woof!"; }
    std::string Name() const { return "Dog"; }
};

class Cat {
public:
    std::string Speak() const { return "Meow!"; }
    std::string Name() const { return "Cat"; }
};

template <typename AnimalT>
void MakeNoise(const AnimalT& animal) {
    std::cout << animal.Name() << " says " << animal.Speak() << "\n";
}

int main() {
    Dog dog;
    Cat cat;
    MakeNoise(dog);  // Dog says Woof!  (MakeNoise<Dog> generated)
    MakeNoise(cat);  // Cat says Meow!  (MakeNoise<Cat> generated)

    // Cannot have heterogeneous collection without type erasure
    // std::vector<???> zoo; // what type goes here?
    return 0;
}
```

### The Performance Difference

Virtual dispatch costs approximately 2-5 nanoseconds per call on modern hardware due to the indirect function call through the vtable pointer. This sounds tiny, but in hot loops processing millions of elements, it adds up. More importantly, virtual calls prevent the compiler from inlining, which blocks further optimizations like loop vectorization and constant propagation.

```cpp
// Virtual dispatch: compiler cannot inline Speak()
for (const auto& a : zoo) {
    a->Speak();  // indirect call through vtable -- ~2-5ns overhead
}

// Template dispatch: compiler inlines Speak() completely
for (const auto& d : dogs) {
    d.Speak();  // direct call, likely inlined -- zero overhead
}
```

### Decision Matrix

| Criterion | Use Templates (Compile-Time) | Use Virtual (Runtime) |
|---|---|---|
| Types known at compile time | Yes | - |
| Heterogeneous collections | - | Yes |
| Plugin / extension architecture | - | Yes |
| Performance critical | Yes | - |
| Binary size sensitive | - | Yes |
| Types loaded at runtime (DLLs) | - | Yes |
| Need inlining | Yes | - |
| Need polymorphic containers | - | Yes |

### Type Erasure: The Best of Both Worlds

Type erasure combines compile-time templates with runtime polymorphism. `std::function` is the canonical example:

```cpp
#include <functional>

template <typename F>
void Apply(const std::vector<int>& data, F func) {
    // Compile-time: F is known, func can be inlined
    for (int x : data) {
        func(x);
    }
}

void ApplyErased(const std::vector<int>& data, std::function<void(int)> func) {
    // Runtime: func is type-erased, cannot be inlined
    for (int x : data) {
        func(x);
    }
}
```

Go interfaces are essentially type erasure: they store a pointer to the data and a pointer to the method table (itab). The Go approach is always type-erased, you never get monomorphized dispatch through an interface.

### `std::variant` and `std::visit`: A Middle Ground

C++17's `std::variant` provides a closed set of types with compile-time safety and near-zero overhead:

```cpp
#include <variant>

using Shape = std::variant<Circle, Rectangle, Triangle>;

double AreaOf(const Shape& s) {
    return std::visit([](const auto& shape) {
        return shape.Area();
    }, s);
}

std::vector<Shape> shapes;
shapes.push_back(Circle{5.0});
shapes.push_back(Rectangle{3.0, 4.0});

for (const auto& s : shapes) {
    std::cout << AreaOf(s) << "\n";
}
```

This gives you heterogeneous collections with compile-time type checking and no heap allocation. The `std::visit` call is typically implemented as a jump table, which is faster than virtual dispatch for small variant sets. Go has no direct equivalent, the closest is a type switch on an interface.

---
