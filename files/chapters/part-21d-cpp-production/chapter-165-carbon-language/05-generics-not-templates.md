## Generics, Not Templates

The single largest design decision Carbon has made about the type system is to use constraint-based generics rather than C++-style templates. Understanding why requires understanding what is wrong with templates.

### What Is Wrong with C++ Templates

C++ templates are checked at instantiation, not at definition. When you write:

```cpp
template <typename T>
T Max(T a, T b) {
  return a < b ? a : b;
}
```

The compiler does not verify, at the point this code is written, that `T` supports `<`. It accepts the definition. Then a caller writes `Max(my_widget, my_widget)` and the compiler instantiates the template with `Widget`. If `Widget` has no `<` operator, the error is reported deep inside the instantiation, often as a multi-page diagnostic referencing types and locations the caller has never seen. This is the famous "template error wall" that has tortured C++ engineers for thirty years.

C++20 concepts attempt to fix this by letting you constrain the template:

```cpp
template <typename T>
  requires std::totally_ordered<T>
T Max(T a, T b) { return a < b ? a : b; }
```

This is better. The constraint is checked at instantiation against the concept, and the error message references the concept failure rather than the operator failure. But concepts are still checked at instantiation, not at definition. The compiler does not verify that `Max`'s body only uses operations that `totally_ordered` permits. If you accidentally call `a.SomeMethod()` inside `Max`, the compiler accepts the template, and the error only surfaces when someone instantiates it with a `T` whose `SomeMethod` does not exist.

### Carbon's Approach

Carbon generics are checked at the definition site. When you write:

```carbon
fn Max[T:! Comparable](a: T, b: T) -> T {
  if (a < b) { return b; }
  return a;
}
```

The compiler verifies, at the point `Max` is defined, that the body uses only operations that `Comparable` permits. If you accidentally call `a.SomeMethod()`, the error is reported on `Max`'s definition line, before any caller exists. This makes generics behave like ordinary code: the contract is the constraint, the implementation is checked against the contract, callers do not see implementation details.

This is the same direction Rust traits, Swift protocols, and Haskell type classes took. C++ took the other direction in the 1990s for good historical reasons (zero-cost abstractions, structural typing) but the cost has been thirty years of compiler errors.

### Comparison Table

| Feature | C++ Templates | C++20 Concepts | Carbon Generics | Rust Traits |
|---|---|---|---|---|
| Checked at definition | No | No | Yes | Yes |
| Constraints required | No | Optional | Yes | Yes |
| Structural or nominal | Structural | Mostly structural | Nominal | Nominal |
| Specialization | Yes | Yes | Limited | Limited (specialization unstable) |
| Compile time | Slow | Slow | Designed faster | Faster than C++ |
| Error quality | Poor | Better | Designed good | Good |

"Nominal" means the type must explicitly declare it satisfies the constraint. "Structural" means the type satisfies the constraint by accident if it has the right operations. Nominal is more disciplined, structural is more flexible. C++ went structural, Carbon goes nominal. This is a real tradeoff: nominal generics require the type author to opt in, which is more work but produces cleaner contracts.

### Interfaces in Carbon

Constraints in Carbon are expressed through interfaces, which are similar to Rust traits. An interface declares a set of operations a type must support:

```carbon
interface Comparable {
  fn Less[self: Self](other: Self) -> bool;
}

impl i32 as Comparable {
  fn Less[self: i32](other: i32) -> bool {
    return self < other;
  }
}
```

A type "implements" an interface through an `impl` block. Carbon then knows that `i32` satisfies `Comparable`, and any generic constrained on `Comparable` can accept `i32`. The constraint is checked once, at the `impl` site, the generic is checked once, at its definition site, callers are checked at their call sites against the constraint.

### Specialization

Templates allow specialization: a generic algorithm can have a special case for a particular type. Carbon's design is more conservative here, in the same direction Rust took, where general specialization is hard to make sound and is a long-standing open problem.

Carbon allows some forms of specialization but the full design is still being worked out. The intent is to support the common cases (for example, a sort that uses a faster algorithm on contiguous arrays) without the full power of C++ partial specialization, which is a major source of compiler complexity and template metaprogramming hacks.

### What This Costs

The cost of constraint-based generics is real:

- **Less flexibility for ad-hoc use**: A C++ template can be called with anything that happens to have the right operations. A Carbon generic requires the type author to declare conformance.
- **More boilerplate**: `impl T as Interface { ... }` blocks are extra code.
- **Harder migration from template-heavy code**: A C++ codebase that uses templates structurally has work to do mapping those templates to Carbon interfaces.

These costs are why C++ went the other way originally. Carbon's bet is that the daily cost of poor template error messages and slow compile times is higher than the migration cost of writing explicit conformance.

### Junior at FAANG

You should be able to explain in three sentences what "checked at definition site" means and why it produces better error messages. Bonus: name two other languages that use constraint-based generics.

### Senior at FAANG

You should be able to argue when structural typing is the right call (rapid prototyping, library code that wants to accept duck-typed inputs) and when nominal typing is the right call (large codebases where explicit contracts are worth the boilerplate). A staff engineer should be able to articulate the trade and pick the right side for a given codebase.

---
