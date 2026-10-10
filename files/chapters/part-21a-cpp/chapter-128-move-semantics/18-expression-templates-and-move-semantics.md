## Expression Templates and Move Semantics

Expression templates were the original answer to the question "how do we make `a + b + c` not allocate three matrices when we want one?". The trick: build a compile-time expression tree of references, evaluate only at the assignment. Move semantics arrived later and changed both how expression templates capture operands and how the result flows back. Eigen, Blaze, xtensor, and most modern numerical libraries use expression templates plus careful move design.

### The Naive Problem

```cpp
struct Matrix {
    std::vector<double> data;
    std::size_t rows, cols;
};

Matrix operator+(const Matrix& a, const Matrix& b) {
    Matrix r{std::vector<double>(a.data.size()), a.rows, a.cols};
    for (std::size_t i = 0; i < a.data.size(); ++i)
        r.data[i] = a.data[i] + b.data[i];
    return r;
}

Matrix x = a + b + c + d; // three temporaries, three allocations, three loops
```

Each binary `+` builds an intermediate `Matrix`. Even with NRVO and move semantics, the algorithm does N elements times three additions plus three allocations and frees.

### The Expression Template Skeleton

Replace `Matrix + Matrix` with a templated proxy that records the operation and operands by reference:

```cpp
template <class L, class R>
struct AddExpr {
    const L& lhs;
    const R& rhs;

    double operator[](std::size_t i) const {
        return lhs[i] + rhs[i];
    }
    std::size_t size() const { return lhs.size(); }
};

template <class L, class R>
AddExpr<L, R> operator+(const L& a, const R& b) {
    return {a, b};
}

class Matrix {
    std::vector<double> data;
public:
    template <class Expr>
    Matrix& operator=(const Expr& e) {
        data.resize(e.size());
        for (std::size_t i = 0; i < e.size(); ++i)
            data[i] = e[i];
        return *this;
    }
    double operator[](std::size_t i) const { return data[i]; }
    std::size_t size() const { return data.size(); }
};
```

`a + b + c + d` builds an `AddExpr<AddExpr<AddExpr<Matrix,Matrix>,Matrix>,Matrix>` of references. Assignment runs one loop, fused. No intermediate allocations.

### The Move-Semantics Conflict

Expression templates capture operands by reference. If an operand is a temporary, the reference dangles after the full expression finishes:

```cpp
Matrix make_temp();
Matrix x = a + make_temp() + c; // make_temp() is a prvalue
                                // The expression tree references it
                                // After the full expression, the temporary is destroyed
```

In the simple case, the assignment runs before the temporaries die (within the same full-expression). The danger appears when you store the expression:

```cpp
auto e = a + make_temp() + c; // e holds a reference to a destroyed temporary
Matrix x = e;                 // dangling read
```

The Eigen documentation explicitly warns against `auto` with expression results for this reason. The safe rule is to evaluate in the same statement.

### Capture-By-Value for Rvalues

To make `auto e = a + make_temp();` safe, expression templates can store rvalue operands by value and lvalue operands by reference. This is the "deduce and store" pattern using forwarding references.

```cpp
template <class L, class R>
struct AddExpr {
    L lhs; // value or reference depending on T
    R rhs;
    auto operator[](std::size_t i) const {
        return lhs[i] + rhs[i];
    }
    std::size_t size() const { return lhs.size(); }
};

template <class L, class R>
auto operator+(L&& a, R&& b) {
    return AddExpr<L, R>{std::forward<L>(a), std::forward<R>(b)};
}
```

Reference collapsing does the work:

- `a + b` (both lvalues): `L = Matrix&`, `R = Matrix&`. Members are references.
- `a + make_temp()`: `L = Matrix&`, `R = Matrix`. The rvalue is moved into `rhs`.
- `make_temp() + make_temp()`: both members are `Matrix` by value, both moved.

The expression tree now keeps temporaries alive as long as the tree exists. `auto e = ...` is safe.

The cost: storing matrices by value in expression nodes copies (or moves) data. Eigen and Blaze use a lighter trick: they store rvalue references to expressions (which are cheap to move), and the actual matrix data in the leaves is stored by value only when the leaf was a temporary.

### Returning Expression Objects

Functions that build expressions need to think about what they return.

```cpp
auto multiply(const Matrix& a, const Matrix& b) {
    return MulExpr<Matrix, Matrix>{a, b}; // references
}

auto twice(const Matrix& a) {
    return a + a; // AddExpr<Matrix, Matrix> of references to a
}
```

Returning an expression is fine as long as the references inside outlive the expression. If `multiply` is called with temporaries, the result dangles. Use the move-aware version above.

The Eigen 3.4 documentation includes a section "C++11 and later: avoid auto" that captures this exact tension. Eigen recommends using `auto` only when you understand the lifetime contract.

### When Expression Templates Fight Move Semantics

Three places where the systems collide:

#### 1. Returning by value vs returning expressions

```cpp
Matrix add_two(Matrix a, Matrix b) {
    return a + b; // expression promoted to Matrix on return
}
```

The function return type is `Matrix`. The expression is implicitly converted (via `Matrix(const Expr&)`). The expression is evaluated, allocating once. The result is then returned (mandatory elision applies because the result is a prvalue at the return statement). One allocation, one assignment, no copies. Good.

If instead:

```cpp
auto add_two(const Matrix& a, const Matrix& b) {
    return a + b; // returns AddExpr<Matrix, Matrix>
}
```

The caller gets an expression of references to the parameters. The parameters die at the end of the call. The expression is dangling.

#### 2. Temporaries in chains

```cpp
auto e = (a + b) * c; // MulExpr<AddExpr<Matrix, Matrix>, Matrix>
                      // The AddExpr temporary lives until end of full-expression
                      // 'e' captures a reference to that AddExpr
                      // After the statement, the AddExpr is destroyed
                      // 'e' is dangling
```

The fix is to capture rvalue subexpressions by value, as shown above.

#### 3. Self-assignment with aliasing

```cpp
a = a * b; // depending on implementation, may read a after partially writing it
```

Eigen detects aliasing and inserts a temporary. xtensor and Blaze use similar runtime or compile-time guards. The expression template assignment must check whether the LHS appears in the RHS expression tree.

### The Deduce-and-Evaluate Pattern

A frequently-used pattern: deduce the result type from the expression, allocate the result, evaluate, return.

```cpp
template <class Expr>
auto eval(const Expr& e) {
    using T = std::decay_t<decltype(e[0])>;
    Matrix r(e.size());
    for (std::size_t i = 0; i < e.size(); ++i)
        r[i] = e[i];
    return r; // mandatory elision, one allocation total
}

Matrix x = eval(a + b + c + d); // explicit evaluation point
```

This makes the lifetime explicit. `eval` materializes the expression into a value. The caller cannot accidentally hold an expression past the temporaries' lifetimes.

### Move Constructors for Expression Types

Expression types are typically lightweight (a few references or small data). Moving them is essentially a copy of the references. A defaulted move is usually correct and noexcept. Avoid writing custom move operators on expression types unless you have stateful internals.

```cpp
template <class L, class R>
struct AddExpr {
    L lhs;
    R rhs;
    AddExpr(L l, R r) : lhs(std::move(l)), rhs(std::move(r)) {}
    AddExpr(const AddExpr&) = default;
    AddExpr(AddExpr&&) noexcept = default;
};
```

If `L` and `R` are references, the moves and copies are trivial. If they are values (matrices captured from rvalues), the moves are the underlying matrix moves.

### Compile-Time Cost

Expression templates push work to the compiler. A long chain `a + b + c + d + e + f` instantiates a deep template tree. Builds slow down. Eigen's compile times are notorious. Mitigations:

- Provide explicit instantiations for common types in a translation unit.
- Use C++20 modules to avoid re-instantiating in every TU.
- Limit the depth by inserting `eval()` at strategic points.

### Junior at FAANG vs Senior at FAANG

Junior writes `auto m = a + b + c;` with Eigen and gets garbage data on the next line. Senior knows that Eigen expression results are not matrices, that `auto` captures the proxy, and that the proxy holds references. Senior either avoids `auto` for expression results, calls `.eval()` explicitly, or assigns to a typed `Matrix` to force evaluation. Senior also recognizes when temporaries inside an expression chain need by-value capture and writes operator overloads with forwarding references.

### Drill

1. Why does Eigen warn against `auto m = a + b;`? `auto` captures the expression proxy, not the matrix. References inside may dangle.
2. How do you make `auto e = make_temp() + make_temp()` safe? Capture rvalue operands by value (forwarding-ref operator overloads).
3. What is the deduce-and-evaluate pattern? Explicitly evaluate the expression into a typed value at a known point.
4. Why are expression-template moves usually cheap? They hold references or small subexpressions, moving is a shallow copy.
5. What does Eigen do when assignment involves aliasing (`a = a * b`)? Detects the alias and inserts a temporary, otherwise it would read partly-written `a`.
