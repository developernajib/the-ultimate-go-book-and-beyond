## Operator Overloading

C++ lets you define custom behavior for operators. Go does not support operator overloading at all.

### Arithmetic Operators

Arithmetic operators are overloaded as member functions returning new `Vector2D` values by value, while compound-assignment operators (`+=`) return `*this` by reference to support chaining. The `const` qualifier on binary operator methods ensures they can be called on const objects, and the equality operator enables use with standard algorithms and containers that rely on `==`.
```cpp
class Vector2D {
public:
    double x, y;

    Vector2D(double x = 0, double y = 0) : x(x), y(y) {}

    // Addition
    Vector2D operator+(const Vector2D& rhs) const {
        return {x + rhs.x, y + rhs.y};
    }

    // Subtraction
    Vector2D operator-(const Vector2D& rhs) const {
        return {x - rhs.x, y - rhs.y};
    }

    // Scalar multiplication
    Vector2D operator*(double scalar) const {
        return {x * scalar, y * scalar};
    }

    // Compound assignment
    Vector2D& operator+=(const Vector2D& rhs) {
        x += rhs.x;
        y += rhs.y;
        return *this;
    }

    // Equality
    bool operator==(const Vector2D& rhs) const {
        return x == rhs.x && y == rhs.y;
    }

    bool operator!=(const Vector2D& rhs) const {
        return !(*this == rhs);
    }

    // Stream output (friend, not member)
    friend std::ostream& operator<<(std::ostream& os, const Vector2D& v) {
        return os << "(" << v.x << ", " << v.y << ")";
    }
};

// Non-member: scalar * vector (enables 2.0 * vec)
Vector2D operator*(double scalar, const Vector2D& v) {
    return v * scalar;
}

// Usage
Vector2D a(1, 2), b(3, 4);
Vector2D c = a + b;           // (4, 6)
Vector2D d = c * 2.0;         // (8, 12)
Vector2D e = 3.0 * a;         // (3, 6)
std::cout << "c = " << c << "\n";  // c = (4, 6)
```

### Subscript Operator

`operator()` is overloaded in both const and non-const versions: the non-const overload returns `double&` allowing in-place modification (`m(0,0) = 5.0`), while the const overload returns `const double&` for read-only access on const `Matrix` instances. Bounds checking inside the operator throws `std::out_of_range` rather than silently accessing out-of-bounds memory.
```cpp
class Matrix {
public:
    Matrix(size_t rows, size_t cols)
        : rows_(rows), cols_(cols), data_(rows * cols, 0.0) {}

    // Non-const version: allows modification
    double& operator()(size_t row, size_t col) {
        if (row >= rows_ || col >= cols_) {
            throw std::out_of_range("Matrix index out of bounds");
        }
        return data_[row * cols_ + col];
    }

    // Const version: read-only access
    const double& operator()(size_t row, size_t col) const {
        if (row >= rows_ || col >= cols_) {
            throw std::out_of_range("Matrix index out of bounds");
        }
        return data_[row * cols_ + col];
    }

    size_t rows() const { return rows_; }
    size_t cols() const { return cols_; }

private:
    size_t rows_, cols_;
    std::vector<double> data_;
};

Matrix m(3, 3);
m(0, 0) = 1.0;
m(1, 1) = 1.0;
m(2, 2) = 1.0; // identity matrix diagonal
```

### Function Call Operator (Functors)

Making an object callable like a function:

```cpp
class Multiplier {
public:
    explicit Multiplier(double factor) : factor_(factor) {}

    double operator()(double value) const {
        return value * factor_;
    }

private:
    double factor_;
};

Multiplier triple(3.0);
std::cout << triple(5.0) << "\n";  // 15.0

// Useful with algorithms
std::vector<double> values = {1, 2, 3, 4, 5};
std::vector<double> result;
std::transform(values.begin(), values.end(),
               std::back_inserter(result), Multiplier(10.0));
// result: {10, 20, 30, 40, 50}
```

**Go comparison:** Go uses named methods and first-class functions instead of operator overloading:

```go
package main

import "fmt"

type Vector2D struct{ X, Y float64 }

func (v Vector2D) Add(other Vector2D) Vector2D {
    return Vector2D{v.X + other.X, v.Y + other.Y}
}

func (v Vector2D) Scale(s float64) Vector2D {
    return Vector2D{v.X * s, v.Y * s}
}

// Functors are just closures
func NewMultiplier(factor float64) func(float64) float64 {
    return func(value float64) float64 {
        return value * factor
    }
}

func main() {
    // Usage
    a := Vector2D{1, 2}
    b := Vector2D{3, 4}
    c := a.Add(b)      // not a + b, but explicit and unambiguous
    d := c.Scale(2.0)
    _ = d

    triple := NewMultiplier(3.0)
    fmt.Println(triple(5.0)) // 15.0
}
```

### Conversion Operators

`operator double()` defines an implicit conversion that fires automatically wherever a `double` is expected (e.g., passing `Fraction` to a `double` parameter). The `explicit operator bool()` requires a cast or a boolean context to trigger, preventing surprising conversions like `Fraction + int` silently going through `bool`.
```cpp
class Fraction {
public:
    Fraction(int num, int den) : num_(num), den_(den) {}

    // Implicit conversion to double
    operator double() const {
        return static_cast<double>(num_) / den_;
    }

    // Explicit conversion to bool (C++11)
    explicit operator bool() const {
        return num_ != 0;
    }

private:
    int num_, den_;
};

Fraction half(1, 2);
double d = half;           // 0.5 (implicit conversion)
// bool b = half;          // ERROR: explicit conversion required
bool b = static_cast<bool>(half); // OK
if (half) { /* OK: explicit operator bool works in boolean contexts */ }
```

---

### Junior → FAANG: Operator Overloading Discipline

Go deliberately omitted operator overloading to keep code readable. C++ includes it, but the same readability concerns apply. Overloading `+` for a matrix type is intuitive. Overloading `<<` for serialization of a business object is questionable. Overloading `*` for a lock guard is confusing.

Rule of thumb: only overload operators for types that behave mathematically or where the operator has a universally understood meaning. `operator<<` for stream output, `operator==` and `operator<=>` for comparison, and arithmetic operators for numeric types are all appropriate. For anything else, use a named function.

First-job habit: always implement comparison operators using `operator<=>` (C++20, the spaceship operator) instead of manually implementing all six comparison operators. It generates all six from one definition, and it is less error-prone.

### Senior @ FAANG: Operator Overloading in Library APIs and Hidden Costs

At the staff level, operator overloading in a library API creates readability and discoverability problems. When you call `a + b`, there is no indication that this operation allocates, is O(n), or may throw. A named function `Concatenate(a, b)` makes these properties visible in the code and searchable in documentation.

**`operator bool` traps.** `operator bool` (or `operator int`) on a class allows instances to be used in boolean and arithmetic contexts silently. Even with `explicit`, `if (obj)` compiles. In a large codebase, this can create subtle bugs where an object is accidentally used in an arithmetic expression. A staff engineer restricts `operator bool` to smart pointer types and optional types where the boolean check is the primary use case, and uses named accessors (`is_valid()`, `has_value()`) for other types.

**Operator overloading and expression templates.** For high-performance numeric libraries (linear algebra, signal processing), expression templates use operator overloading to build a computation DAG at compile time, delaying evaluation until the result is needed. This eliminates temporaries and enables fusion of operations (e.g., `(A + B) * C` evaluates as a single fused operation). This is an advanced pattern that explains why libraries like Eigen (linear algebra) and Blaze use operator overloading heavily. A staff engineer evaluating a numeric library for use in a performance-critical path asks whether it uses expression templates and what the compile-time cost is.

