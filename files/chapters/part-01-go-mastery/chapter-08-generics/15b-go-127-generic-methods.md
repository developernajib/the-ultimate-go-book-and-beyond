## Go 1.27: Generic Methods

Go 1.27 (shipped August 2026, baseline Go 1.27.1) lifts the oldest restriction in Go's generics design: methods can now declare their own type parameters, independent of the receiver's. This section covers what changed, why it took nine releases after generics first shipped in 1.18, what still does not work, and the discipline for using the feature well. See the final release notes at https://go.dev/doc/go1.27.

### Before Go 1.27

The original 1.18 design deliberately excluded method type parameters. Any operation whose result type differed from the receiver's type parameters had to live outside the type:

```go
type Result[T any] struct {
    value T
    err   error
}

// Pre-1.27: Map cannot be a method, because U belongs to the
// operation, not to the type. Every library grew helper functions.
func MapResult[T, U any](r Result[T], fn func(T) U) Result[U] {
    if r.err != nil {
        return Result[U]{err: r.err}
    }
    return Result[U]{value: fn(r.value)}
}

sum := MapResult(parse(input), func(n int) string { ... })  // reads inside-out
```

The practical cost was ergonomic: transformation pipelines read inside-out as nested function calls, and fluent APIs (builders, query DSLs, result chains) could not express type-changing steps at all.

### After Go 1.27

```go
// Go 1.27+: the method declares its own type parameter U
func (r Result[T]) Map[U any](fn func(T) U) Result[U] {
    if r.err != nil {
        return Result[U]{err: r.err}
    }
    return Result[U]{value: fn(r.value)}
}

// Pipelines now read left to right, in execution order
out := parse(input).
    Map(func(n int) string { return strconv.Itoa(n) }).
    Map(func(s string) []byte { return []byte(s) })
```

Instantiation works exactly like generic functions: the compiler infers `U` from the arguments at each call site, and GC-shape stenciling generates code per shape, not per type. There is no runtime dispatch mechanism behind a generic method, which is precisely why the second restriction still stands.

### What Still Does Not Work

**Interface methods cannot declare type parameters.** An interface is compiled to a fixed dispatch table (the itab from Chapter 6). A method with its own type parameters would need one table entry per instantiation, and the set of instantiations is unbounded at the point the interface value is created. So method-level type parameters remain illegal, and type parameters must be placed on the interface declaration instead:

```go
// Illegal in Go 1.27 and beyond:
// type Mapper interface {
//     Map[U any](fn func(int) U) any  // compile error: methods cannot have type parameters
// }

// Correct: declare type parameters on the interface itself
type Mapper[U any] interface {
    Map(fn func(int) U) any
}
```

The consequence worth internalizing: **generic methods never participate in interface satisfaction.** They are a concrete-type convenience. The moment a design needs to dispatch the operation polymorphically through an interface, you are back to package-level generic functions or non-generic interface methods. This is the follow-up question interviewers will reach for first.

### The Discipline

Three rules for code review, in the spirit of "use them where they clearly help":

1. **A generic method must earn its type parameter.** If the method never uses `U` beyond passing it through, or an interface parameter expresses the same contract, the simpler form wins. The 1.18-era restraint rules did not expire in 1.27.
2. **Prefer methods for operations that belong to the type's core API, functions for everything else.** `Result.Map` belongs on `Result`. A one-off conversion used by a single caller does not, and as a package-level function it stays composable and testable in isolation.
3. **Do not redesign shipped APIs just because methods are now possible.** A public library that exposes `MapResult`-style functions has callers. Adding method equivalents is additive and safe. Removing the functions is a breaking change that buys syntax, not capability.

### Generalized Type Inference

The companion 1.27 change: generic functions can now be assigned to variables and passed as arguments of matching function types without explicit instantiation, in all contexts:

```go
func ParseInt[T ~string](s T) (int, error) { ... }

// Pre-1.27: explicit instantiation required
process(inputs, ParseInt[string])

// 1.27: inferred from process's parameter type
process(inputs, ParseInt)
```

Combined with generic methods, this closes most of the day-to-day friction that made Go generics feel half-finished to engineers arriving from languages with more mature parametric polymorphism. The type system is still deliberately small: no variance, no higher-kinded types, and interfaces stay method-set contracts.

### Interview Signal

The 2026-current answer to "what can't Go generics do?" changes with this release. Stale answers ("methods can't have type parameters", full stop) now read as outdated knowledge. The current framing: methods gained type parameters in 1.27 for concrete types, interfaces still cannot carry them because the dispatch table would be unbounded, and higher-kinded abstractions remain deliberately out of scope. Candidates who can explain the itab reasoning behind the interface restriction, rather than just reciting it, clear the senior bar.

---
