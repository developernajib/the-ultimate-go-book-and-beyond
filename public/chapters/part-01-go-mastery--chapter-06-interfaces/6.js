export default `## 6.5 Interface Design Principles

### Accept Interfaces, Return Structs

Parameters typed as interfaces let callers pass any compatible implementation, while concrete return types give callers full access to the returned value's methods and fields. This asymmetry maximizes flexibility on the input side and clarity on the output side.

\`\`\`go
// Good: accepts interface
func CopyData(dst io.Writer, src io.Reader) error {
    _, err := io.Copy(dst, src)
    return err
}

// Good: returns concrete type
func NewServer(addr string) *Server {
    return &Server{addr: addr}
}

// Bad: returns interface (usually)
func NewWriter() io.Writer {  // Caller doesn't know actual type
    return &myWriter{}
}
\`\`\`

### Cloudflare's Interface Guidelines

Cloudflare's Go style guide emphasizes:

\`\`\`go
// GOOD: Accept interface, return concrete
type HTTPClient interface {
    Do(*http.Request) (*http.Response, error)
}

type Service struct {
    client HTTPClient // Accepts interface - can mock in tests
}

func NewService(client HTTPClient) *Service {
    return &Service{client: client} // Returns concrete *Service
}

// GOOD: Create interface at consumption point
// In package A (consumer):
type Storer interface {
    Store(key string, value []byte) error
}

func NewHandler(s Storer) *Handler {
    return &Handler{storage: s}
}

// In package B (producer):
type RedisStorage struct { ... }
func (r *RedisStorage) Store(key string, value []byte) error { ... }
// RedisStorage satisfies package A's Storer without knowing about it!
\`\`\`

### Keep Interfaces Small

Single-method interfaces are the easiest to implement, the easiest to mock, and the easiest to compose. The standard library's most successful interfaces, \`io.Reader\`, \`io.Writer\`, \`io.Closer\`, \`fmt.Stringer\`, \`error\`, all have exactly one method.

\`\`\`go
type Reader interface { Read([]byte) (int, error) }
type Writer interface { Write([]byte) (int, error) }
type Closer interface { Close() error }
\`\`\`

Larger interfaces are harder to implement and mock.

### The Rob Pike Rule

From the Go proverbs: "The bigger the interface, the weaker the abstraction."

\`\`\`go
// Too big - hard to implement, hard to mock
type UserStore interface {
    Create(User) error
    Get(id int) (User, error)
    Update(User) error
    Delete(id int) error
    List(filter Filter) ([]User, error)
    Search(query string) ([]User, error)
    Count() (int, error)
    Export(format string) ([]byte, error)
    Import(data []byte) error
    Validate(User) error
    GenerateReport() (Report, error)
}

// Better - small, focused interfaces
type UserCreator interface { Create(User) error }
type UserGetter interface { Get(id int) (User, error) }
type UserUpdater interface { Update(User) error }
type UserDeleter interface { Delete(id int) error }

// Compose when needed
type UserCRUD interface {
    UserCreator
    UserGetter
    UserUpdater
    UserDeleter
}
\`\`\`

### Define Interfaces at Point of Use

In Go, the consumer package defines the interface it needs, not the producer package. This keeps the producer unaware of its consumers and avoids creating a single "god interface" that every consumer must depend on.

\`\`\`go
// package storage
type Database struct { ... }
func (d *Database) Query(sql string) ([]Row, error) { ... }
func (d *Database) Exec(sql string) error { ... }

// package users (consumer defines interface)
type Querier interface {
    Query(sql string) ([]Row, error)
}

type UserRepo struct {
    db Querier  // Depends on interface, not *Database
}
\`\`\`

This allows:
- Testing with mocks
- Swapping implementations
- Reducing coupling

### Interface Guards

A compile-time interface guard is a zero-cost declaration that fails to compile if a type does not satisfy a given interface. This catches method signature drift immediately rather than at runtime.

\`\`\`go
// Verify *Buffer implements io.Writer
var _ io.Writer = (*Buffer)(nil)

// Verify Handler implements http.Handler
var _ http.Handler = Handler{}
\`\`\`

This prevents accidental interface breakage.

### The Four Rules to Internalise

For a senior engineer reviewing Go designs, four interface rules explain almost every finding:

1. **Accept interfaces, return structs.** Functions take interface parameters to let callers supply any compatible type. Functions return concrete types to give callers access to the full API surface. This one rule collapses the majority of "should this be an interface?" decisions.
2. **Define interfaces where they are consumed.** The consumer knows which methods it needs. Defining the interface on the consumer side lets it be as small as possible and lets the producer stay unaware of the interface.
3. **The bigger the interface, the weaker the abstraction.** Rob Pike's proverb. A one-method interface composes with anything. A fifteen-method interface is a coupled mess.
4. **Interface satisfaction is a responsibility, not a declaration.** The type that satisfies an interface commits to the behaviour the interface implies, including semantics the method signatures cannot express. Document the contract in the interface's doc comment.

### Code-Review Lens (Senior Track)

Four findings that recur in interface-design PRs:

1. **Interface declared in the producer package.** Move to consumer.
2. **Interface with more than five methods.** Split or justify.
3. **Function that returns an interface.** Almost always wrong. Return the concrete type.
4. **Missing interface guard for a public implementation.** Add the \`var _ Iface = (*Type)(nil)\` line.

### When to Break Each Rule (Staff Track)

Every Go proverb has a real exception. A staff engineer knows the exceptions as well as the rules.

**Rule 1 exception, return an interface from a factory when there are genuinely multiple implementations chosen at runtime.** \`driver.Open(name) (driver.Conn, error)\` in \`database/sql\` returns an interface because the driver registry decides which concrete connection type. When the caller truly does not need to know the concrete type and the dispatch is data-driven, an interface return is correct. The test is: does the factory choose between two or more real implementations based on its input? If yes, interface. If no, struct.

**Rule 2 exception, a large interface is correct when it models a genuinely large external contract.** \`database/sql.Conn\` has many methods because a database connection has many responsibilities. Splitting it would make the API harder to use. The rule "small interfaces" is about consumer-defined interfaces, not about modeling inherently complex systems.

**Rule 3 exception, return an interface when the concrete type is unexported and the interface is the public API surface.** Idiomatic pattern: package exports \`New()\` that returns an interface, keeps the implementing struct unexported. This is the Go answer to "abstract class". Example: \`hash.Hash\` from \`crypto/sha256.New()\`. The rule bends when hiding the type is a deliberate API choice.

**Rule 4 exception, skip the guard for internal-only types.** The guard costs nothing, but for unexported types in a small package, the compiler catches the mismatch at the use site anyway. Reserve the guard for public or cross-package implementations where signature drift is most likely.

### Principal Lens: The Hidden Fifth Rule

Beyond the four explicit rules is the one most material at the architectural level: **an interface is a communication contract between a caller who will change and an implementer who will change, mediated by a type system that cannot express every constraint.** Method signatures capture the syntax. Doc comments capture the semantics (preconditions, postconditions, thread-safety, allocation behaviour, whether \`nil\` is acceptable input, whether the method blocks). A principal engineer writing an interface for a platform team treats the doc comment as load-bearing. Interfaces without contract-level documentation become interfaces where every implementer reinvents the semantics, callers make assumptions, and the inconsistencies show up as latent bugs across dozens of services. The \`io.Reader\` doc comment is three paragraphs long for a reason. It spells out exactly what an implementation must do with \`n == 0\`, what \`io.EOF\` means in conjunction with \`n > 0\`, and what the caller must assume. Read it. That is the bar.

---
`;
