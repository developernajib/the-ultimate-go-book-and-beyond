export default `## Go for Experienced Developers Quick Reference Card

Experienced developers from Python, Java, or TypeScript backgrounds encounter Go's steepest friction at the conceptual boundaries: no inheritance, no exceptions, no implicit interface implementation, and no null-safety via types. This card maps those familiar constructs directly to their Go equivalents so you spend time building rather than translating. Pay particular attention to the "Common Gotchas" section. The nil interface versus nil pointer distinction and slice aliasing behavior are the two bugs that most frequently surprise engineers coming from languages with reference semantics or optional types.

\`\`\`
┌─────────────────────────────────────────────────────────────────────────────────┐
│                GO FOR EXPERIENCED DEVELOPERS QUICK REFERENCE                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  SYNTAX TRANSLATIONS:                                                           │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  Python                    │  Go                                        │   │
│  ├────────────────────────────┼────────────────────────────────────────────┤   │
│  │  class User:               │  type User struct {                        │   │
│  │      def __init__(name):   │      Name string                           │   │
│  │          self.name = name  │  }                                         │   │
│  │  users = []                │  users := []User{}                         │   │
│  │  users.append(user)        │  users = append(users, user)               │   │
│  │  for i, v in enumerate:    │  for i, v := range slice {}                │   │
│  │  try/except                │  if err != nil { return err }              │   │
│  │  with open() as f:         │  f, _ := os.Open(); defer f.Close()        │   │
│  └────────────────────────────┴────────────────────────────────────────────┘   │
│                                                                                 │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  Java                      │  Go                                        │   │
│  ├────────────────────────────┼────────────────────────────────────────────┤   │
│  │  class implements Intf     │  type implements interface implicitly      │   │
│  │  extends BaseClass         │  embed struct (composition)                │   │
│  │  null                      │  nil                                       │   │
│  │  new ArrayList<>()         │  make([]Type, 0)                          │   │
│  │  synchronized              │  sync.Mutex or channels                    │   │
│  │  Thread                    │  go func() { }()                           │   │
│  │  Optional<T>               │  (value, bool) or *T                       │   │
│  │  getter/setter             │  exported fields (capitalized)             │   │
│  └────────────────────────────┴────────────────────────────────────────────┘   │
│                                                                                 │
│  COMMON GOTCHAS FOR EXPERIENCED DEVS:                                           │
│  ├── Generics added in Go 1.18 (syntax: [T any], [T comparable])              │
│  ├── Nil interface != nil pointer (check both value and type)                  │
│  ├── Slices share underlying arrays (copy for isolation)                       │
│  ├── Maps are not goroutine-safe (use sync.Map or mutex)                      │
│  ├── defer evaluates args immediately, executes on return                      │
│  ├── Loop variable capture fixed in Go 1.22+                                   │
│  ├── No constructors, use New functions (NewServer)                           │
│  └── Errors are values, not exceptions (check err != nil)                     │
│                                                                                 │
│  IDIOMATIC GO PATTERNS:                                                         │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  // Error handling - always check                                        │   │
│  │  f, err := os.Open(path)                                                 │   │
│  │  if err != nil {                                                          │   │
│  │      return fmt.Errorf("open %s: %w", path, err)                         │   │
│  │  }                                                                        │   │
│  │  defer f.Close()                                                          │   │
│  │                                                                           │   │
│  │  // Accept interfaces, return structs                                    │   │
│  │  func Process(r io.Reader) (*Result, error)                              │   │
│  │                                                                           │   │
│  │  // Zero value should be usable                                          │   │
│  │  var buf bytes.Buffer  // Ready to use, no init needed                   │   │
│  │                                                                           │   │
│  │  // Use embedding for composition                                        │   │
│  │  type Server struct {                                                     │   │
│  │      *http.Server  // Embedded, gains all methods                        │   │
│  │      config Config                                                        │   │
│  │  }                                                                        │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  NAMING CONVENTIONS:                                                            │
│  ├── Exported:      UserService, GetByID (capitalized)                         │
│  ├── Unexported:    userService, getByID (lowercase)                           │
│  ├── Interfaces:    Reader, Writer, Stringer (verb + er)                       │
│  ├── Single method: Closer (interface), not ICloseable                         │
│  ├── Packages:      lowercase, no underscores (httputil not http_util)        │
│  ├── Acronyms:      URL, HTTP, ID (all caps in names: userID, parseURL)       │
│  └── Receivers:     Short (1-2 letters): func (s *Server) Start()             │
│                                                                                 │
│  CONCURRENCY ESSENTIALS:                                                        │
│  ├── Goroutine:     go func() { }()                                            │
│  ├── Channel:       ch := make(chan int)  // Unbuffered, blocks               │
│  ├── Buffered:      ch := make(chan int, 10)  // Non-blocking until full      │
│  ├── Select:        Multiplexes channel operations                             │
│  ├── WaitGroup:     Waits for goroutines to finish                            │
│  ├── Mutex:         sync.Mutex for shared state                                │
│  └── Context:       Cancellation, timeouts, request-scoped values             │
│                                                                                 │
│  TESTING PATTERNS:                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │  func TestAdd(t *testing.T) {                                            │   │
│  │      got := Add(2, 3)                                                     │   │
│  │      want := 5                                                            │   │
│  │      if got != want {                                                     │   │
│  │          t.Errorf("Add(2,3) = %d; want %d", got, want)                   │   │
│  │      }                                                                    │   │
│  │  }                                                                        │   │
│  │                                                                           │   │
│  │  // Table-driven tests                                                    │   │
│  │  tests := []struct{ a, b, want int }{                                    │   │
│  │      {2, 3, 5}, {0, 0, 0}, {-1, 1, 0},                                   │   │
│  │  }                                                                        │   │
│  │  for _, tc := range tests {                                              │   │
│  │      t.Run(fmt.Sprintf("%d+%d", tc.a, tc.b), func(t *testing.T) {...})  │   │
│  │  }                                                                        │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                 │
│  PROJECT STRUCTURE:                                                             │
│  ├── main.go         Entry point (package main)                                │
│  ├── internal/       Private packages                                          │
│  ├── pkg/            Public packages                                           │
│  ├── cmd/app/        Multiple binaries                                         │
│  └── _test.go        Tests live alongside code                                 │
│                                                                                 │
│  TOOL COMMANDS:                                                                 │
│  ├── go build:       Compile                                                   │
│  ├── go test:        Run tests                                                 │
│  ├── go fmt:         Format code                                               │
│  ├── go vet:         Static analysis                                           │
│  ├── go mod tidy:    Clean up dependencies                                     │
│  └── go generate:    Run code generators                                       │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### Senior-Track Quick Reference Additions

The card above covers the syntax and idioms. The senior-track additions below are the architectural and review-time guidance that the card cannot fit in ASCII boxes.

\`\`\`
┌─────────────────────────────────────────────────────────────────────────────────┐
│                  SENIOR-TRACK GO REVIEW CHEATSHEET (2026)                       │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  CODE-REVIEW RED FLAGS:                                                         │
│  ├── interface{} or any as parameter type without a clear API boundary         │
│  ├── init() doing runtime configuration (move to New... + main)                │
│  ├── Mixed value and pointer receivers on the same type                        │
│  ├── Public struct with public mutable field on a domain type                  │
│  ├── Goroutine with no cancellation path (no ctx, no done channel)             │
│  ├── Error wrapped with %v when caller might want errors.Is or errors.As       │
│  ├── New direct dependency without justification in PR description             │
│  ├── log.Fatal inside a library function                                       │
│  ├── time.Time compared with == (use .Equal())                                 │
│  └── Sentinel error compared with == (use errors.Is)                           │
│                                                                                 │
│  ERROR-HANDLING DISCIPLINE:                                                     │
│  ├── Wrap with %w when caller might inspect (errors.Is, errors.As)             │
│  ├── Wrap with %v when error is human-facing only                              │
│  ├── Wrap once per meaningful boundary (not every line)                        │
│  ├── Sentinel for named, stable failure modes (var ErrNotFound = ...)          │
│  ├── Typed for failures with structured data (type ValidationError struct)     │
│  ├── Opaque for everything else (callers should not branch)                    │
│  └── Never include sensitive data in error messages                            │
│                                                                                 │
│  CONCURRENCY DISCIPLINE:                                                        │
│  ├── Every goroutine must have a cancellation path                             │
│  ├── ctx is the first parameter, named ctx, never stored in a struct           │
│  ├── Long-running loops check ctx.Done() in select                              │
│  ├── Use errgroup.Group for fan-out with shared error                           │
│  ├── Use sync.Mutex for shared state, channels for coordination                 │
│  └── Never copy a struct that contains a sync.Mutex                             │
│                                                                                 │
│  PACKAGE-LAYOUT DISCIPLINE:                                                     │
│  ├── Each team owns one or more directories under internal/                    │
│  ├── Public APIs in pkg/ with explicit deprecation policy                      │
│  ├── Executables in cmd/<servicename>/main.go                                  │
│  ├── No util or common packages (find the right home for each type)            │
│  ├── Interfaces defined in the consuming package                                │
│  └── Accept interfaces, return structs                                         │
│                                                                                 │
│  GO-VERSION CURRENCY (2026):                                                    │
│  ├── 1.21+: log/slog, slices, maps, min/max builtins                            │
│  ├── 1.22+: per-iteration loop variables, range over int                       │
│  ├── 1.23+: range over function (iter.Seq), maps.Keys returns iter             │
│  ├── 1.24+: tool directive, GOAUTH for private proxies                         │
│  └── 1.26+: latest stable as of Q1 2026                                        │
│                                                                                 │
│  MIGRATION DECISION RULES:                                                      │
│  ├── Migrate I/O-bound services first (biggest goroutine win)                  │
│  ├── Do not migrate services that work (no operational pain)                   │
│  ├── Sequence migrations to deliver value early                                │
│  ├── Plan for the dual-language window (double on-call burden)                 │
│  └── Stop the migration if it loses sponsorship                                │
│                                                                                 │
│  ONBOARDING DISCIPLINE:                                                         │
│  ├── Day 1: env setup, hello world, type the contact book                      │
│  ├── Day 2: extend with persistence and tests                                  │
│  ├── Day 3-4: read team's PRs, ship first small PR                             │
│  ├── Week 2: concurrency, errors, tooling, ship real change                    │
│  └── Week 3: design note for small feature                                     │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
\`\`\`

The card above is intended to be printed and stuck on a whiteboard above the desk of a team that is migrating to Go. It is the condensed version of the discipline this chapter has been arguing for, and it is what survives when a senior engineer leaves the team and the next senior engineer needs to know what the team's conventions are without reading every chapter of this book.

---
`;
