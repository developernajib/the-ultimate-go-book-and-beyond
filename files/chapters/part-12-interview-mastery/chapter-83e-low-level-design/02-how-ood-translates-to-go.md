## 83E.2 How OOD Translates to Go

| OOP Concept | Go Equivalent |
|---|---|
| Class | Struct + methods |
| Abstract class | Interface |
| Inheritance | Embedding (composition) |
| Polymorphism | Interface satisfaction |
| Encapsulation | Unexported fields (lowercase) |
| Constructor | `NewXxx()` factory function |
| Method overriding | Interface + different implementations |
| Enum | `const` + `iota` |

### Key Go Idioms for LLD

Go's approach to OOD diverges from classical OOP in one critical way: behavior is defined by the caller, not the implementor. A struct satisfies an interface implicitly, no `implements` declaration required, which means you can retrofit an existing type into a new abstraction without touching the original package. The patterns below show how to express the three most common LLD building blocks in idiomatic Go: `iota`-based enums give you type-safe constants without an enum keyword, interfaces define the contract every concrete type must honor, and factory functions (`NewXxx`) encapsulate construction logic while returning the interface type so callers depend on the abstraction rather than the concrete struct.

```go
// "Enum" using const + iota
type VehicleType int

const (
    Motorcycle VehicleType = iota
    Car
    Truck
)

// Interface = abstract behavior
type Vehicle interface {
    Type() VehicleType
    LicensePlate() string
}

// Struct = concrete implementation
type car struct {
    plate string
}

func (c *car) Type() VehicleType     { return Car }
func (c *car) LicensePlate() string  { return c.plate }

// Factory function = constructor
func NewCar(plate string) Vehicle {
    return &car{plate: plate}
}
```


### Junior → FAANG: Translating OOP Patterns to Go

Go's type system is structural rather than nominal: a type satisfies an interface automatically if it has the required methods, without explicit declaration. This enables implicit interface satisfaction, which is more flexible than Java or C# inheritance hierarchies. Key translations: 'abstract class' becomes an interface plus a concrete base type. 'inheritance' becomes struct embedding with method promotion. 'polymorphism' is achieved through interfaces and type switches. Know that Go prefers small interfaces (the io.Reader/io.Writer model) over large interfaces, which enables composition rather than deep inheritance hierarchies.

### Senior @ FAANG: Go OOD at the Senior Level: Interface Design Governance

At the senior level, interface design in Go is a governance concern: interfaces define the contracts between components, and poorly designed interfaces create tight coupling and testing friction. The FAANG bar for Go interface design at L6 includes: interfaces defined at the point of use rather than the point of implementation (the consumer defines the interface, the producer satisfies it), interface granularity matching the minimum required for the caller's use case (the Interface Segregation Principle applied to Go), and interface names that describe behavior ('Reader', 'Writer', 'Closer') rather than identity ('FileInterface', 'DatabaseInterface'). Staff-level concerns include versioning: when an interface is part of a public API, adding a method to it is a breaking change for all implementors. The governance question is how you evolve interfaces without breaking existing code (optional methods via type assertion, new interface embedding, or a compatibility shim).

---
