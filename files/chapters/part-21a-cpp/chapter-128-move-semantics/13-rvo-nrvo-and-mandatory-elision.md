## RVO, NRVO, and Mandatory Elision

Copy elision is older than move semantics. It was permitted in C++98 and required for some forms in C++17. Knowing exactly when the compiler will elide, when it will move, and when it will copy decides whether your code returns a 64-byte struct or memcpys a 1 MiB matrix.

### The Three Categories

1. **RVO (Return Value Optimization).** The returned expression is an unnamed temporary. The compiler constructs it directly into the caller's storage.

2. **NRVO (Named Return Value Optimization).** The returned expression is a local variable with automatic storage. The compiler constructs that variable directly into the caller's storage.

3. **Mandatory elision (C++17).** The returned expression is a prvalue and the destination is a non-reference object of the same type. No copy or move constructor is required to exist.

Categories 1 and 2 are permitted but not required. Category 3 is required.

### Mandatory Elision Walkthrough

```cpp
struct NoCopy {
    NoCopy();
    NoCopy(const NoCopy&) = delete;
    NoCopy(NoCopy&&) = delete;
};

NoCopy make() { return NoCopy{}; } // C++17: ok, mandatory elision

NoCopy x = make();                 // C++17: ok, no move/copy needed
NoCopy y = NoCopy(NoCopy(NoCopy{})); // C++17: ok, single object, materialized once
```

In C++14 and earlier, all three lines would be ill-formed. The standard required the move/copy constructor to be accessible even when elision happened. C++17 changed prvalue semantics so that the prvalue is the recipe, and the recipe is applied at the destination.

The rule, restated: when a function returns a prvalue and the caller initializes an object from it, no temporary is materialized in the function. The prvalue flows through the return statement directly into the caller's variable.

### NRVO Conditions

NRVO requires:

1. The function returns a class type by value.
2. The returned expression is the name of a non-volatile automatic-storage local variable.
3. That variable has the same type (ignoring cv) as the function return type.
4. The variable is not a function parameter.
5. The variable is not part of a `goto` or branching pattern that would make its address ambiguous.

When NRVO applies, the compiler may construct the local variable directly in the caller's frame. The local variable is, in effect, an alias for the return slot.

```cpp
std::string make_string() {
    std::string s = "hello";
    s += " world";
    return s; // NRVO eligible
}

auto t = make_string(); // s is constructed in t's storage
```

### What Disables NRVO

#### Multiple return paths with different variables

```cpp
std::string maybe(bool b) {
    std::string a = "yes";
    std::string c = "no";
    if (b) return a;
    return c; // two named locals returned, NRVO disabled
}
```

The compiler cannot decide which variable should occupy the return slot. Both end up regular locals, and the active one is moved (in C++11+) or copied.

#### Returning a parameter

```cpp
std::string echo(std::string s) {
    return s; // NRVO disabled because s is a parameter
}
```

Parameters live in their own storage (caller-allocated typically). The function cannot reuse the return slot for a parameter. The standard mandates an implicit move here (C++11+), so `s` is moved into the return value, not copied.

#### Returning by slicing

```cpp
struct Base { virtual ~Base() = default; };
struct Derived : Base { int x; };

Base make() {
    Derived d;
    return d; // NRVO disabled: types differ. Slicing copy.
}
```

#### Returning a member or subobject

```cpp
struct Pair { std::string a, b; };
std::string take_a() {
    Pair p;
    return p.a; // NRVO disabled: returning subobject, not the whole local
}
```

The returned expression is `p.a`, not `p`. NRVO needs the whole local to occupy the return slot.

#### Conditional via ternary

```cpp
std::string pick(bool b) {
    std::string a = "yes";
    std::string c = "no";
    return b ? a : c; // NRVO disabled
}
```

The ternary produces an lvalue, but the chosen object is not statically known. The compiler must materialize a result.

#### volatile or cv-mismatch

```cpp
std::string make() {
    volatile std::string s; // volatile disqualifies NRVO
    return s;
}
```

### When Move Still Happens

Even when NRVO does not apply, C++11 introduced **implicit move on return**. If the returned expression is the name of an automatic local of class type, and the move would otherwise be a copy, the standard treats the expression as an rvalue for overload resolution. This was tightened in C++20 (P1825) so it applies even when the return type is a base class.

```cpp
std::unique_ptr<int> make() {
    std::unique_ptr<int> p(new int(7));
    return p; // implicit move; p is treated as rvalue
}
```

If you write `return std::move(p);`, you typically pessimize: NRVO is disabled because the returned expression is no longer the name of a local, it is `std::move(p)`. The compiler then performs an explicit move, and the caller still receives a moved-from value but without the elision benefit.

The rule of thumb is to never write `std::move` on a `return` of a local. Let the language do the right thing.

### Pre-C++17 vs C++17

In C++14:

```cpp
struct M {
    M();
    M(const M&) = delete;
    M(M&&) = default;
};

M make() { return M{}; }
M x = make(); // pre-C++17: legal, but move ctor must exist (it does)
```

If you `=delete` the move constructor too, the C++14 program is ill-formed. The C++17 program is fine because no move constructor is needed.

C++17 also fixed the "guaranteed elision through layers" issue:

```cpp
M layer() { return make(); } // C++17: M{} flows through two return statements with no move
```

Before C++17, two move constructions could be required at the layers. After C++17, the prvalue propagates without materialization.

### Compiler Behavior

GCC and Clang have implemented RVO/NRVO for two decades. MSVC was historically weaker on NRVO. Today all three implement mandatory C++17 elision and most NRVO opportunities. You can verify with:

```bash
g++ -fno-elide-constructors -O0 prog.cpp # disables NRVO and RVO where allowed
g++ -O2 prog.cpp # elision enabled
```

`-fno-elide-constructors` is a useful debugging tool to see how many copies/moves your code would do without elision.

On Godbolt, look for `call _ZN1MC1Ev` (constructor calls). NRVO collapses the chain to a single constructor at the destination.

### When You Want to Force a Move

Sometimes elision is impossible (parameter return, base-class return, conditional). Then implicit move triggers. Three patterns:

```cpp
// Pattern A: trust the language
std::vector<int> sorted(std::vector<int> v) {
    std::sort(v.begin(), v.end());
    return v; // implicit move, v is parameter so no NRVO
}

// Pattern B: explicit when type changes
std::unique_ptr<Base> make_derived() {
    auto d = std::make_unique<Derived>();
    return d; // implicit move applies even though types differ (C++20)
}

// Pattern C: when the expression is not a name
std::string flat(std::pair<std::string, int> p) {
    return std::move(p.first); // p.first is a subexpression; std::move needed
}
```

### Diagnosing Missed Elision

Add an instrumentation type:

```cpp
struct Trace {
    Trace()                    { puts("ctor"); }
    Trace(const Trace&)        { puts("copy"); }
    Trace(Trace&&) noexcept    { puts("move"); }
    ~Trace()                   { puts("dtor"); }
};
```

Drop it through your function. If you see "move" or "copy" output where you expected only "ctor" + "dtor", elision was not applied. This is the cheapest profiler in your toolbox.

### Junior at FAANG vs Senior at FAANG

Junior puts `std::move` on every return, hoping for performance. Senior knows that on a return of a local `T`, the language already does the right thing: elide if possible, otherwise implicit-move. The senior also knows that returning by base class, returning a subobject, or returning through a conditional disables NRVO and may need explicit `std::move` on the subexpression. Senior verifies with `-fno-elide-constructors` or instrumentation when the code path is hot.

### Practical Checklist

- Return by value. Take by value when you will store. Forward when you will pass through.
- Do not write `return std::move(local);` for a plain local of the return type.
- Be aware that `return cond ? a : b;` produces a copy or move, not NRVO.
- For factory functions returning move-only types, mandatory elision (C++17) means you do not need a move constructor accessible.
- For polymorphic returns, use `std::unique_ptr<Base>` and let implicit move handle the conversion.
