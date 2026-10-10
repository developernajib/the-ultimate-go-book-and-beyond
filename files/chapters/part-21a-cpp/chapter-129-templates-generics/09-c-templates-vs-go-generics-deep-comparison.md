## C++ Templates vs Go Generics: Deep Comparison

This section is the most important for engineers who work in both languages. The design philosophies are fundamentally different.

### Monomorphization vs Dictionary Passing

**C++ uses monomorphization.** When you write `Max<int>` and `Max<double>`, the compiler generates two completely separate functions. Each one is optimized for its specific type. The binary size grows, but execution speed is optimal.

```cpp
// What the compiler generates (conceptually):
int Max_int(int a, int b) { return (a > b) ? a : b; }
double Max_double(double a, double b) { return (a > b) ? a : b; }
```

**Go uses a hybrid approach: GC-shape stenciling with dictionaries.** The compiler (through Go 1.27) generates one instantiation per *GC shape*, all pointer types share a single compiled body, while distinct shapes like `int` and `float64` get their own. Within a shape, a dictionary passed at call time resolves type-specific operations (methods, size, alignment). The result sits between C++'s full monomorphization and a purely boxed implementation: less binary bloat than C++, but generic method calls through a dictionary do not inline the way a stenciled instantiation can.

```go
// Conceptually, Go generates something like:
func Max_generic(dict *typeDict, a, b unsafe.Pointer) unsafe.Pointer {
    if dict.greater(a, b) {
        return a
    }
    return b
}
```

### Comparison Table

| Aspect | C++ Templates | Go Generics |
|---|---|---|
| **Introduced** | 1991 (standardized 1998) | 2022 (Go 1.18) |
| **Implementation** | Monomorphization (code generation per type) | Hybrid (dictionary passing + selective monomorphization) |
| **Compile time cost** | High (each instantiation is compiled separately) | Lower (single function body, dictionary generated) |
| **Binary size** | Larger (N instantiations = N copies of code) | Smaller (shared function body) |
| **Runtime performance** | Optimal (fully specialized, inlinable) | Good, but indirect calls through dictionaries are not inlinable |
| **Type checking** | Structural (duck typing pre-C++20, concepts in C++20) | Nominal (interface-based type sets) |
| **Non-type parameters** | Yes (`template <int N>`) | No |
| **Specialization** | Full and partial | No |
| **Variadic** | Yes (parameter packs) | No |
| **Turing complete** | Yes (template metaprogramming) | No |
| **Error messages** | Historically terrible, improved in C++20 | Clear and concise |
| **Header dependency** | Templates must be in headers (usually) | Normal package compilation |
| **Constraint mechanism** | Concepts (C++20), SFINAE, enable_if | Interface type sets |

### Code Duplication Illustration

The binary-size impact of monomorphization becomes concrete when you consider a template function instantiated across many types in a large codebase. Each distinct type argument produces an independent copy of the function body in the object file, and the linker cannot merge them even when the machine code is structurally identical. Go's shared-body approach means both `Identity[int]` and `Identity[string]` may map to the same machine code path, with type-specific behavior resolved through the runtime dictionary.

```cpp
// C++: the compiler generates separate code for each type
template <typename T>
T Identity(T x) { return x; }

// Using Identity<int> and Identity<std::string> creates two functions
// in the binary. For complex templates, this bloat is significant.
auto a = Identity(42);
auto b = Identity(std::string("hello"));
```

```go
package main

import "fmt"

// Go: one function handles all types through dictionary indirection
func Identity[T any](x T) T { return x }

func main() {
	// Using Identity[int] and Identity[string] may share the same machine code
	a := Identity(42)
	b := Identity("hello")
	fmt.Println(a, b)
}
```

### When C++ Templates Win

1. **Performance-critical inner loops.** Monomorphized code is fully inlinable and optimizable. The compiler can vectorize, unroll, and apply type-specific optimizations.
2. **Compile-time computation.** Template metaprogramming can compute values, generate lookup tables, and validate invariants at compile time. Go has no equivalent.
3. **Zero-cost abstractions.** CRTP, expression templates, and policy-based design add no runtime overhead. The generated code is identical to hand-written type-specific code.
4. **Library design.** The STL demonstrates how templates enable extremely reusable, high-performance container and algorithm libraries.
5. **Embedded systems.** When every byte and cycle counts, monomorphization eliminates all abstraction penalties.

### When Go Generics Win

1. **Compilation speed.** Go compiles orders of magnitude faster than heavily templated C++. A large C++ project with heavy template use can take hours to compile. The equivalent Go code compiles in seconds.
2. **Simplicity.** The constraint system is easy to understand and hard to misuse. There is no SFINAE, no partial specialization, no template metaprogramming to learn.
3. **Error messages.** Clear, concise, and immediately actionable. C++ template errors have improved with concepts, but can still span hundreds of lines for nested template failures.
4. **Binary size.** Shared implementations keep binaries small. This matters for microservices, containers, and deployment.
5. **Team productivity.** New engineers can understand generic Go code quickly. C++ templates require significant expertise to write and debug.
6. **Separate compilation.** Go generics work with the standard compilation model. C++ templates force most code into headers, increasing coupling and rebuild times.

### A Real-World Tradeoff Example

Consider implementing a generic sort. In C++, `std::sort` is a template that generates specialized code for each element type and comparator. The compiler can inline the comparator, eliminate function call overhead, and vectorize the sorting loop. This makes `std::sort` extremely fast.

In Go, `slices.SortFunc` uses generics but the comparator may be called through a dictionary indirection. The Go compiler cannot always inline through this indirection. For large datasets, the C++ version can be 2-5x faster. But the Go version compiles in milliseconds, produces a small binary, and is easy to debug. For most applications, the Go performance is more than adequate.

---

### Junior → FAANG: The Key Difference to Articulate in Interviews

The single most important difference between C++ templates and Go generics is the compilation strategy: C++ uses monomorphization (a separate copy of the code per type, enabling inlining and optimization), while Go uses a hybrid (monomorphization for GC shapes, dictionary dispatch for others). The practical result: C++ templates can be 2 to 5 times faster for computation-heavy generic code, but compile slower and produce larger binaries.

The interview answer: "C++ templates are a compile-time code generation system that enables full inlining and optimization. Go generics are a type-safe abstraction that balances performance with compile speed and binary size. The right choice depends on whether the bottleneck is CPU computation (C++) or developer productivity and operational simplicity (Go)."

### Senior @ FAANG: Generics Design Trade-offs as a Language Evaluation Framework

At the staff level, the C++ vs. Go generics comparison is part of the broader language evaluation framework used when choosing a language for a new system.

**When Go's generics are good enough.** For most FAANG backend services (RPC handlers, data pipeline stages, business logic), Go's generic performance is more than sufficient. The dictionary dispatch overhead is measurable only in tight inner loops. For services where each request involves network I/O, the generics overhead is lost in measurement noise. A staff engineer must not let the theoretical performance difference drive a language choice when the actual bottleneck is not in generic code.

**When C++ templates are necessary.** For systems where the hot path is a tight loop over millions of elements with no I/O (vectorized computation, sorting, serialization), C++ template monomorphization with inlining is the difference between meeting and missing the latency SLO. The decision criterion: profile the Go version of the hot path. If it meets the SLO with headroom, stay in Go. If it does not, C++ templates are the tool.

**Contributing to language evolution.** At the L7/principal level, engineers at FAANG companies participate in language design discussions (Go proposals, C++ WG21 papers) to ensure their company's production constraints are represented. The C++ templates vs. Go generics design space is actively evolving, and a principal engineer who understands the production trade-offs is positioned to contribute meaningfully to that evolution.

