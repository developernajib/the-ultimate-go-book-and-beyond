## C++ Interop Model

This is the chapter section that matters most. Every other Carbon design decision is constrained by the interop story, and if the interop story does not deliver, the project does not deliver.

### What "First-Class Interop" Means in Practice

The Carbon team's stated direction is that Carbon code should be able to:

1. **Import a C++ header** the same way it imports a Carbon package, and use the C++ types, functions, classes, and templates inside as if they were Carbon constructs.
2. **Be imported by C++**, with Carbon types appearing on the C++ side as ordinary C++ types, callable, inheritable in some cases, and storable in C++ containers.
3. **Cross the boundary without marshaling**, no glue code generation step, no hand-written shims for common cases, no FFI tax on call sites.
4. **Preserve template visibility** in both directions. A Carbon generic and a C++ template should be able to see each other's definitions for the cases the design supports.
5. **Match the platform ABI** so that a Carbon function and a C++ function with the same signature are passed the same way at the call site.

How much of this is shipping versus designed-but-not-implemented is the question to verify against the carbon-lang repo. The conceptual model has been stable in design documents for years, but the implementation lags.

### A Hypothetical Mixed-Source Picture

Imagine a C++ file:

```cpp
// circle.h
#pragma once
#include <vector>

namespace geom {
class Circle {
 public:
  explicit Circle(double radius);
  double area() const;
  double radius_;
};

std::vector<Circle> MakeCircles(int n);
}  // namespace geom
```

A Carbon file using it might look like (illustrative, not commit-locked):

```carbon
package Geometry;

import Cpp library "circle.h";

fn TotalArea(circles: Cpp.std.vector(Cpp.geom.Circle)) -> f64 {
  var sum: f64 = 0.0;
  for (c: Cpp.geom.Circle in circles) {
    sum = sum + c.area();
  }
  return sum;
}
```

The Carbon code imports the C++ header through the `Cpp` namespace alias and uses `std::vector<Circle>` directly. There is no binding generation, no `extern "C"` shim. The Carbon compiler reads the C++ header, the C++ compiler frontend (Clang) parses it, and the resulting type is exposed inside Carbon under the `Cpp.` prefix.

### Going the Other Direction

Carbon types should also be importable from C++. The detail of how this is exposed is part of what the project is still designing, but the intent is that a Carbon class compiles into something that the C++ side can include and use, with vtables, layout, and calling conventions matching what C++ expects.

This direction is harder than C++ to Carbon because Carbon classes have features (interfaces, constraint-based generics) that have no direct C++ equivalent. The interop boundary is therefore not symmetric: the full Carbon language is not exposable to C++, only the subset that maps cleanly to C++ constructs.

### ABI Considerations

ABI compatibility is what makes interop cheap or expensive. If Carbon and C++ disagree on how a `std::string` is laid out, or how a virtual call is dispatched, every call across the boundary needs adaptation. Carbon's plan is to match the platform C++ ABI exactly, which means using the same Itanium ABI on Linux, the MSVC ABI on Windows, and the platform conventions on macOS. The cost of this is that Carbon inherits C++'s ABI fragility (changing a class layout breaks ABI). The benefit is that interop is free.

This is a deliberate trade. Rust deliberately did not adopt the C++ ABI, which is part of why Rust to C++ interop is painful. Carbon explicitly does adopt it.

### Why This Matters for Google's Monorepo Migration Story

Google's monorepo has hundreds of millions of lines of C++. The migration story Carbon enables is roughly:

1. Pick a leaf module, a file with few dependents, written in C++.
2. Rewrite that file in Carbon. The Carbon code imports the same C++ headers the original C++ file imported, calls the same functions, returns the same types.
3. The callers of the migrated file (still C++) continue to compile and run, because the Carbon file exports a C++-compatible interface.
4. Repeat per file, with engineers picking up Carbon as they migrate the files they own.
5. Over years, the percentage of Carbon files in the codebase grows, and the percentage of C++ shrinks.

Compare this to a Rust migration, where step 2 hits a wall the moment the file uses templated C++ APIs that `cxx` cannot bridge cleanly. The migration either stops, or someone hand-writes shims for every template, or the file is rewritten to use a Rust-friendly subset of the C++ API.

The Carbon bet is that the file-by-file migration story is so much smoother that the cost of giving up day-one safety is worth it.

### Limits and Honest Caveats

A few things the interop model does not promise:

- **Macros**: C++ preprocessor macros do not survive cleanly. Carbon has no preprocessor and the design intent is that macro-heavy headers will need adapter code or migration.
- **Template metaprogramming**: Heavy SFINAE and concept tricks may not all map. The interop story handles common templated containers and functions, the long tail of template magic is harder.
- **Operator overloading semantics**: Carbon's operator model is simpler than C++'s and not every C++ overload set has a one-to-one mapping.
- **Exceptions**: Carbon does not use exceptions. C++ code that throws across the boundary is undefined territory in the design.

### Junior at FAANG

You should be able to draw a picture of a Carbon file calling into a C++ header and explain why this is the central design pillar. Bonus: explain why Rust interop with C++ is harder, in one sentence.

### Senior at FAANG

You should be able to identify which kinds of C++ codebases would migrate smoothly under Carbon's model and which would not. A codebase dominated by template metaprogramming and macro tricks is harder than a codebase dominated by ordinary classes and functions, and the migration plan should be triaged accordingly.

---
