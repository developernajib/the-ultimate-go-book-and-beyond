## Template Specialization

### Full Specialization

Sometimes a generic algorithm does not work for a specific type, or you want to provide a more efficient implementation. Full specialization lets you replace the template's implementation for one concrete type.

```cpp
// Primary template -- works for most types
template <typename T>
class Serializer {
public:
    static std::string Serialize(const T& value) {
        // Generic: use stringstream
        std::ostringstream oss;
        oss << value;
        return oss.str();
    }
};

// Full specialization for bool -- "true"/"false" instead of "1"/"0"
template <>
class Serializer<bool> {
public:
    static std::string Serialize(const bool& value) {
        return value ? "true" : "false";
    }
};

// Full specialization for std::vector<uint8_t> -- base64 encoding
template <>
class Serializer<std::vector<uint8_t>> {
public:
    static std::string Serialize(const std::vector<uint8_t>& data) {
        // In production you would use a real base64 library.
        std::string result = "base64[";
        for (auto byte : data) {
            char buf[4];
            snprintf(buf, sizeof(buf), "%02x", byte);
            result += buf;
        }
        result += "]";
        return result;
    }
};

int main() {
    std::cout << Serializer<int>::Serialize(42) << "\n";       // "42"
    std::cout << Serializer<bool>::Serialize(true) << "\n";    // "true"

    std::vector<uint8_t> data = {0xDE, 0xAD, 0xBE, 0xEF};
    std::cout << Serializer<std::vector<uint8_t>>::Serialize(data) << "\n";
    // "base64[deadbeef]"
    return 0;
}
```

Go has no template specialization. The closest pattern is type switching inside a generic function, but that happens at runtime:

```go
func Serialize[T any](value T) string {
    switch v := any(value).(type) {
    case bool:
        if v {
            return "true"
        }
        return "false"
    default:
        return fmt.Sprint(value)
    }
}
```

### Function Template Specialization vs Overloading

For function templates, prefer overloading over specialization. Function template specialization has surprising behavior: specializations do not participate in overload resolution the way you might expect.

```cpp
// Primary template
template <typename T>
void Process(T value) {
    std::cout << "generic: " << value << "\n";
}

// Overload for int* -- PREFERRED approach
void Process(int* value) {
    std::cout << "int pointer: " << *value << "\n";
}

// Specialization for int* -- SURPRISING behavior
// This specializes the PRIMARY template, not the pointer overload
template <>
void Process<int*>(int* value) {
    std::cout << "specialized int pointer: " << *value << "\n";
}

// If you had a pointer overload template:
template <typename T>
void Process(T* value) {
    std::cout << "pointer: " << *value << "\n";
}

// Then specializing Process<int*> would specialize the PRIMARY template,
// NOT the pointer template. This is the source of endless bugs.
```

The rule of thumb: use overloads for function templates, use specialization for class templates.

### Partial Specialization

Partial specialization lets you specialize a template for a *family* of types. This is only available for class templates, not function templates.

```cpp
// Primary template
template <typename T, typename Allocator = std::allocator<T>>
class SmartBuffer {
    std::vector<T, Allocator> data_;
public:
    void Add(const T& value) { data_.push_back(value); }
    size_t Size() const { return data_.size(); }
};

// Partial specialization for pointer types
template <typename T>
class SmartBuffer<T*> {
    std::vector<T*> ptrs_;
public:
    void Add(T* ptr) {
        if (ptr != nullptr) {  // Null-check for pointer types
            ptrs_.push_back(ptr);
        }
    }
    size_t Size() const { return ptrs_.size(); }

    // Extra method only for pointer specialization
    void DeleteAll() {
        for (auto* p : ptrs_) { delete p; }
        ptrs_.clear();
    }
};

// Partial specialization for pairs
template <typename K, typename V>
class SmartBuffer<std::pair<K, V>> {
    std::vector<std::pair<K, V>> pairs_;
public:
    void Add(const K& key, const V& value) {
        pairs_.emplace_back(key, value);
    }
    size_t Size() const { return pairs_.size(); }
};
```

The compiler picks the most specialized match. If you use `SmartBuffer<int*>`, the pointer specialization wins. If you use `SmartBuffer<int>`, the primary template wins.

### Specialization Ordering and Ambiguity

When multiple partial specializations could match, the compiler selects the most specific one. If no single specialization is more specific than all others, the program is ill-formed (ambiguous).

```cpp
template <typename T, typename U>
struct Pair { static constexpr int id = 0; };  // Primary

template <typename T>
struct Pair<T, T> { static constexpr int id = 1; };  // Same types

template <typename T>
struct Pair<T, int> { static constexpr int id = 2; };  // Second is int

template <typename T>
struct Pair<T*, T*> { static constexpr int id = 3; };  // Both pointers

static_assert(Pair<double, float>::id == 0);   // Primary
static_assert(Pair<int, int>::id == 1);        // Same types (more specific than id=2)
static_assert(Pair<double, int>::id == 2);     // Second is int
static_assert(Pair<int*, int*>::id == 3);      // Both pointers (most specific)
// Pair<int, int> matches both id=1 and id=2, but id=1 is more specialized
```

### When to Use Each

| Situation | Technique |
|---|---|
| One specific type needs different behavior | Full specialization |
| A category of types (pointers, arrays, pairs) needs different behavior | Partial specialization |
| You want to add constraints without rewriting | Concepts (C++20) or SFINAE |
| You need runtime type branching | Virtual dispatch or `std::variant` |

---

### Junior → FAANG: Specialization as a Type-Specific Override

Template specialization is C++'s way of saying "do this for all types, except do something different for this specific type." The most common use case is providing an optimized implementation for a primitive type while keeping the general implementation for user types. `std::hash<int>` is a specialization for `int`. `std::hash<std::string>` is a specialization for `std::string`. The primary template handles everything else.

The common beginner mistake: partially specializing a function template (which is not allowed in C++). Full specialization of function templates is allowed, but partial specialization is not. Use overloading instead. Class template partial specialization is allowed. Know this distinction before writing any specialization.

### Senior @ FAANG: Specialization as a Customization Point and Its Maintenance Cost

At the staff level, specialization is a customization point in a library API. When you specialize `std::hash`, `std::less`, or a library-defined trait, you are extending the library's behavior for your type. This is a powerful but fragile mechanism: specializations must be placed in the correct namespace, must be provided before the primary template is instantiated, and must satisfy the same semantic requirements as the primary template.

**Customization point objects (CPO) as the modern alternative.** C++20's ranges library replaced specialization-based customization points with CPOs (function objects that dispatch to `tag_invoke` or ADL). This model is more composable and less fragile than specialization. A staff engineer designing a new extensibility mechanism evaluates CPOs before specialization: CPOs produce better error messages, are easier to compose, and do not require placement in a specific namespace.

**Specialization maintenance in a growing codebase.** When a library adds a new primary template, every existing specialization for it must be reviewed for compatibility with the new primary. In a large codebase with many specializations, this is a mechanical review task that scales poorly. A staff engineer documents all specializations of a primary template in a single location (a comment in the primary template header), making the review tractable.

