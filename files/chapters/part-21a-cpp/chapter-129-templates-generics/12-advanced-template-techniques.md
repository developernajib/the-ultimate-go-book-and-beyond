## Advanced Template Techniques

### `if constexpr` for Compile-Time Branching (C++17)

`if constexpr` evaluates conditions at compile time and discards the false branch entirely. Code in the discarded branch does not even need to be valid for the given type.

```cpp
template <typename T>
std::string Stringify(const T& value) {
    if constexpr (std::is_same_v<T, std::string>) {
        return value;  // No conversion needed
    } else if constexpr (std::is_arithmetic_v<T>) {
        return std::to_string(value);
    } else if constexpr (requires { value.ToString(); }) {  // C++20 requires
        return value.ToString();
    } else {
        static_assert(sizeof(T) == 0, "Cannot stringify this type");
    }
}
```

### Deduction Guides (C++17)

Class template argument deduction (CTAD) lets you omit template arguments when constructing objects, if the compiler can deduce them.

```cpp
template <typename T, typename U>
struct Pair {
    T first;
    U second;

    Pair(T f, U s) : first(std::move(f)), second(std::move(s)) {}
};

// Deduction guide
template <typename T, typename U>
Pair(T, U) -> Pair<T, U>;

int main() {
    Pair p(42, 3.14);  // Pair<int, double> -- deduced
    // Without the deduction guide, you would need: Pair<int, double> p(42, 3.14) -     return 0 - }
```

Standard library containers have built-in deduction guides:

```cpp
std::vector v = {1, 2, 3};          // std::vector<int>
std::pair p = {42, "hello"};        // std::pair<int, const char*>
std::optional o = 3.14;             // std::optional<double>
std::tuple t = {1, 2.0, "three"};   // std::tuple<int, double, const char*>
```

### Template Template Parameters

You can parameterize a template on another template:

```cpp
template <
    typename T,
    template <typename, typename> class ContainerType = std::vector
>
class DataStore {
    ContainerType<T, std::allocator<T>> data_;
public:
    void Add(const T& value) { data_.push_back(value); }
    size_t Size() const { return data_.size(); }
    auto begin() { return data_.begin(); }
    auto end() { return data_.end(); }
};

int main() {
    DataStore<int> vecStore;                    // uses std::vector
    DataStore<int, std::deque> dequeStore;      // uses std::deque
    DataStore<int, std::list> listStore;        // uses std::list

    vecStore.Add(1);
    dequeStore.Add(2);
    listStore.Add(3);
    return 0;
}
```

Go generics do not support type-constructor parameters, you cannot parameterize a generic type on another generic type.

### Expression Templates (Advanced)

Expression templates are an advanced technique that builds expression trees at compile time to optimize multi-step operations. The canonical example is linear algebra:

```cpp
// Without expression templates:
// Vector a, b, c, d;
// auto result = a + b + c + d;
// Creates 3 temporary vectors: (a+b), ((a+b)+c), (((a+b)+c)+d)

// With expression templates:
// The expression a + b + c + d builds a type like:
// Add<Add<Add<Vec, Vec>, Vec>, Vec>
// When assigned, it evaluates element-by-element in a single pass:
// result[i] = a[i] + b[i] + c[i] + d[i]  -- no temporaries!

template <typename E>
class VecExpr {
public:
    double operator[](size_t i) const {
        return static_cast<const E&>(*this)[i];
    }
    size_t size() const {
        return static_cast<const E&>(*this).size();
    }
};

class Vec : public VecExpr<Vec> {
    std::vector<double> data_;
public:
    Vec(size_t n) : data_(n) {}

    template <typename E>
    Vec(const VecExpr<E>& expr) : data_(expr.size()) {
        for (size_t i = 0; i < data_.size(); ++i) {
            data_[i] = expr[i];  // Evaluates the entire expression tree
        }
    }

    double& operator[](size_t i) { return data_[i]; }
    double operator[](size_t i) const { return data_[i]; }
    size_t size() const { return data_.size(); }
};

template <typename L, typename R>
class VecAdd : public VecExpr<VecAdd<L, R>> {
    const L& left_;
    const R& right_;
public:
    VecAdd(const L& l, const R& r) : left_(l), right_(r) {}
    double operator[](size_t i) const { return left_[i] + right_[i]; }
    size_t size() const { return left_.size(); }
};

template <typename L, typename R>
VecAdd<L, R> operator+(const VecExpr<L>& l, const VecExpr<R>& r) {
    return VecAdd<L, R>(static_cast<const L&>(l), static_cast<const R&>(r));
}
```

Libraries like Eigen and Blaze use expression templates extensively to achieve hand-tuned performance from clean mathematical syntax. This technique is completely impossible in Go.

---
