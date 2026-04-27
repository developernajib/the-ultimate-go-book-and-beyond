export default `## 6.10 Common Mistakes and How to Avoid Them

### Mistake 1: Interface Pollution

Defining a wide interface in the producer package forces every consumer to depend on methods they may never call, creating unnecessary coupling. Go's implicit interface satisfaction means interfaces should be defined at the consumer side, exposing only the behavior that package actually needs.

\`\`\`go
// BAD: Interface defined with implementation
package storage

type Storage interface {
    Get(key string) ([]byte, error)
    Set(key string, value []byte) error
    Delete(key string) error
}

type RedisStorage struct { ... }

// GOOD: Interface defined at consumer
package cache

type Getter interface {
    Get(key string) ([]byte, error)
}

type Service struct {
    store Getter // Only needs Get
}
\`\`\`

### Mistake 2: Empty Interface Overuse

Accepting \`any\` loses all compile-time type information, pushing type safety checks into runtime assertions that can panic. Generics with a meaningful constraint, or a specific interface with the required method set, restore type safety while preserving flexibility.

\`\`\`go
// BAD: Loses type safety
func Process(data any) {
    // Lots of type assertions needed
}

// GOOD: Use generics or specific types
func Process[T Processable](data T) {
    data.Process()
}
\`\`\`

### Mistake 3: Ignoring Nil Interface Gotcha

Returning a typed nil (a nil \`*os.File\` assigned to \`io.Writer\`) produces a non-nil interface because the type field is populated. Callers testing \`!= nil\` will proceed with what appears to be a valid writer, leading to nil pointer panics. Return explicit \`nil\` when there is no value to return.

\`\`\`go
// BAD: Returns typed nil
func getWriter() io.Writer {
    var f *os.File = nil
    return f // NOT nil!
}

// GOOD: Return explicit nil
func getWriter() io.Writer {
    return nil
}
\`\`\`

### Mistake 4: Large Interfaces

A service interface with eight methods is difficult to mock in tests and forces implementations to provide functionality they may not logically own. Splitting into single-method interfaces like \`Creator\` and \`Reader\` lets each call site declare exactly what it needs, following the interface segregation principle.

\`\`\`go
// BAD: Too many methods
type Service interface {
    Create(...) error
    Read(...) (T, error)
    Update(...) error
    Delete(...) error
    List(...) ([]T, error)
    Search(...) ([]T, error)
    Validate(...) error
    Export(...) ([]byte, error)
}

// GOOD: Small, focused interfaces
type Creator interface { Create(...) error }
type Reader interface { Read(...) (T, error) }
\`\`\`

### Mistake 5: Interface Before Implementation

Designing an interface before writing any concrete code leads to interfaces shaped around imagined requirements rather than real usage. Go's idiomatic approach is to write the concrete implementation first, then extract the minimal interface at the point where a second implementation or testability requires it.

\`\`\`go
// BAD: Designing interface first, guessing at methods
type UserService interface {
    // Imagining what we might need before any code exists
    GetUser(id string) (*User, error)
    ListUsers(filter Filter) ([]*User, error)
    UpdateUser(user *User) error
    // ... methods that may never be called
}

// GOOD: Write the concrete type first
type userRepository struct {
    db *sql.DB
}

func (r *userRepository) GetByID(ctx context.Context, id string) (*User, error) {
    // Real implementation drives the method signature
}

// Then extract the interface at the consumer site, with only the methods used
type userGetter interface {
    GetByID(ctx context.Context, id string) (*User, error)
}
\`\`\`

### Institutional Mistakes and Their Detection

For a senior engineer running the team's review discipline, each mistake here has a detection approach:

1. **Interface bloat.** Code review. No linter catches it. The rule is "if adding a method requires updating more than one caller, the interface is doing too much".
2. **Typed-nil returns.** \`nilness\` analyser partially covers. The discipline is "always return \`nil\` literal on success".
3. **Interface in producer package.** Code review. Catch in design discussions before implementation.
4. **Over-mocking.** Code review. The signal is "the test asserts on the mock, not the code".
5. **\`interface{}\` parameters without reason.** Code review or \`staticcheck\` in some cases. Replace with typed parameters or generics.

The team checklist is the artifact. Each recurring mistake gets a line on the checklist, and the review discipline catches the next one.

### Mistake 6: Returning Concrete Error Types as \`error\`

Returning a custom error type directly as \`error\` is fine. Returning a pointer to a custom error type from a function declared to return \`error\`, then assigning a nil pointer to that return value, reproduces the typed-nil bug in the most common form in production Go.

\`\`\`go
type QueryError struct { Code int }
func (e *QueryError) Error() string { return fmt.Sprintf("code %d", e.Code) }

func Query() error {
    var err *QueryError // nil
    // ... happy path leaves err nil ...
    return err // BUG: non-nil interface wrapping nil pointer
}
\`\`\`

The fix is the same as mistake 3: return the bare \`nil\` literal on success. The variant worth internalising is that this pattern hides inside error-accumulation helpers where the bug is only visible when the accumulator is empty.

### Mistake 7: Interface Methods That Leak Infrastructure

An interface method signature like \`Query(sql string) (*sql.Rows, error)\` has coupled every consumer of that interface to \`database/sql\`. Swapping the backend to a NoSQL store now requires a new interface and a caller migration. The fix: express the method in domain terms (\`FindUsers(ctx context.Context, filter UserFilter) ([]User, error)\`). The interface should describe what the caller wants, not how the provider delivers it. This is the classic leaky-abstraction mistake and it is the reason many "interface-driven" designs still require rewrites when the backing store changes.

### Mistake 8: Designing for Polymorphism That Never Arrives

A common senior-track failure mode: defining an interface in anticipation of a second implementation that never ships. Three years later the team has forty interfaces each with one production implementation and one test mock. The indirection costs readability and debuggability without ever paying off. The discipline: introduce the interface when the second implementation is concrete enough to scaffold, not when it is speculative. YAGNI applies to interfaces as much as to code.

### Staff Lens: The Mistake Layer Above the Mistakes

The mistakes above are code-level. The staff-level mistake that generates them is cultural: a team with no shared interface-design reference produces thirty variations of the same error. The fix is organizational. One owner, one internal doc, quarterly review. Treat interface design as a deliverable, not a by-product of coding. The first team to do this in a large Go org reaps a compounding benefit. Every new engineer learns the shared style on day one, and the review discipline becomes "does it match the doc" instead of "does the reviewer remember to look".

---
`;
