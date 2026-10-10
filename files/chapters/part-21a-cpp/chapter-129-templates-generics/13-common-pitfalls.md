## Common Pitfalls

### 1. The Most Vexing Parse

C++ grammar ambiguity makes `Stack<int> s()` look like a function declaration, not a variable definition, so it declares a function `s` that returns `Stack<int>` rather than default-constructing an object. Use `Stack<int> s{}` (uniform initialization) or `Stack<int> s` (no parentheses) to unambiguously default-construct the object.
```cpp
// This declares a function, not an object!
Stack<int> s();  // declares a function named s that returns Stack<int>

// Correct ways to default-construct:
Stack<int> s;       // C++03
Stack<int> s{};     // C++11 uniform initialization (preferred)
auto s = Stack<int>();  // Also works
```

### 2. Dependent Name Ambiguity

Inside a template, the compiler cannot always tell if a name refers to a type or a value.

```cpp
template <typename T>
void Process() {
    // Error: is T::value_type a type or a static member?
    // T::value_type x;  // ambiguous

    // Fix: use typename keyword
    typename T::value_type x;
}

template <typename T>
void CallMethod() {
    T t;
    // If foo is a template member function:
    // t.foo<int>(); // ambiguous: is < comparison or template argument?

    // Fix: use template keyword
    t.template foo<int>();
}
```

### 3. Template Definition Visibility

Templates must generally be defined in header files because the compiler needs to see the full definition at the point of instantiation.

```cpp
// BAD: definition in .cpp file (linker error for most uses)
// stack.hpp
template <typename T>
class Stack {
public:
    void Push(const T& value);
};

// stack.cpp
template <typename T>
void Stack<T>::Push(const T& value) { /* ... */ }
// Unless you add explicit instantiations, this won't link.

// GOOD: definition in header file
// stack.hpp
template <typename T>
class Stack {
public:
    void Push(const T& value) {
        // definition right here in the header
    }
};
```

### 4. Template Bloat

Each unique template instantiation generates a separate copy of the code. In large codebases, this can cause significant binary size increases.

```cpp
// Each of these generates a separate function body:
Sort<int>(data1);
Sort<long>(data2);
Sort<unsigned int>(data3);
Sort<short>(data4);
// 4 copies of Sort in the binary, even if the logic is identical
```

Mitigation strategies:
- Factor type-independent logic into non-template base classes or functions
- Use explicit instantiation to control which types are generated
- Use `extern template` to prevent duplicate instantiations across translation units

```cpp
// In header: declare but don't instantiate
extern template class Stack<int>;
extern template class Stack<std::string>;

// In one .cpp file: actually instantiate
template class Stack<int>;
template class Stack<std::string>;
```

### 5. Two-Phase Lookup

Template code is parsed in two phases. In the first phase (when the template is defined), non-dependent names are looked up immediately. In the second phase (when the template is instantiated), dependent names are looked up.

```cpp
void helper(int) { std::cout << "global\n"; }

template <typename T>
class Widget {
public:
    void DoWork(T value) {
        helper(value);     // Dependent: looked up at instantiation time
        helper(42);        // Non-dependent: looked up at definition time
    }
};

// Adding an overload here affects dependent lookup but NOT non-dependent
void helper(double) { std::cout << "double\n"; }

Widget<double> w;
w.DoWork(3.14);  // First call finds helper(double), second calls helper(int)
```

This two-phase behavior is a common source of confusion. Go has no equivalent, all names are resolved during standard compilation.

---
