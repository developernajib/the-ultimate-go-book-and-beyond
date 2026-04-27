export default `## Interface Pitfalls and Production Patterns

This section collects the interface mistakes that most frequently cause production bugs, alongside the patterns that prevent them.

### The Nil Interface Gotcha

An interface value is nil only when both its type and value fields are nil. Storing a nil pointer of a concrete type into an interface populates the type field, making the interface non-nil even though the underlying pointer is nil. This mismatch is the source of most "unexpected non-nil error" bugs in Go.

\`\`\`go
// THE GOTCHA: An interface is only nil when both type and value are nil
func demonstrateNilGotcha() {
    var p *User = nil           // Typed nil pointer
    var i any = p       // Interface containing nil pointer

    fmt.Println(p == nil)       // true
    fmt.Println(i == nil)       // false! Interface has type info

    // The interface i contains:
    // - Type: *User
    // - Value: nil
    // Since type is not nil, i != nil
}

// PRODUCTION BUG: Returning typed nil in error path
type ValidationError struct {
    Field   string
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

// WRONG: Returns typed nil that isn't detected
func validateBad(input string) error {
    var err *ValidationError  // nil pointer

    if input == "" {
        err = &ValidationError{Field: "input", Message: "required"}
    }

    return err  // Returns (*ValidationError)(nil), NOT nil!
}

func handleValidation() {
    err := validateBad("hello")
    if err != nil {  // TRUE even though err points to nil!
        fmt.Println(err.Error())  // PANIC: nil pointer dereference
    }
}

// CORRECT: Return explicit nil
func validateGood(input string) error {
    if input == "" {
        return &ValidationError{Field: "input", Message: "required"}
    }
    return nil  // Explicit nil, not typed nil
}

// CORRECT: Use named return with explicit nil
func validateGood2(input string) (err error) {
    if input == "" {
        err = &ValidationError{Field: "input", Message: "required"}
    }
    // If input is valid, err is nil (zero value of interface)
    return err
}

// DEFENSIVE: Check for nil value inside interface
func isReallyNil(i any) bool {
    if i == nil {
        return true
    }
    v := reflect.ValueOf(i)
    switch v.Kind() {
    case reflect.Ptr, reflect.Map, reflect.Slice, reflect.Chan, reflect.Func:
        return v.IsNil()
    }
    return false
}
\`\`\`

### Interface Pollution: When Abstraction Hurts

Defining an interface for every type, particularly when only one implementation exists, adds indirection without benefit. The resulting code is harder to navigate because readers must look up the interface definition and then find the concrete type separately.

\`\`\`go
// WRONG: Interface for everything (Java-style)
type UserRepository interface {
    FindByID(id string) (*User, error)
    FindByEmail(email string) (*User, error)
    Save(user *User) error
    Delete(id string) error
    FindAll() ([]*User, error)
    FindByRole(role string) ([]*User, error)
    Count() (int, error)
}

type UserService interface {
    GetUser(id string) (*User, error)
    CreateUser(req CreateUserRequest) (*User, error)
    UpdateUser(id string, req UpdateUserRequest) (*User, error)
    DeleteUser(id string) error
    ListUsers(filter UserFilter) ([]*User, error)
}

// Problems:
// 1. One huge interface instead of focused ones
// 2. Most callers only need 1-2 methods
// 3. Hard to mock in tests
// 4. Interface defined at definition site, not use site

// CORRECT: Small, focused interfaces at point of use
type UserFinder interface {
    FindByID(id string) (*User, error)
}

type UserCreator interface {
    Save(user *User) error
}

// Define at consumer site, not provider site
package handlers

type userGetter interface {  // Unexported - only for this package
    GetByID(ctx context.Context, id string) (*User, error)
}

type Handler struct {
    users userGetter  // Accept small interface
}

// The concrete UserRepository implements this interface
// automatically - no explicit declaration needed

// UBER PATTERN: Accept interfaces, return structs
func NewUserService(repo *PostgresUserRepo) *UserService {
    return &UserService{repo: repo}
}

// The method can accept an interface for flexibility:
func (s *UserService) ProcessUser(finder UserFinder, id string) error {
    user, err := finder.FindByID(id)
    // ...
}
\`\`\`

### Empty Interface Anti-patterns

Every \`any\` parameter is a place where the compiler stops checking types and defers that responsibility to runtime assertions. Overuse of \`any\` turns type errors from build failures into production panics.

\`\`\`go
// WRONG: Losing type safety with any
type BadCache struct {
    data map[string]any
}

func (c *BadCache) Set(key string, value any) {
    c.data[key] = value
}

func (c *BadCache) Get(key string) any {
    return c.data[key]
}

// Usage requires type assertions everywhere
cache := NewBadCache()
cache.Set("user", user)
cache.Set("count", 42)

// Error-prone retrieval
if v := cache.Get("user"); v != nil {
    user := v.(*User)  // What if it's not *User? PANIC!
}

// CORRECT: Use generics (Go 1.18+)
type Cache[T any] struct {
    data map[string]T
}

func NewCache[T any]() *Cache[T] {
    return &Cache[T]{data: make(map[string]T)}
}

func (c *Cache[T]) Set(key string, value T) {
    c.data[key] = value
}

func (c *Cache[T]) Get(key string) (T, bool) {
    v, ok := c.data[key]
    return v, ok
}

// Type-safe usage
userCache := NewCache[*User]()
userCache.Set("alice", alice)
user, ok := userCache.Get("alice")  // user is *User, no assertion

// WHEN any IS APPROPRIATE:
// 1. Truly heterogeneous data (JSON, config values)
// 2. Library code that must work with any type
// 3. Integration with reflection-based systems

// CORRECT: Type switch for heterogeneous data
func processValue(v any) string {
    switch x := v.(type) {
    case string:
        return x
    case int:
        return strconv.Itoa(x)
    case bool:
        return strconv.FormatBool(x)
    case []byte:
        return string(x)
    case nil:
        return "<nil>"
    default:
        return fmt.Sprintf("%v", v)
    }
}
\`\`\`

### Interface Satisfaction Mistakes

The rules for when a type satisfies an interface depend on whether the methods use value or pointer receivers, and whether the value is addressable. These rules are consistent but often surprise developers coming from other languages.

\`\`\`go
// MISTAKE #1: Value vs pointer receiver confusion
type Counter struct {
    count int
}

func (c *Counter) Increment() {  // Pointer receiver
    c.count++
}

func (c Counter) Value() int {  // Value receiver
    return c.count
}

type Incrementer interface {
    Increment()
}

type Valuer interface {
    Value() int
}

func demo() {
    var c Counter

    // Valuer interface
    var v Valuer = c      // OK: value receiver, value type
    var v2 Valuer = &c    // OK: value receiver, pointer type

    // Incrementer interface
    // var i Incrementer = c   // ERROR: Counter doesn't have Increment
    var i Incrementer = &c  // OK: pointer receiver needs pointer type
}

// WHY: Go can get &c from c for method calls, but can't get *c from c
// for interface satisfaction (because interface might outlive variable)

// COMPILE-TIME INTERFACE CHECK
var _ Incrementer = (*Counter)(nil)  // Panics at compile time if not satisfied

// MISTAKE #2: Embedding doesn't inherit interfaces automatically
type Reader interface {
    Read(p []byte) (n int, err error)
}

type Closer interface {
    Close() error
}

type ReadCloser interface {
    Reader
    Closer
}

type MyReader struct{}
func (r *MyReader) Read(p []byte) (int, error) { return 0, nil }

type MyReadCloser struct {
    MyReader  // Embedded
}
func (r *MyReadCloser) Close() error { return nil }

// MyReadCloser satisfies ReadCloser because it has both methods
// But note: methods are promoted, not inherited

// MISTAKE #3: any doesn't mean "any interface"
type Stringer interface {
    String() string
}

func takeStringer(s Stringer) {}
func takeAny(a any) {}

func example() {
    var s Stringer = &MyStringer{}
    var a any = s

    takeStringer(s)  // OK
    takeAny(a)       // OK
    takeAny(s)       // OK: Stringer can be passed as any

    // But...
    takeStringer(a)  // ERROR: any doesn't satisfy Stringer
}
\`\`\`

### Interface Segregation in Practice

A consumer that only reads files should not depend on an interface that also requires write, delete, and chmod methods. Splitting fat interfaces into focused ones lets each consumer declare exactly the capability it needs, making dependencies explicit and mocks trivial.

\`\`\`go
// WRONG: Fat interface
type FileHandler interface {
    Read(path string) ([]byte, error)
    Write(path string, data []byte) error
    Delete(path string) error
    List(dir string) ([]string, error)
    Move(src, dst string) error
    Copy(src, dst string) error
    Chmod(path string, mode os.FileMode) error
    Stat(path string) (os.FileInfo, error)
}

// Most consumers only need 1-2 methods

// CORRECT: Segregated interfaces
type FileReader interface {
    Read(path string) ([]byte, error)
}

type FileWriter interface {
    Write(path string, data []byte) error
}

type FileDeleter interface {
    Delete(path string) error
}

// Compose when needed
type FileReadWriter interface {
    FileReader
    FileWriter
}

// Consumer declares exactly what it needs
type ConfigLoader struct {
    reader FileReader  // Only needs Read
}

func NewConfigLoader(r FileReader) *ConfigLoader {
    return &ConfigLoader{reader: r}
}

// NETFLIX PATTERN: Role interfaces
type Authenticator interface {
    Authenticate(ctx context.Context, token string) (*User, error)
}

type Authorizer interface {
    Authorize(ctx context.Context, user *User, resource string, action string) error
}

// Service accepts only what it needs
type ContentService struct {
    auth Authenticator  // Doesn't need full auth system
}
\`\`\`

### Testing with Interface Mocks

Hand-written mocks for small interfaces are often simpler than generated mocks or reflection-based frameworks. A mock struct stores canned responses and optionally records calls for later assertion. The following example shows this pattern applied to a user store.

\`\`\`go
// Define minimal interface for testing
type userStore interface {
    Get(ctx context.Context, id string) (*User, error)
    Save(ctx context.Context, user *User) error
}

// Production implementation
type PostgresUserStore struct {
    db *sql.DB
}

func (s *PostgresUserStore) Get(ctx context.Context, id string) (*User, error) {
    // Real database query
}

func (s *PostgresUserStore) Save(ctx context.Context, user *User) error {
    // Real database insert
}

// Test mock - implements same interface
type mockUserStore struct {
    users    map[string]*User
    getError error
    saveErr  error
}

func (m *mockUserStore) Get(ctx context.Context, id string) (*User, error) {
    if m.getError != nil {
        return nil, m.getError
    }
    user, ok := m.users[id]
    if !ok {
        return nil, ErrNotFound
    }
    return user, nil
}

func (m *mockUserStore) Save(ctx context.Context, user *User) error {
    if m.saveErr != nil {
        return m.saveErr
    }
    m.users[user.ID] = user
    return nil
}

// Test using mock
func TestUserService_GetUser(t *testing.T) {
    tests := []struct {
        name      string
        mock      *mockUserStore
        userID    string
        want      *User
        wantError bool
    }{
        {
            name: "user found",
            mock: &mockUserStore{
                users: map[string]*User{
                    "123": {ID: "123", Name: "Alice"},
                },
            },
            userID: "123",
            want:   &User{ID: "123", Name: "Alice"},
        },
        {
            name: "user not found",
            mock: &mockUserStore{
                users: map[string]*User{},
            },
            userID:    "456",
            wantError: true,
        },
        {
            name: "database error",
            mock: &mockUserStore{
                getError: errors.New("connection failed"),
            },
            userID:    "789",
            wantError: true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            svc := NewUserService(tt.mock)
            got, err := svc.GetUser(context.Background(), tt.userID)

            if tt.wantError {
                if err == nil {
                    t.Error("expected error, got nil")
                }
                return
            }

            if err != nil {
                t.Errorf("unexpected error: %v", err)
            }
            if !reflect.DeepEqual(got, tt.want) {
                t.Errorf("got %+v, want %+v", got, tt.want)
            }
        })
    }
}
\`\`\`

### Interface Performance Considerations

An interface method call involves loading the method address from the itab and calling through a pointer, which prevents inlining. For most code this overhead is irrelevant compared to I/O or business logic, but in tight loops processing millions of items it becomes measurable.

\`\`\`go
// Interface call involves:
// 1. Load interface table (itable)
// 2. Load method pointer from itable
// 3. Call through pointer (no inlining possible)

// For HOT PATHS, measure the difference:
type Processor interface {
    Process(data []byte) []byte
}

type ConcreteProcessor struct{}

func (p *ConcreteProcessor) Process(data []byte) []byte {
    // Process data
    return data
}

// Benchmark direct vs interface call
func BenchmarkDirect(b *testing.B) {
    p := &ConcreteProcessor{}
    data := make([]byte, 1024)

    b.ResetTimer()
    for b.Loop() {
        _ = p.Process(data)  // Direct call - can be inlined
    }
}

func BenchmarkInterface(b *testing.B) {
    var p Processor = &ConcreteProcessor{}
    data := make([]byte, 1024)

    b.ResetTimer()
    for b.Loop() {
        _ = p.Process(data)  // Interface call - no inlining
    }
}

// Results (example):
// BenchmarkDirect-8      1000000000    0.3 ns/op  <- Inlined
// BenchmarkInterface-8    500000000    2.5 ns/op  <- Virtual call

// WHEN IT MATTERS:
// - Tight loops processing millions of items
// - Hot paths in web servers
// - Performance-critical sections

// WHEN IT DOESN'T MATTER:
// - I/O bound operations
// - Network calls
// - Most business logic

// OPTIMIZATION: Use generics to avoid interface for type-safe hot paths
func ProcessAll[T Processable](items []T, processor func(T) T) []T {
    result := make([]T, len(items))
    for i, item := range items {
        result[i] = processor(item)
    }
    return result
}
\`\`\`

### Quick Reference: Interface Best Practices

| Scenario | Do | Don't |
|----------|-----|-------|
| Interface size | 1-3 methods | Large interfaces |
| Definition location | Consumer package | Provider package |
| Nil error return | \`return nil\` explicit | Return typed nil |
| Testing | Small interface mocks | Mock entire systems |
| Composition | Embed small interfaces | Create "god" interfaces |
| Type assertion | Use comma-ok form | Panic on failure |
| Performance-critical | Consider generics | Use interface if not needed |
| Empty interface | Only for truly dynamic | As general container |

### Production Wisdom Worth Repeating

For a senior engineer setting team discipline, the table is the starting point. The non-mechanical wisdom that does not fit in a table:

1. **Interfaces are contracts, not types.** The contract includes behaviour the method signatures cannot express. Document it in the interface's doc comment.
2. **Breaking an interface breaks every implementation.** Changes to public interfaces are major version bumps. Add methods via composition (\`type CacheV2 interface { Cache; NewMethod() }\`) when possible.
3. **The right abstraction emerges from concrete code.** Write the concrete implementation first. Extract the interface at the consumer site after you see what the consumer actually needs.
4. **Every interface has a cost.** One more name to remember, one more indirection to debug, one more fake to maintain. Keep the cost honest. If the interface is not earning its keep, remove it.
5. **Over-interfacing is more common than under-interfacing.** The bug is rarely "we should have had an interface here". The bug is usually "we have an interface here that nobody uses for its intended purpose". Start concrete, introduce interfaces only when justified.

The team that internalises these ships Go that stays maintainable for years. The team that does not ends up with an interface-heavy codebase where every change requires updating seventeen implementations.

### Principal Lens: Interface Governance at Org Scale

In a Go organization that spans hundreds of engineers and thousands of services, interfaces compound. The principal-level work is not writing interfaces. It is defining the review and deprecation machinery that keeps the interface population healthy.

Three governance artifacts matter:

1. **An interface directory.** A lightweight internal page that lists every public interface in every shared platform package, with a one-line description, the owning team, and the last review date. The act of listing forces the question "do we still need this?" once a year.
2. **A deprecation registry.** When an interface is deprecated, it enters a registry with a hard removal date and a named owner responsible for migrating the last caller. Without this, deprecations linger for years.
3. **A design-review rubric.** A checklist the senior pool applies to any PR that introduces or changes a public interface in a shared package. Items: is this the smallest contract that meets the need, is it defined close to the consumer, does the doc comment specify thread-safety and error behaviour, is there a contract test, is there a migration plan if it replaces an existing interface. Ten items. One page. Applied consistently.

These are unglamorous. They are also the difference between a Go monorepo that scales to a thousand services and one that collapses under accretion. The principal engineer who builds this machinery, gets the senior pool trained to apply it, and then steps back, is the one whose impact is still visible in the codebase three years later. Most engineers at that level write code. The ones who matter build the systems that shape the code everyone else writes. Interface governance is one of those systems.

---
`;
