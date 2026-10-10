## Value Categories, Rigorously

Most engineers learn "lvalue is on the left, rvalue is on the right" and stop there. That mental model breaks the moment you touch C++17 guaranteed elision, decltype subtleties, or any template that returns a forwarded expression. This section rebuilds value categories from the standard text.

### The C++17 Taxonomy

C++17 (and unchanged in C++20/23) defines five categories arranged in a lattice.

```
              expression
              /        \
          glvalue     rvalue
          /     \     /    \
       lvalue   xvalue   prvalue
```

- **glvalue** (generalized lvalue): an expression whose evaluation determines the identity of an object or function.
- **prvalue** (pure rvalue): an expression whose evaluation initializes an object, or computes the value of an operand of an operator.
- **xvalue** (eXpiring value): a glvalue that denotes an object whose resources can be reused.
- **lvalue**: a glvalue that is not an xvalue.
- **rvalue**: a prvalue or an xvalue.

Two orthogonal questions partition expressions:

1. Does the expression have identity (an addressable object)? If yes, it is a glvalue.
2. Can the expression be moved from? If yes, it is an rvalue.

| has identity | movable | category |
|--------------|---------|----------|
| yes | no | lvalue |
| yes | yes | xvalue |
| no | yes | prvalue |
| no | no | (impossible) |

### Concrete Examples

```cpp
struct Widget { int x; };

Widget make();
Widget& alias();
Widget&& sink();

int main() {
    Widget w;             // w is an object
    w;                    // lvalue: has identity, not movable from
    make();               // prvalue: result of function returning by value
    alias();              // lvalue: function returns lvalue reference
    sink();               // xvalue: function returns rvalue reference
    std::move(w);         // xvalue: cast to rvalue reference
    static_cast<Widget&&>(w); // xvalue: same as std::move
    Widget{};             // prvalue: temporary materialization candidate
    w.x;                  // lvalue: member access on lvalue
    make().x;             // xvalue: member access on prvalue (post-C++17)
}
```

The last line is a C++17 change. Before C++17, `make().x` was a prvalue. After C++17, it is an xvalue because `make()` undergoes temporary materialization before the member access binds.

### Materialization Conversion

C++17 separated "prvalue" from "temporary object". A prvalue is now a recipe for initializing an object, not the object itself. The transformation that turns a prvalue into a temporary object is called **temporary materialization conversion**.

It happens when:

- A prvalue binds to a reference.
- A prvalue is the operand of `.` (member access).
- A prvalue is the operand of `[]` on an array.
- A prvalue is the operand of unary `&`.
- An exception object is created from a throw.
- A discarded-value expression is a prvalue of class type.

```cpp
Widget make();
const Widget& r = make(); // make() is prvalue, materializes, r binds
Widget* p = &Widget{};    // ill-formed pre-C++17, ill-formed post-C++17 (temporary expires)
                          // but Widget{} now materializes before the &
```

The practical consequence is mandatory copy elision. Code like `Widget w = make();` no longer requires the move constructor to exist. The prvalue `make()` initializes `w` directly with no materialization in between.

### decltype Quirks

`decltype` has two rules. They surprise people every release.

```cpp
int x = 0;
int& r = x;

decltype(x)   a;   // int       (rule 1: name -> declared type)
decltype((x)) b = x; // int&    (rule 2: expression -> reference based on category)
decltype(r)   c = x; // int&    (rule 1: r is declared int&)
decltype((r)) d = x; // int&    (rule 2: (r) is lvalue of type int)

decltype(std::move(x)) e = 0; // int&&  (xvalue gives T&&)
decltype(42)           f = 0; // int    (prvalue gives T)
```

Rule 1: if the operand is an unparenthesized id-expression or class member access, `decltype` yields the declared type.

Rule 2: otherwise, `decltype` yields:
- `T` if the expression is a prvalue of type `T`.
- `T&` if the expression is an lvalue of type `T`.
- `T&&` if the expression is an xvalue of type `T`.

This is why `decltype(auto)` is dangerous in return statements. `return x;` deduces `int`, but `return (x);` deduces `int&` and may dangle.

### Historical Evolution

C++03 had only lvalues and rvalues. The split was crude:

- An rvalue was anything not assignable to.
- A const lvalue reference could bind to an rvalue, extending its lifetime.

C++11 introduced rvalue references and the three-way split (lvalue, xvalue, prvalue) with the umbrella categories glvalue and rvalue. The split was needed because:

- Move semantics required identifying expirable objects (xvalues).
- Function calls returning `T&&` had to be distinguished from temporaries.

C++17 redefined prvalues as initialization recipes. The motivation was guaranteed copy elision and fixing the `T x = T(T(T()));` chain that previously required `T` to be copyable or movable.

C++20 added concepts that constrain on value categories indirectly via reference qualifiers and `std::same_as<std::remove_cvref_t<T>, X>` patterns.

### The "Generalized" in glvalue

The term glvalue exists because xvalues and lvalues share a property: identity. Identity matters for:

- Polymorphic dispatch. You cannot virtually dispatch on a prvalue without materialization.
- Address-of. You cannot take the address of a prvalue.
- Reference binding. Both lvalue and rvalue references bind to identified objects, just with different mutability of the source.

When you write a function template taking `T&&`, the deduced reference type tells you whether the argument was a glvalue (`T = U&`) or a prvalue/xvalue (`T = U`). This is the foundation of perfect forwarding.

### Practical Consequences

Knowing the categories changes how you write APIs:

```cpp
class Buffer {
public:
    void append(const std::string& s) &;     // lvalue object, copy s
    void append(std::string&& s) &;          // lvalue object, move s
    std::string release() &&;                // only callable on rvalue Buffer
};

Buffer make_buffer();
auto s = make_buffer().release(); // ok: make_buffer() is prvalue, materializes to xvalue Buffer
Buffer b;
auto s2 = b.release();            // ill-formed: b is lvalue
auto s3 = std::move(b).release(); // ok: std::move(b) is xvalue
```

Ref-qualifiers (`&` and `&&`) on member functions let you express "this method consumes the object". This is how `std::optional::value() &&` and `std::expected::value() &&` are designed.

### Junior at FAANG vs Senior at FAANG

A junior engineer treats `std::move(x)` as "make this fast". A senior engineer reads `std::move(x)` and immediately thinks: "this is `static_cast<T&&>(x)`, it produces an xvalue, the receiving function selects an overload based on that category, and if no rvalue overload exists this is silently a copy". The senior also knows that `return std::move(x);` from a function returning `T` typically prevents NRVO and is a pessimization. The mental model is value categories, not "fast vs slow".

### Quick Drill

What is the value category of each expression? Assume `int x; int& r = x; int* p = &x; struct S { int m; } s; S g();`.

1. `x` -> lvalue
2. `x + 1` -> prvalue
3. `++x` -> lvalue (returns reference)
4. `x++` -> prvalue (returns value)
5. `*p` -> lvalue
6. `&x` -> prvalue
7. `s.m` -> lvalue (member of lvalue)
8. `g().m` -> xvalue (member of prvalue, materializes)
9. `std::move(x)` -> xvalue
10. `static_cast<int>(x)` -> prvalue
11. `(true ? x : x)` -> lvalue
12. `(true ? x : 0)` -> prvalue (different types, common conversion)

If you got 10 or more right without thinking, you have internalized the model.
