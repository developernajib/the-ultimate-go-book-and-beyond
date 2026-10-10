## Classes and Inheritance

Carbon's class model is one of the more conservative parts of the design. It looks like a cleaned-up C++ class with the awkward parts removed. The interesting design decisions are about what is and is not retained from C++.

### The Basic Class

```carbon
class Point {
  var x: f64;
  var y: f64;

  fn Make(x: f64, y: f64) -> Point {
    return {.x = x, .y = y};
  }

  fn Distance[self: Point](other: Point) -> f64 {
    let dx: f64 = self.x - other.x;
    let dy: f64 = self.y - other.y;
    return Math.Sqrt(dx * dx + dy * dy);
  }
}
```

A class has fields (`var`) and methods (`fn`). The receiver is explicit (`self: Point`). Construction uses a designated initializer-style record literal `{.x = ..., .y = ...}`. There are no constructors in the C++ sense, no member initializer lists, no rules about default versus user-defined defaults. There is one canonical way to construct a value of the type.

This is a simplification of one of C++'s most complex areas. The C++ rules around default constructors, deleted constructors, copy elision, mandatory copy elision, the Rule of Zero, the Rule of Three, the Rule of Five, are all replaced with a single record initialization model. Engineers stop reasoning about which constructor was selected by overload resolution.

### Single Inheritance and Interfaces

Carbon's design separates inheritance into two distinct mechanisms:

1. **Single base class inheritance** for the rare cases where you genuinely want a class hierarchy with virtual dispatch in the C++ style.
2. **Interfaces** for everything else, similar to Rust traits, Java interfaces, or Swift protocols.

```carbon
base class Shape {
  virtual fn Area[self: Shape]() -> f64;
}

class Circle extends Shape {
  var radius: f64;

  override fn Area[self: Circle]() -> f64 {
    return 3.14159 * self.radius * self.radius;
  }
}
```

`base class` declares a class that is intended to be extended. `extends` declares the inheritance. `virtual` and `override` are explicit, the same way C++11 made them, but here they are required rather than optional. There is no risk of accidentally overriding a non-virtual base method.

### Why Single Inheritance, Not Multiple

C++ allows multiple inheritance, including multiple inheritance of classes with state. This is the source of the diamond problem, of virtual base classes, of vtable layout headaches, and of long-running debates inside every C++ codebase about whether multiple inheritance should be allowed by style guide.

Carbon's design takes the position that multiple inheritance of state is more trouble than it is worth. Carbon supports multiple interface implementation (the Rust trait model), which is enough for almost every use case multiple inheritance is reached for, without the layout and ambiguity headaches.

### Interfaces

An interface declares operations a type can implement:

```carbon
interface Drawable {
  fn Draw[self: Self](canvas: Canvas);
}

impl Circle as Drawable {
  fn Draw[self: Circle](canvas: Canvas) {
    canvas.DrawCircle(self.x, self.y, self.radius);
  }
}
```

A class implements an interface through an `impl` block. The class can implement many interfaces. There is no diamond problem because interfaces have no fields. This is the same pattern Rust uses.

### Virtual Dispatch and Layout

When you have a base class with virtual methods, Carbon generates a vtable similar to C++'s, with a known layout that matches the platform ABI. This is what makes it possible for a C++ caller to dispatch through a Carbon class's virtual methods, and vice versa.

The layout discipline is part of what makes interop work. Carbon classes are not free to invent their own object layout. They must produce something C++ can understand at the boundary.

### What Carbon Drops from the C++ Object Model

The list of features Carbon does not carry over is long:

- **Multiple inheritance of state**: dropped.
- **Virtual inheritance**: dropped.
- **Implicit conversion constructors**: dropped. Conversions are explicit.
- **`explicit` keyword**: not needed because all conversions are explicit by default.
- **Copy elision rules**: simplified by the value semantics of the language.
- **Inheritance from C++ classes by Carbon classes**: limited. Carbon-to-Carbon inheritance is supported. Inheriting a Carbon class from a C++ class is part of the interop story but with restrictions.
- **C++-style RAII destructors with separate copy/move/destroy methods**: replaced by a more uniform value lifetime model that is still being designed.

This is a long list of drops, and each one is a thing some C++ engineer will miss. The bet is that the simplifications produce a cleaner type system that is easier to reason about and easier to compile efficiently.

### Honest Status

The class and inheritance design is one of the more stable areas of the Carbon design documents, but the implementation is still partial. Multiple interface implementation, generic constraints across the class boundary, and the full interop semantics with C++ inheritance are areas where the spec is firmer than the toolchain.

### Junior at FAANG

You should be able to write a small Carbon class with a method, declare an interface, and implement the interface for the class. Recognize that C++ multiple inheritance is intentionally absent and that this is a feature, not an oversight.

### Senior at FAANG

You should be able to identify which C++ class hierarchies in your codebase would translate cleanly to Carbon's single-inheritance plus interfaces model and which would not. Codebases that rely heavily on multiple inheritance of state (some older Google codebases, some game engines) will have a harder migration. A staff engineer should be able to flag this as a migration cost item rather than discovering it during the migration itself.

---
