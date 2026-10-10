## Summary

Move semantics fundamentally changed how C++ programs are written and how they perform. Here are the key takeaways:

1. **Value categories** form a taxonomy: lvalues have identity, prvalues are temporaries, xvalues are explicitly expiring values. Understanding this taxonomy is prerequisite to understanding what can be moved and when.

2. **Move constructors and move assignment operators** transfer ownership of resources (heap memory, file handles, sockets) from one object to another in constant time, leaving the source in a valid but unspecified state. Always mark them `noexcept`.

3. **`std::move`** is just a cast to rvalue reference. It enables move operations by changing the value category but does not move anything by itself.

4. **`std::forward`** is a conditional cast that preserves value categories. Combined with forwarding references (`T&&` in templates) and reference collapsing rules, it enables perfect forwarding, passing arguments through wrapper functions without losing their lvalue/rvalue nature.

5. **Copy elision (RVO/NRVO)** is even better than moving: the compiler constructs the object directly at its destination. RVO is mandatory since C++17. NRVO is optional but nearly universal. Never use `std::move` on a return statement for local variables, it disables NRVO.

6. **Reference collapsing** (`& &&` becomes `&`, `&& &&` becomes `&&`) is the mechanism that makes forwarding references work. It determines whether a template parameter binds as an lvalue or rvalue reference.

7. **Performance impact** is dramatic for types with heap resources: moves for strings, vectors, and complex objects are 100-1000x faster than copies. For small stack-only types, there is no benefit.

8. **Go's alternative** is simpler: no value categories, no move constructors, no forwarding references. Go uses pointers for efficiency, reference-type semantics for built-in collections, and garbage collection for lifetime management. This is simpler but provides less control and lower performance ceilings.

Move semantics are not an advanced feature you can ignore. Every `push_back`, every function return, every container reallocation in modern C++ is affected by whether your types support efficient moves. Master this topic, and the rest of modern C++ becomes dramatically easier to reason about.

### Junior → FAANG: The Three Rules to Carry Forward

From this entire chapter, carry three rules into every C++ PR: (1) mark move constructors `noexcept`, (2) do not use `return std::move(local)`, (3) do not use a variable after `std::move`. These three rules prevent the most common move-semantics bugs. Everything else in this chapter is context that makes these rules make sense.

### Senior @ FAANG: Move Semantics as a Performance Contract in API Design

At the staff level, move semantics is a contract in your API design. When you design a type, the move constructor's `noexcept` guarantee is a contract with `std::vector` and every other container that might hold your type. When you design a function that takes ownership, the `T&&` parameter is a contract with the caller about who owns the resource after the call. These contracts should be documented, enforced by tooling where possible, and reviewed for correctness in every PR that touches ownership-sensitive types. A staff engineer owns the culture of treating move semantics as first-class API design, not as an implementation detail.

---

| [◀ Chapter 127: Object-Oriented C++](../chapter-127-oop-cpp/00-introduction.md) | [Chapter 128: Move Semantics](00-introduction.md) | [Chapter 129: Templates and Generics](../chapter-129-templates-generics/00-introduction.md) ▶ |


