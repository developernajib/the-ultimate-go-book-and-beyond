## 52C.1 Why Go Works Well for DDD

DDD did not originate in the Go world. Eric Evans' original book used Java examples, and most early DDD literature assumed object-oriented inheritance as the implementation mechanism. This led some developers to conclude that Go - without inheritance, without exceptions, with value semantics - is poorly suited for DDD. That conclusion is wrong. Go's design choices align with DDD principles in several concrete ways.

### Interfaces as Domain Contracts

In Java or C#, you typically define interfaces and then annotate concrete classes to indicate they implement those interfaces. The dependency is explicit and bidirectional: the class knows it implements the interface.

In Go, interface satisfaction is implicit. This has a direct consequence for DDD: your domain layer defines interfaces (repository contracts, external service contracts) and never needs to know about the concrete implementations. The infrastructure layer satisfies those interfaces without importing the domain package, except to use its types.

```
Domain Layer
  - defines: OrderRepository interface
  - never imports: database/sql, github.com/lib/pq, or any infra package

Infrastructure Layer
  - imports: domain layer (to use domain types)
  - implements: OrderRepository interface (implicitly)
  - imports: database drivers, message brokers, etc.

The dependency arrow points INTO the domain, never out of it.
```

This is the Dependency Inversion Principle implemented through Go's type system. You do not need Spring's `@Autowired`, no reflection, no IoC container - just interfaces.

### No Inheritance Means No Framework Pollution

The most common form of domain model corruption in Java is inheriting from framework base classes:

```java
// Java - your domain entity is now coupled to JPA
@Entity
@Table(name = "orders")
public class Order extends AbstractPersistable<Long> {
    @Column(nullable = false)
    private String status;
    // Domain entity knows it's persisted. Wrong.
}
```

In Go, this is impossible. Your domain structs cannot inherit from a database framework's base class because Go has no inheritance. Your domain struct is a plain Go struct. It knows nothing about databases. This is not a limitation - it is an architectural guarantee.

### Value Semantics Encourage Value Objects

Go structs are value types by default. When you assign a struct or pass it to a function, you get a copy. This aligns perfectly with the DDD concept of Value Objects - objects that should be immutable and compared by value.

```go
// Value objects passed by value are naturally immutable
// because callers get a copy, not a reference to the original
func processAddress(addr ShippingAddress) {
    // Any modifications here don't affect the caller's copy
    addr.city = "modified" // this modifies the local copy only
}
```

For value objects that you want to explicitly prevent mutation on, use unexported fields with exported getters and no setters - as shown in Chapter 52B.

Value types also have a performance story. A `Money{Amount int64, Currency string}` is 24 bytes on a 64-bit platform. Passing it by value costs a register copy. Compare this to JVM heap allocations for every `BigDecimal`. The entire category of "hibernate session leaked a mutable entity across threads" bugs simply does not exist in idiomatic Go because value objects cannot be mutated through a shared reference when passed by value. That is a DDD win delivered by the language, not by discipline.

### Small Interfaces Keep the Domain Honest

The Go proverb "the bigger the interface, the weaker the abstraction" is the best architectural rule DDD practitioners in Go have. In Java codebases it is normal to see an `OrderRepository` with twenty methods because the ORM demands CRUD symmetry. In Go, you define only what the domain actually requires:

```go
// internal/domain/order/repository.go
type Reader interface {
    FindByID(ctx context.Context, id OrderID) (*Order, error)
}

type Writer interface {
    Save(ctx context.Context, o *Order) error
}

// Compose where needed. A CancelOrder handler needs both; a GetOrder
// handler needs only Reader. The application layer consumes the
// narrowest interface it can.
type Repository interface {
    Reader
    Writer
}
```

This is Interface Segregation applied without ceremony. One Postgres struct implements all of them. Tests inject a `Reader` fake for query handlers and a full `Repository` fake for command handlers. No Java-style `OrderRepositoryImpl extends JpaRepository<Order, Long>` inheritance hierarchy required.

### Explicit Error Handling Models Domain Failures

Go's explicit `error` returns, rather than exceptions, align with how domain failures should be modeled. A domain failure - "the order cannot be canceled because the window has expired" - is not an exceptional, unexpected condition. It is a known, expected outcome of a domain operation. Go's `error` return models this precisely:

```go
// The signature communicates that Cancel might not succeed
// and the caller must handle that explicitly
func (o *Order) Cancel(reason string) error

// In Java, you might throw an exception:
// public void cancel(String reason) throws CancellationWindowExpiredException
// But this mixes domain failures with infrastructure failures
// (both use the same exception mechanism)
```

In Go, you can use typed errors to distinguish domain failures from infrastructure failures:

```go
// Domain failures are values, not panics
var ErrCancellationWindowExpired = errors.New("...")

// Infrastructure failures are also errors but wrapped differently
if err := db.Exec(...); err != nil {
    return fmt.Errorf("infrastructure: save order: %w", err)
}
```

---

### Junior → FAANG: Building the Habit of Language-Aligned Design

New Go developers coming from Java or Python often try to replicate OOP patterns they already know. They reach for interface hierarchies, base classes via anonymous embedding used as inheritance, and exception-style panics for expected failures. Each of these choices works against Go's design and, specifically, against DDD.

The exercises in this section to practice before an interview:

1. Take a domain concept you know well (a bank account, a shopping cart, a user subscription) and model it as a pure Go struct with no imports. No `gorm`, no `json` tags, no `http` references. If you cannot write the struct without importing something outside the standard library, the design is not yet a domain model.

2. Define a repository interface for that concept in the same package as the struct. Write a 30-line in-memory implementation in a `_test.go` file. Run `go test` and verify the domain logic works before touching any database.

3. Practice explaining why Go's implicit interface satisfaction is better for DDD than Java's explicit `implements`. The answer: the domain package never needs to know the infrastructure exists, because the Go compiler resolves the interface satisfaction without any declaration in the domain.

These three exercises build the muscle memory that FAANG interviewers test with questions like "show me a code smell in this Go DDD project" or "where would you add a new payment method to this codebase?"

### Senior @ FAANG: Evaluating Go as a DDD Vehicle at the Platform Level

The argument that "Go is good for DDD" is worth scrutinizing beyond the surface-level feature match. At the staff level, your evaluation needs to include the limitations alongside the strengths, because platform decisions that ignore trade-offs produce regret two years later.

**Where Go's DDD story is genuinely strong.** Implicit interfaces eliminate the ceremony tax that makes Java DDD verbose. Value semantics make value objects correct by default rather than by discipline. The `internal/` mechanism is a compiler-enforced module boundary that no other mainstream language matches with zero configuration. The lack of inheritance prevents the most common form of domain model corruption (inheriting from an ORM base class). These are architectural properties, not style preferences.

**Where Go's DDD story has real gaps.** Go has no built-in support for rich constructors with precondition enforcement. Every factory function is a convention, not a language feature. There is no equivalent of Kotlin's `sealed class` for sum types, which makes modeling algebraic domain concepts (an order is either `Draft | Pending | Confirmed | Canceled`, and the compiler should enforce exhaustive handling) verbose. The `iota` trick is a poor substitute. Generics (since Go 1.18) partially address this for collection-typed value objects, but the ergonomics are not as clean as Rust enums or Haskell ADTs.

**Implications for a platform ADR.** A Staff engineer writing an ADR on "DDD Go vs. DDD Kotlin/JVM for our platform" must weigh: Go wins on deployment simplicity, startup time, and operational surface area. JVM wins on richer type system expressiveness for complex domains, mature DDD ecosystem (Axon Framework, Spring Modulith), and sealed class modeling. For event-driven microservices with moderate domain complexity, Go wins. For complex financial or insurance domains with rich state machines and regulatory compliance modeling, a typed JVM language may be the better host for the domain layer, even if Go serves as the infrastructure runtime for other services.

**Bar-raiser signal: what the candidate knows about Go generics and DDD.** A strong Staff-level candidate can discuss how Go generics (introduced in 1.18, stable by 1.21) enable typed aggregate repositories without reflection:

```go
// A generic repository base that type-checks at compile time
type Repository[ID comparable, A any] interface {
    FindByID(ctx context.Context, id ID) (A, error)
    Save(ctx context.Context, aggregate A) error
}

// Concrete instantiation for Order
type OrderRepository Repository[OrderID, *Order]
```

This eliminates the boilerplate of defining `FindByID` with the right types per aggregate, while keeping the interface in the domain layer. A candidate who knows this and can discuss its limitations (constraints on `A` must be explicit if you need `DomainEvents()` without reflection) is operating at L6 thinking.

---
