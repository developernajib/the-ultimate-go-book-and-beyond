## Expression Templates for Embedded DSLs

An expression template is a template-instantiated tree that represents a computation without performing it. By the time the tree is evaluated, the compiler has seen the entire expression and can fuse operations, hoist common subexpressions, and vectorize the result. This is how Eigen, Blaze, and xtensor achieve performance that beats hand-written loops on linear algebra: they do not compute intermediate matrices, they compute a single fused kernel.

### The Classic Problem

```cpp
// Naive vector math. Three temporaries, three passes over memory.
std::vector<double> add_scale(const std::vector<double>& a,
                              const std::vector<double>& b,
                              double c) {
    std::vector<double> t1(a.size());
    for (std::size_t i = 0; i < a.size(); ++i) t1[i] = a[i] + b[i];
    std::vector<double> t2(a.size());
    for (std::size_t i = 0; i < a.size(); ++i) t2[i] = t1[i] * c;
    return t2;
}

// Hand-fused. One temporary, one pass. 3x faster for large vectors.
std::vector<double> add_scale_fused(const std::vector<double>& a,
                                    const std::vector<double>& b,
                                    double c) {
    std::vector<double> out(a.size());
    for (std::size_t i = 0; i < a.size(); ++i) out[i] = (a[i] + b[i]) * c;
    return out;
}
```

You want the clean syntax of the first and the performance of the second. Expression templates deliver both.

### Building the Expression Tree

Each operator returns a template instance that represents the operation, not the result. Evaluation happens only on assignment.

```cpp
#include <cstddef>
#include <type_traits>
#include <vector>

template <typename Derived>
struct Expr {
    double operator[](std::size_t i) const {
        return static_cast<const Derived&>(*this)[i];
    }
    std::size_t size() const {
        return static_cast<const Derived&>(*this).size();
    }
};

struct VecLeaf : Expr<VecLeaf> {
    const std::vector<double>& v_;
    explicit VecLeaf(const std::vector<double>& v) : v_(v) {}
    double operator[](std::size_t i) const { return v_[i]; }
    std::size_t size() const { return v_.size(); }
};

template <typename L, typename R>
struct Add : Expr<Add<L, R>> {
    const L& l_;
    const R& r_;
    Add(const L& l, const R& r) : l_(l), r_(r) {}
    double operator[](std::size_t i) const { return l_[i] + r_[i]; }
    std::size_t size() const { return l_.size(); }
};

template <typename L>
struct Scale : Expr<Scale<L>> {
    const L& l_;
    double c_;
    Scale(const L& l, double c) : l_(l), c_(c) {}
    double operator[](std::size_t i) const { return l_[i] * c_; }
    std::size_t size() const { return l_.size(); }
};

template <typename L, typename R>
auto operator+(const Expr<L>& l, const Expr<R>& r) {
    return Add<L, R>(static_cast<const L&>(l), static_cast<const R&>(r));
}

template <typename L>
auto operator*(const Expr<L>& l, double c) {
    return Scale<L>(static_cast<const L&>(l), c);
}

// Assignment into a concrete vector triggers evaluation.
class Vec {
    std::vector<double> data_;
public:
    explicit Vec(std::size_t n) : data_(n) {}

    template <typename E>
    Vec& operator=(const Expr<E>& e) {
        const auto& expr = static_cast<const E&>(e);
        data_.resize(expr.size());
        for (std::size_t i = 0; i < expr.size(); ++i) {
            data_[i] = expr[i];
        }
        return *this;
    }

    VecLeaf as_expr() const { return VecLeaf(data_); }
    double operator[](std::size_t i) const { return data_[i]; }
    std::size_t size() const { return data_.size(); }
};
```

### Usage

```cpp
Vec a(1000), b(1000), result(1000);
// ... fill a and b ...
result = (a.as_expr() + b.as_expr()) * 3.14;
// Generates one loop with body: data_[i] = (a_[i] + b_[i]) * 3.14
// Zero temporaries. The compiler inlines every operator[] call.
```

The compiler sees through every layer of the template nest. After inlining, the emitted loop is indistinguishable from the hand-fused version. On `-O3` with a modern Clang, the loop is also auto-vectorized into AVX2 or AVX-512 instructions.

### When to Use Expression Templates

Expression templates pay off when:
1. The expression tree has depth (three or more operations). A single `a + b` shows no benefit.
2. The operands are large (thousands of elements). Small operands do not amortize template-instantiation compile-time cost.
3. The operations are dense element-wise or reductions. Non-local operations (matrix multiply) require different techniques (dimension analysis, tiling).

### The Compile-Time Cost

Every distinct expression shape produces a distinct template instantiation. A codebase that constructs hundreds of unique expressions may see a measurable compile-time penalty. Mitigate with:
- `constexpr` evaluation where inputs are compile-time known.
- Explicit instantiation of common expression shapes in a translation unit.
- Limiting the depth of expression templates by introducing explicit `eval()` or `materialize()` calls at logical boundaries.

### Modern Alternatives

C++20 `std::ranges` provides a more limited form of expression-tree composition: views are lazy and fuse on iteration. For pure element-wise work on contiguous data, a `std::ranges::views::zip_transform`-based pipeline often matches expression templates with simpler code. For heavyweight linear algebra, use Eigen or xtensor rather than rolling your own. The pattern above is foundational knowledge, but in production you typically compose with an existing library rather than reinventing the mechanism.
