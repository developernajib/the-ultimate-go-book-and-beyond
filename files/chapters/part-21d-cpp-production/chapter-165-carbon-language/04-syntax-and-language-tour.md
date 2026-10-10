## Syntax and Language Tour

This section is illustrative. Carbon syntax is still evolving and the examples here match the project's published direction rather than any specific commit. Treat the code as design pseudocode that shows the shape of the language, not a copy-paste reference.

### Declarations

Carbon flips the C++ declaration order so the name comes before the type, the way modern languages from Rust to Swift to TypeScript do it.

```carbon
var count: i32 = 0;
let pi: f64 = 3.14159;
fn Add(a: i32, b: i32) -> i32 { return a + b; }
```

- `var` introduces a mutable binding.
- `let` introduces an immutable binding.
- `fn` introduces a function. The return type follows `->`.
- Types come after names, separated by `:`.

The reason for this order is parser predictability. C++'s "type name" order requires the parser to know whether an identifier is a type or a variable to disambiguate, which is the source of most-vexing-parse and a generation of subtle bugs. Carbon's order makes parsing context-free.

### Packages and Imports

Carbon uses packages as its module unit. There is no preprocessor, no header files, no include order pitfalls.

```carbon
package Geometry;

import Math;
import Cpp library "legacy/circle.h";
```

A file declares the package it belongs to with `package`. It imports other packages with `import`. C++ headers are imported through the `Cpp` namespace, which is the bridge into the legacy world.

### Types

Carbon distinguishes value types from reference types more carefully than C++ does. The basic numeric types are spelled with their bit width: `i8`, `i16`, `i32`, `i64`, `u8` through `u64`, `f32`, `f64`. There is no `int` whose width depends on the platform.

Composite types include tuples, arrays, and user-defined classes. References are explicit and pointer-like types are spelled distinctly from values.

### Classes

```carbon
class Point {
  var x: f64;
  var y: f64;

  fn Distance(self: Point, other: Point) -> f64 {
    let dx: f64 = self.x - other.x;
    let dy: f64 = self.y - other.y;
    return Math.Sqrt(dx * dx + dy * dy);
  }
}
```

A Carbon class declares fields with `var` and methods with `fn`. The receiver is explicit (`self: Point`) the way Rust and Python show it, rather than implicit the way C++ and Java do. This is mostly a readability choice, but it also makes the receiver's mutability explicit.

### Control Flow

`if`, `else`, `while`, and `for` are present and look approximately the way you would expect. Carbon's `match` is intended as a structured replacement for C++'s `switch`, with exhaustiveness checking on enums and pattern matching on structured data, in a direction similar to Rust's `match`.

### Generics, Briefly

Generics get their own section later, but in syntax:

```carbon
fn Max[T:! Comparable](a: T, b: T) -> T {
  if (a < b) { return b; }
  return a;
}
```

The `[T:! Comparable]` is a generic parameter list with a constraint. `T:! Comparable` reads as "T is some type satisfying Comparable". The `:!` distinguishes a generic type parameter from a regular value parameter.

### Side by Side: A Small Algorithm

The same algorithm, sum of squares of a vector, in C++ and in Carbon.

C++:

```cpp
#include <vector>

double SumOfSquares(const std::vector<double>& xs) {
  double total = 0.0;
  for (const auto& x : xs) {
    total += x * x;
  }
  return total;
}
```

Carbon (illustrative):

```carbon
package Stats;

import Cpp library "vector";

fn SumOfSquares(xs: Cpp.std.vector(f64)) -> f64 {
  var total: f64 = 0.0;
  for (x: f64 in xs) {
    total = total + x * x;
  }
  return total;
}
```

Things to notice:

- The Carbon version imports `std::vector` through the `Cpp` namespace because it is a C++ type, not a Carbon-native one.
- The function takes the vector by value in the syntax, but the actual ABI semantics depend on Carbon's interop layer. Carbon does not have C++'s reference syntax in the same form, passing semantics are expressed differently.
- Loops, arithmetic, and return are mechanical translations.

The point is not that Carbon is dramatically more concise. It is that the syntactic noise (the `&`, the `const`, the `auto`) is replaced with explicit and uniform forms, and the type system's edges are sharper.

### Visibility

Carbon's visibility model is built around packages, not classes. A name is either visible inside its package, or exported from the package's API. There is no `public`, `private`, `protected` per class in the C++ sense. The API surface of a package is what the package's API file exposes.

This is a significant departure from C++ and from Java-style OOP. It puts the boundary at the module rather than the class, which fits how large codebases actually organize code.

### What Is Not Shown

The above is the easy part of the language. Carbon's harder design areas are:

- The class layout and inheritance model in detail (next chapter section).
- The ownership and reference semantics, which are still being designed.
- Operator overloading and traits, which are still being firmed up.
- Concurrency primitives, which are largely undecided.

This tour gives you enough syntax to read an example. It does not give you enough to write production code, but production code in Carbon is not on the menu in 2026 anyway.

### Junior at FAANG

You should be able to read a 20-line Carbon snippet and describe what it does in plain English. Translating it to C++ in your head should be straightforward.

### Senior at FAANG

You should be able to identify which syntactic differences between Carbon and C++ are cosmetic (declaration order) and which are semantic (package-based visibility, explicit `self`, no preprocessor). The semantic differences are the ones that change how the language scales.

---
