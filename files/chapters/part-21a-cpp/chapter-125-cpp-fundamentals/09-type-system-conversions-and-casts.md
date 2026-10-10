## Type System: Conversions and Casts

Go is strict about type conversions: you must always be explicit. C++ is more permissive, allowing some implicit conversions while providing four distinct explicit cast operators for different use cases.

### Implicit Conversions (Dangers)

C++ performs several implicit conversions that Go would reject:

```cpp
// Numeric promotions (widening) - generally safe
int a = 42;
double b = a;           // int -> double: OK, no data loss

// Numeric narrowing - dangerous, silent data loss
double x = 3.14;
int y = x;               // double -> int: silently truncates to 3!
// Go: var y int = x      // COMPILE ERROR

// Bool conversions
int n = 42;
if (n) {                 // int -> bool: 0 is false, everything else is true
    // this runs
}
// Go: if n {             // COMPILE ERROR: n is not bool

// Pointer conversions
void* vp = &n;           // any pointer -> void*: implicit in C++
// Go: no void pointers, no implicit conversions

// Signed/unsigned mixing
unsigned int u = 10;
int s = -1;
if (s < u) {             // SURPRISE: s is converted to unsigned!
    // s becomes a huge positive number (4294967295 on 32-bit)
    // So this condition is FALSE, not true!
    std::cout << "expected\n";
} else {
    std::cout << "unexpected!\n";  // THIS prints
}
```

**Use brace initialization to prevent narrowing:**

```cpp
int x{3.14};             // COMPILE ERROR: narrowing conversion
unsigned int u{-1};      // COMPILE ERROR: narrowing conversion
```

### Explicit Casts: The Four C++ Cast Operators

C++ has four cast operators, each for a specific purpose. Go has only `T(expr)`, which maps closest to `static_cast`.

#### static_cast: The "Normal" Cast

This is the most common cast. It performs conversions that are well-defined at compile time: numeric conversions, up/down casts in inheritance hierarchies, and explicit conversions.

```cpp
// Numeric conversion (equivalent to Go's T(expr))
double pi = 3.14159;
int truncated = static_cast<int>(pi);  // 3, same as Go's int(pi)

// Enum to int
enum class Color { Red, Green, Blue };
int colorVal = static_cast<int>(Color::Green);  // 1

// Upcasting in inheritance (derived -> base)
class Animal { public: virtual ~Animal() {} };
class Dog : public Animal {};

Dog d;
Animal* a = static_cast<Animal*>(&d);  // safe upcast

// Downcasting (base -> derived) - compiles but NOT checked at runtime!
Animal* animal = new Dog();
Dog* dog = static_cast<Dog*>(animal);  // works if animal IS a Dog
// If animal was actually a Cat, this is UNDEFINED BEHAVIOR
```

**Go equivalent:**

```go
pi := 3.14159
truncated := int(pi)  // 3

// Go has no inheritance, so up/downcasting doesn't apply
// Go uses type assertions instead:
var a Animal = &Dog{}
d, ok := a.(*Dog)  // safe type assertion with check
```

#### dynamic_cast: Runtime-Checked Polymorphic Cast

This cast checks at runtime whether the conversion is valid. It only works with polymorphic types (classes with at least one virtual function).

```cpp
class Animal {
public:
    virtual ~Animal() {}  // must have at least one virtual function
    virtual void speak() = 0;
};

class Dog : public Animal {
public:
    void speak() override { std::cout << "Woof!\n"; }
    void fetch() { std::cout << "Fetching!\n"; }
};

class Cat : public Animal {
public:
    void speak() override { std::cout << "Meow!\n"; }
};

void handleAnimal(Animal* animal) {
    // Try to cast to Dog
    Dog* dog = dynamic_cast<Dog*>(animal);
    if (dog != nullptr) {
        dog->fetch();  // safe: we verified it's a Dog
    } else {
        std::cout << "Not a dog\n";
    }
}

int main() {
    Dog d;
    Cat c;
    handleAnimal(&d);  // prints "Fetching!"
    handleAnimal(&c);  // prints "Not a dog"
    return 0;
}

// With references, dynamic_cast throws std::bad_cast on failure:
void handleAnimalRef(Animal& animal) {
    try {
        Dog& dog = dynamic_cast<Dog&>(animal);
        dog.fetch();
    } catch (const std::bad_cast& e) {
        std::cout << "Not a dog: " << e.what() << "\n";
    }
}
```

**Go equivalent:**

```go
func handleAnimal(a Animal) {
    if d, ok := a.(*Dog); ok {
        d.Fetch()  // safe: we verified it's a *Dog
    } else {
        fmt.Println("Not a dog")
    }
}

// Or with type switch:
func handleAnimalSwitch(a Animal) {
    switch v := a.(type) {
    case *Dog:
        v.Fetch()
    case *Cat:
        fmt.Println("It's a cat")
    }
}
```

`dynamic_cast` is C++'s equivalent of Go's type assertion. Both check the concrete type at runtime.

#### reinterpret_cast: The "Trust Me, I Know What I'm Doing" Cast

This cast reinterprets the bit pattern of one type as another. It performs no conversion, just tells the compiler to treat the bytes differently. This is extremely dangerous and has very few legitimate uses.

```cpp
// Viewing the bit representation of a float
float f = 3.14f;
// UB: *reinterpret_cast<uint32_t*>(&f) violates strict aliasing.
// A float object may not be read through a uint32_t lvalue, and
// optimizers will miscompile code that does. The correct tools:
uint32_t bits = std::bit_cast<uint32_t>(f);   // C++20, <bit>
// pre-C++20: std::memcpy(&bits, &f, sizeof(bits)) - compiles to the
// same single register move, with defined behavior.

// Casting between unrelated pointer types (char* access is the one
// aliasing exemption: any object's bytes may be inspected through char*)
int x = 42;
char* bytes = reinterpret_cast<char*>(&x);
// Now you can inspect the individual bytes of the integer
for (size_t i = 0; i < sizeof(int); i++) {
    std::cout << static_cast<int>(bytes[i]) << " ";
}

// Converting between pointer and integer
int* p = &x;
uintptr_t addr = reinterpret_cast<uintptr_t>(p);
std::cout << "Address: 0x" << std::hex << addr << "\n";
```

**Go equivalent:**

```go
package main

import (
    "math"
    "unsafe"
)

func main() {
    // Viewing float bits
    f := float32(3.14)
    bits := math.Float32bits(f)
    _ = bits

    // Unsafe pointer casting (also dangerous in Go)
    x := 42
    bytes := (*[4]byte)(unsafe.Pointer(&x))
    _ = bytes

    // Pointer to integer
    addr := uintptr(unsafe.Pointer(&x))
    _ = addr
}
```

In both languages, this kind of casting breaks the type system and should be used only when absolutely necessary (hardware interfaces, serialization, FFI).

#### const_cast: Adding or Removing const

This cast adds or removes `const` qualification. It exists primarily for interfacing with legacy C code that does not use `const` correctly.

```cpp
// Removing const (dangerous - only if original object is NOT const)
void legacyCFunction(char* s) {
    // old C function that doesn't take const char*
    // but promises not to modify s
}

void wrapper(const std::string& s) {
    // We know legacyCFunction doesn't modify the string
    legacyCFunction(const_cast<char*>(s.c_str()));
}

// DANGER: if the original object IS const, modifying it is UB!
const int x = 42;
int* p = const_cast<int*>(&x);
*p = 100;  // UNDEFINED BEHAVIOR! x was declared const
```

**Go has no equivalent** because Go does not have a `const` qualifier on variables in the same way. Go's closest concept is unexported fields, which prevent external modification through encapsulation rather than type system annotations.

### Cast Comparison Summary

| Cast | Purpose | Runtime Check | Safety | Go Equivalent |
|---|---|---|---|---|
| `static_cast` | Normal conversions | No | Medium | `T(expr)` |
| `dynamic_cast` | Polymorphic downcasts | Yes | High | Type assertion `x.(T)` |
| `reinterpret_cast` | Bit reinterpretation | No | Very Low | `unsafe.Pointer` |
| `const_cast` | Add/remove const | No | Low | No equivalent |

### Never Use C-Style Casts

C++ inherited the C-style cast `(Type)expr`, which is a catch-all that tries `static_cast`, `const_cast`, and `reinterpret_cast` in sequence. Never use it in C++ code because you cannot tell which kind of conversion is being performed.

```cpp
// BAD: C-style cast (which cast is this? hard to tell)
double d = 3.14;
int x = (int)d;           // static_cast

void* vp = &x;
int* ip = (int*)vp;       // reinterpret_cast

const int* cp = &x;
int* mp = (int*)cp;       // const_cast

// GOOD: explicit C++ casts (intent is clear)
int x2 = static_cast<int>(d);
int* ip2 = static_cast<int*>(vp);
int* mp2 = const_cast<int*>(cp);
```

---

### Junior → FAANG: The Four Casts as a Safety Ladder

Treat the four C++ casts as a safety ladder: `static_cast` is checked at compile time and is the safest explicit cast. `dynamic_cast` is checked at runtime and is safe but has overhead. `const_cast` removes const and is a code smell that deserves a comment. `reinterpret_cast` is essentially unchecked and requires a detailed justification in any code review.

The rule of thumb: if you reach for `reinterpret_cast`, stop and ask whether you can express the same intent with `static_cast`, a union, or `std::bit_cast` (C++20). If you reach for `const_cast`, stop and ask whether the API design forced you into a const-incorrectness corner that should be fixed at the API level instead.

Interview entry point: "why does C++ have four casts instead of one?" The answer: the four casts express different intent and carry different safety guarantees. The compiler uses the cast type to enforce constraints (`static_cast` checks related types, `const_cast` only removes const). Using the most restrictive cast that satisfies your need is self-documenting and enables better static analysis.

### Senior @ FAANG: Cast Policies, `std::bit_cast`, and Type Punning Safety

At the staff level, cast usage in a codebase is a safety and correctness indicator. A codebase with many `reinterpret_cast` calls is a codebase with many potential type aliasing violations and security risks.

**Type aliasing rules and `std::bit_cast`.** The strict aliasing rule means that accessing memory through an incompatible pointer type is UB. The classic violation: casting a `float*` to `int*` to inspect the bit representation. The safe alternative since C++20 is `std::bit_cast<int>(f)`, which expresses the same intent without aliasing violation. A staff engineer adds a clang-tidy check (`cppcoreguidelines-pro-type-reinterpret-cast`) to flag all `reinterpret_cast` uses and reviews each for aliasing safety.

**`const_cast` as an API design signal.** When code uses `const_cast` to remove const from an argument, it often signals a mutable global, a poorly designed API that did not propagate const correctly, or a C API that does not declare its inputs const. A staff engineer treats each `const_cast` as a design debt item: track it, understand why it exists, and add it to the backlog for API cleanup. Systematically eliminating `const_cast` improves the codebase's const correctness and makes it easier for the compiler to optimize.

**`dynamic_cast` performance in hot paths.** `dynamic_cast` requires RTTI (Run-Time Type Information) and is O(depth of inheritance hierarchy). In a hot path, even a single `dynamic_cast` per request can add microseconds at scale. The alternative: redesign the API to use the visitor pattern (`std::visit` on a variant, or a virtual `accept()` method), which achieves runtime dispatch without `dynamic_cast` overhead. A staff engineer's code review flags any `dynamic_cast` in code paths that are exercised more than 1000 times per second and proposes the redesign.

