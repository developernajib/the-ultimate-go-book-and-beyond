## Common Gotchas by Version

### Go 1.18

Go 1.18 introduced generics but with a notable restriction: unlike type parameters on structs and functions, methods on a generic type cannot introduce their own additional type parameters. The idiomatic workaround is to declare all the type parameters the method needs directly on the struct itself, which makes the full set of type constraints explicit at the point of instantiation. 
```go
// Gotcha: Generic method limitations
type Processor[T any] struct{}

// Not allowed: methods can't have type parameters
// func (p Processor[T]) Process[U any](v U) {} // Error

// Solution: Put type parameter on struct
type Processor[T, U any] struct{}
func (p Processor[T, U]) Process(t T, u U) {}
```

### Go 1.22

Go 1.22 fixed the long-standing loop-variable capture bug by giving each iteration its own copy of the loop variable, meaning closures and deferred functions now capture the value from their iteration rather than the final value after the loop ends. Code that deliberately relied on the old shared-variable behavior, a rare but real pattern, will produce different output after upgrading.

```go
// Gotcha: Loop variable behavior changes
// This changed behavior - ensure you want it
for i := 0; i < 5; i++ {
    defer func() {
        fmt.Println(i) // Go 1.22+: prints 4,3,2,1,0 (defers run last-in-first-out)
        // pre-1.22: printed 5,5,5,5,5 (all closures shared one variable)
    }()
}
```

### Go 1.23

Go 1.23 formalized range-over-function iterators, but the iterator contract requires the producer to respect the boolean return value of the `yield` callback. If `yield` returns `false`, signaling that the consumer has broken out of the loop early, the iterator function must stop calling `yield` and return immediately. Failing to do so is a panic-inducing contract violation.

```go
// Gotcha: Iterator early exit
func MyIter() func(func(int) bool) {
    return func(yield func(int) bool) {
        for i := 0; i < 10; i++ {
            if !yield(i) {
                // Must check return value and exit
                return
            }
        }
    }
}
```

### Go 1.24

Go 1.24 extended type aliases to support generic parameters, making it possible to write `type Alias[T any] = SomeGeneric[T]`. The gotcha arises when a plain (non-generic) alias already exists in the same package under the same name: introducing a generic alias with the same identifier is a redefinition error, so names must be chosen carefully when migrating existing aliases to the generic form.

```go
// Gotcha: Type alias shadowing
type MyInt = int

// Later in same package
type MyInt[T any] = T // Error: redefinition

// Solution: Use different names or different packages
```

---
