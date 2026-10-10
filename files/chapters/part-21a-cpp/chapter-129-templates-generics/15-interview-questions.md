## Interview Questions

### Conceptual Questions

**Q1: What is the difference between a template and a macro? Why are templates preferred?**

Templates are type-safe, scoped, and participate in overload resolution. Macros are textual substitution, they have no understanding of types, scopes, or C++ semantics. Templates produce meaningful error messages (especially with concepts), are debuggable, and respect namespaces. Macros can silently produce wrong code. Additionally, templates are evaluated by the compiler with full type information, while macros are processed by the preprocessor before the compiler even sees the code.

**Q2: Explain SFINAE. Why does it exist and when would you use it?**

SFINAE stands for "Substitution Failure Is Not An Error." When the compiler substitutes template arguments into a template and the result is invalid, that overload is silently removed from the candidate set. It exists because without it, a single invalid substitution would make programs with multiple overloads uncompilable. You use it (pre-C++20) to conditionally enable/disable template overloads based on type properties. In C++20, concepts are the preferred replacement.

**Q3: What is template argument deduction? What are its limitations?**

The compiler infers template type parameters from function arguments. Limitations: it does not deduce from return types, it cannot deduce non-type parameters from runtime values, it requires exact matches (no implicit conversions during deduction), it cannot deduce through nested templates without deduction guides, and it does not work in non-deduced contexts (e.g., the left side of `::` in dependent names).

**Q4: Why must templates usually be defined in header files?**

The compiler needs the full template definition at the point of instantiation to generate code for specific types. Since different translation units may instantiate the same template with different types, the definition must be visible everywhere. The alternative is explicit instantiation in a `.cpp` file, but only for known types. C++20 modules partially address this issue by allowing template definitions in module interface units that can be imported.

**Q5: Compare C++ concepts with Go interface constraints. What can concepts express that Go constraints cannot?**

Concepts can require: specific expressions to be valid (`a + b`), associated types (`typename T::iterator`), non-type properties (`sizeof(T) <= 8`), and nested requirements. Go constraints can only express method signatures and explicit type sets. Concepts are structural (duck typing), while Go constraints are nominal for type sets and structural for methods. Concepts can express relationships between multiple types. Go constraints operate on individual type parameters independently. Concepts also support subsumption for overload resolution, allowing the most constrained overload to be selected automatically.

**Q6: What is the difference between `typename` and `class` in template parameter lists?**

In `template <typename T>` and `template <class T>`, they are completely interchangeable. However, for template template parameters, `class` was required before C++17: `template <template <typename> class Container>`. Since C++17, `typename` works there too. The convention in modern code is to use `typename` everywhere for consistency.

### Coding Questions

**Q7: Implement a compile-time power function using templates.**

```cpp
template <typename T, int Exp>
constexpr T Power(T base) {
    if constexpr (Exp == 0) {
        return T(1);
    } else if constexpr (Exp < 0) {
        return T(1) / Power<T, -Exp>(base);
    } else if constexpr (Exp % 2 == 0) {
        T half = Power<T, Exp / 2>(base);
        return half * half;
    } else {
        return base * Power<T, Exp - 1>(base);
    }
}

static_assert(Power<int, 10>(2) == 1024);
static_assert(Power<int, 0>(999) == 1);
```

**Q8: Write a `Variant`-like type that can hold one of several types (simplified `std::variant`).**

```cpp
template <typename... Types>
class SimpleVariant;

template <typename First, typename... Rest>
class SimpleVariant<First, Rest...> {
    union {
        First first_;
        SimpleVariant<Rest...> rest_;
    };
    size_t index_;

public:
    SimpleVariant(const First& value) : first_(value), index_(0) {}

    template <typename T>
    SimpleVariant(const T& value) : rest_(value), index_(rest_.Index() + 1) {}

    size_t Index() const { return index_; }

    template <typename T>
    const T& Get() const {
        if constexpr (std::is_same_v<T, First>) {
            if (index_ != 0) throw std::bad_variant_access();
            return first_;
        } else {
            return rest_.template Get<T>();
        }
    }
};

template <>
class SimpleVariant<> {
public:
    size_t Index() const { throw std::bad_variant_access(); }
};
```

**Q9: What is wrong with this code? How would you fix it?**

```cpp
template <typename T>
class Base {
public:
    void Interface() {
        static_cast<T*>(this)->Implementation();
    }
};

class Derived : public Base<Derived> {
public:
    void Implementation() {
        std::cout << "Derived\n";
    }
};

class Wrong : public Base<Derived> {  // BUG: should be Base<Wrong>
public:
    void Implementation() {
        std::cout << "Wrong\n";
    }
};
```

The bug is that `Wrong` inherits from `Base<Derived>` instead of `Base<Wrong>`. The `static_cast<T*>(this)` will cast a `Wrong*` to a `Derived*`, which is undefined behavior. In C++20, you can prevent this with a concept or static assert:

```cpp
template <typename T>
class Base {
    Base() {
        // Verify at compile time that T is actually the derived class
        static_assert(std::is_base_of_v<Base<T>, T>,
                      "CRTP misuse: T must derive from Base<T>");
    }
    friend T;  // Only T can construct Base<T>
public:
    void Interface() {
        static_cast<T*>(this)->Implementation();
    }
};
```

**Q10: Implement a function that concatenates an arbitrary number of strings efficiently.**

```cpp
template <typename... Args>
    requires (std::convertible_to<Args, std::string_view> && ...)
std::string Concat(const Args&... args) {
    // Pre-calculate total size to avoid reallocations
    size_t total = (std::string_view(args).size() + ...);
    std::string result;
    result.reserve(total);
    ((result += std::string_view(args)), ...);
    return result;
}

auto s = Concat("Hello", " ", "World", "!");  // "Hello World!"
```

**Q11: Explain what happens at each stage when the compiler processes `std::vector<int> v = {1, 2, 3};`**

The compiler: (1) looks up `std::vector`, finding a class template. (2) substitutes `T = int` and `Allocator = std::allocator<int>`. (3) instantiates the class definition with these types. (4) instantiates the `initializer_list` constructor because it is called. (5) does NOT instantiate unused member functions (e.g., `at()` is not instantiated unless called). This lazy instantiation means a template class can have member functions that would be invalid for certain types, as long as those functions are never called with those types.

**Q12 (Staff-level): Design a compile-time state machine using templates.**

This tests deep template metaprogramming knowledge. The expected answer should use types to represent states, template specialization to represent valid transitions, and `static_assert` to enforce valid state sequences at compile time.

```cpp
// States
struct Idle {};
struct Running {};
struct Paused {};
struct Stopped {};

// Transition validation
template <typename From, typename To>
struct ValidTransition : std::false_type {};

template <> struct ValidTransition<Idle, Running> : std::true_type {};
template <> struct ValidTransition<Running, Paused> : std::true_type {};
template <> struct ValidTransition<Running, Stopped> : std::true_type {};
template <> struct ValidTransition<Paused, Running> : std::true_type {};
template <> struct ValidTransition<Paused, Stopped> : std::true_type {};

template <typename CurrentState>
class StateMachine {
public:
    template <typename NextState>
    StateMachine<NextState> TransitionTo() const {
        static_assert(ValidTransition<CurrentState, NextState>::value,
                      "Invalid state transition");
        return StateMachine<NextState>{};
    }
};

int main() {
    auto sm = StateMachine<Idle>{};
    auto running = sm.TransitionTo<Running>();    // OK
    auto paused = running.TransitionTo<Paused>(); // OK
    auto back = paused.TransitionTo<Running>();   // OK
    auto done = back.TransitionTo<Stopped>();     // OK

    // auto bad = sm.TransitionTo<Paused>();       // compile error!
    // auto bad2 = done.TransitionTo<Running>();   // compile error!
    return 0;
}
```

**Q13 (Staff-level): What is the difference between `std::move` and `std::forward`? When would you use each in template code?**

`std::move` unconditionally casts its argument to an rvalue reference. `std::forward` conditionally casts: it preserves the original value category of the argument (lvalue stays lvalue, rvalue stays rvalue). Use `std::move` when you know you are done with an object and want to transfer ownership. Use `std::forward` exclusively in forwarding references (`T&&` where `T` is a template parameter) to preserve the caller's intent. Using `std::move` on a forwarding reference would incorrectly move lvalue arguments. Using `std::forward` outside of forwarding contexts is meaningless.

---
