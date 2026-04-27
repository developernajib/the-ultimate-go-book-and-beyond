export default `## 10.6 Naming Conventions

Go's naming conventions are not mere style preferences, the compiler enforces some of them (exported vs. unexported), and the rest are followed so consistently across the ecosystem that violating them signals unfamiliarity with the language.

### Package Names

Package names appear as a qualifier at every call site (\`http.Get\`, \`json.Marshal\`), so they should be short, lowercase, and descriptive enough to stand on their own:

- Lowercase, single word
- Short but descriptive
- Avoid \`util\`, \`common\`, \`misc\`, \`base\`
- No underscores or camelCase

\`\`\`go
// Good
package user
package http
package json
package postgres

// Bad
package userService     // No camelCase
package http_client     // No underscores
package commonUtils     // Too generic
package models          // Too generic (what kind of models?)
\`\`\`

### Variable Names

Go favors short variable names in tight scopes and longer, more descriptive names when the variable lives across many lines. Single-letter variables like \`i\`, \`v\`, and \`r\` are perfectly clear inside a three-line loop. A function parameter visible for fifty lines deserves a full word:

\`\`\`go
// Short for loops and small functions
for i, v := range items { }
if err := doSomething(); err != nil { }
func process(ctx context.Context) { }

// Common abbreviations
ctx      // context.Context
err      // error
req, res // request, response
tx       // transaction
db       // database
cfg      // config
msg      // message

// Longer names for larger scope or exported
func (s *Server) handleUserRegistration(
    ctx context.Context,
    registrationRequest *RegisterRequest,
) (*RegisterResponse, error) {
    // ...
}
\`\`\`

### Function Names

Go function names follow camelCase, with exported functions starting with an uppercase letter. Names should be descriptive enough to read clearly at the call site without requiring additional comments.

\`\`\`go
// Verb or verb phrase
func ProcessOrder(o *Order) error
func ValidateEmail(email string) bool
func SendNotification(user *User, msg string) error

// Getter: Name(), not GetName()
func (u *User) Name() string { return u.name }
func (u *User) Email() string { return u.email }

// Boolean: Is/Has/Can prefix
func (u *User) IsActive() bool { return u.active }
func (u *User) HasPermission(p Permission) bool { return u.perms[p] }
func (u *User) CanDelete(resource Resource) bool { ... }

// Constructor: New prefix
func NewUser(name, email string) *User
func NewUserService(repo UserRepository) *UserService
\`\`\`

### Interface Names

Single-method interfaces are conventionally named with an \`-er\` suffix derived from the method name: \`io.Reader\`, \`io.Writer\`, \`http.Handler\`. Multi-method interfaces describe the role of the implementing type.

\`\`\`go
// Single-method: method name + "er"
type Reader interface { Read(p []byte) (n int, err error) }
type Writer interface { Write(p []byte) (n int, err error) }
type Closer interface { Close() error }
type Stringer interface { String() string }
type Marshaler interface { Marshal() ([]byte, error) }

// Multi-method: descriptive noun
type UserRepository interface {
    Get(id string) (*User, error)
    Create(user *User) error
    Update(user *User) error
    Delete(id string) error
}

// No prefixes or suffixes
// Bad:
type IReader interface { ... }        // No I prefix
type ReaderInterface interface { ... } // No Interface suffix
\`\`\`

### Acronyms and Initialisms

Go treats acronyms as single words and keeps their casing uniform. \`HTTP\` stays all-caps when exported, all-lower when unexported, never mixed like \`Http\`:

\`\`\`go
// Correct
var userID string      // not userId
var httpServer Server  // not HttpServer
var xmlParser Parser   // not XmlParser
var url string         // not URL (lowercase when not at start)

// At start of name, all caps if exported
type HTTPServer struct{}  // Exported
func XMLParser() {}       // Exported

type httpServer struct{}  // Unexported
func xmlParser() {}       // Unexported
\`\`\`

### Constants

Constants in Go use camelCase (exported) or lowercase camelCase (unexported), not \`ALL_CAPS\`. The \`iota\` mechanism generates sequences of related constants without requiring explicit numeric values.

\`\`\`go
// Single constants - camelCase if private, PascalCase if public
const maxRetries = 3
const MaxConnections = 100

// Groups - often PascalCase for both
const (
    StatusPending  = "pending"
    StatusActive   = "active"
    StatusInactive = "inactive"
)

// Iota for sequential
const (
    LevelDebug = iota
    LevelInfo
    LevelWarn
    LevelError
)
\`\`\`

### Naming Discipline in Review

Three persistent naming mistakes to flag:

1. **Stuttering names.** \`user.UserService\` repeats. Use \`user.Service\`.
2. **Vague package names.** \`util\`, \`common\`, \`helpers\`. These are a smell. Each type should have a specific home.
3. **Interface-name drift.** Go interfaces use verb-er (\`Reader\`, \`Stringer\`). Avoid \`IFoo\` or \`FooInterface\`.

### Receiver Names

Receiver names are one of the most-violated conventions. The rule: short (one or two letters), consistent across all methods of the type, derived from the type name (first letter usually).

\`\`\`go
func (s *Server) Start()  { ... }
func (s *Server) Stop()   { ... } // consistent s
// not func (self *Server) or func (server *Server)
\`\`\`

Do not use \`this\` or \`self\`. Do not vary the receiver name between methods of the same type. These are the two most common naming findings in a review of Go code from developers migrating from other languages.

### Error Variable Names

Sentinel errors use the \`ErrX\` prefix. Custom error types use the \`XError\` suffix.

\`\`\`go
var ErrNotFound = errors.New("not found") // sentinel
type ValidationError struct { Field string } // custom type
\`\`\`

Errors returned from a function are conventionally named \`err\` in the caller. Avoid variants like \`e\`, \`error\` (shadows the type), or \`exception\`.

### Test Function Names

Go test functions follow \`TestXxx(t *testing.T)\`. Subtests use \`t.Run("description", ...)\`. Do not use \`TestUser_Create_Success\` style with underscores to simulate hierarchy. Use subtests.

\`\`\`go
func TestUser(t *testing.T) {
    t.Run("Create succeeds with valid input", func(t *testing.T) { ... })
    t.Run("Create fails on invalid email", func(t *testing.T) { ... })
}
\`\`\`

The go-test tooling treats subtests as first-class. \`go test -run 'TestUser/Create_succeeds'\` runs exactly that subtest. Underscore-hierarchy in the top-level name breaks this.

### Staff Lens: The Naming Lint

Most naming conventions can be enforced by \`golangci-lint\` with the right linters enabled: \`revive\`, \`stylecheck\`, \`predeclared\`, \`stutter\`. Turn them on. Configure them to match the team's style. The machine catches 90% of violations, and the review time saved per year is measurable. The remaining 10% (semantic naming choices the linter cannot judge) is where the review discipline matters. Do not spend reviewer attention on \`userId\` vs \`userID\`. Spend it on whether \`ProcessUserData\` is the right name for a function that only sends an email.

### Principal Lens: Domain Names Survive Refactors

Names grounded in the domain survive refactors. Names grounded in the implementation do not. A function called \`RedisGetUser\` will be misnamed the day the team moves to DynamoDB. \`GetUser\` survives. A struct called \`PostgresConnection\` has to be renamed when a second database is added. \`DatabaseConnection\` or \`Connection\` with the database identified by configuration survives. The principal-level discipline is to look at every proposed name and ask: will this still be right in three years? If it encodes a current implementation detail, rename before it ships. Renaming an exported name after the fact is a coordinated migration across callers. Getting it right the first time costs nothing.

---
`;
