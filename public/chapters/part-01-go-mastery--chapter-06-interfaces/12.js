export default `## 6.11 Interview Questions

Interface questions dominate Go interviews at Google, Uber, Cloudflare, and other Go-heavy shops. Interviewers use them to check whether you understand structural typing, can recognize the nil-interface bug from code, and know the conventions that keep large Go codebases maintainable.

> **What FAANG actually tests here**: whether you design interfaces where they are consumed, keep them small, understand the (type, value) representation that causes typed-nil surprises, and can contrast structural typing tradeoffs against nominal systems honestly.

### Question 1: How do Go interfaces differ from Java/C# interfaces?

**What FAANG expects**: structural versus nominal typing, the consequence of defining interfaces at the consumer, and the "accept interfaces, return structs" convention. Bonus: method-set rules for pointer vs value types.

**Answer:**

Go interfaces are implicitly satisfied, no \`implements\` keyword. Any type with matching methods satisfies the interface:

\`\`\`go
type Writer interface {
    Write([]byte) (int, error)
}

// No declaration needed - if it has Write, it's a Writer
type MyBuffer struct{}
func (b *MyBuffer) Write(p []byte) (int, error) { return len(p), nil }

var w Writer = &MyBuffer{} // Works!
\`\`\`

Benefits:
- Decoupled packages (no import dependencies)
- Retroactive interface satisfaction
- Easier testing/mocking
- Promotes small interfaces

**Follow-ups**:
- What is an "interface type" versus an "interface value" in the Go spec?
- Why do Go style guides favor one- and two-method interfaces (io.Reader, io.Writer) over large interfaces?

### Question 2: Explain the nil interface gotcha

**What FAANG expects**: a mental model of the interface as a (type, value) two-word pair, the ability to predict \`err == nil\` behavior from code, and a coding rule that prevents the bug (return \`nil\` explicitly on success paths).

**Answer:**

An interface has two components: (type, value). It's nil only when both are nil:

\`\`\`go
type MyError struct{}
func (e *MyError) Error() string { return "error" }

func example() error {
    var err *MyError = nil
    return err // Returns (*MyError, nil) - NOT nil!
}

err := example()
fmt.Println(err == nil) // false!
\`\`\`

Solution: Return untyped nil explicitly:

\`\`\`go
func example() error {
    return nil // Returns (nil, nil) - truly nil
}
\`\`\`

**Follow-ups**:
- How does \`go vet\`'s nilness analyzer detect this pattern?
- What does \`reflect.ValueOf(err).IsNil()\` return in the gotcha case, and why?

### Question 3: When should you use empty interface vs generics?

**What FAANG expects**: honest tradeoffs, awareness that \`any\` boxes values (heap allocation), and knowledge that generics use GC-shape stenciling to avoid boxing. Interviewers check that you do not reach for generics reflexively when \`any\` is genuinely the right call.

**Answer:**

**Use \`any\`/\`interface{}\` when:**
- Working with truly heterogeneous data (JSON parsing)
- Interfacing with reflection-based APIs
- Building general-purpose containers (pre-Go 1.18)

**Use generics when:**
- You need type safety with flexibility
- The operation is the same regardless of type
- You want compile-time type checking

\`\`\`go
// Generics: type-safe, compile-time checked
func Map[T, U any](items []T, fn func(T) U) []U {
    result := make([]U, len(items))
    for i, item := range items {
        result[i] = fn(item)
    }
    return result
}

// Empty interface: loses type info
func MapAny(items []any, fn func(any) any) []any {
    // Must do runtime type assertions
}
\`\`\`

**Follow-ups**:
- Why does passing a value into an \`any\` parameter typically force a heap allocation?
- What does GC-shape stenciling mean, and why doesn't it give full monomorphization like C++ templates?

### Question 4: What is the "accept interfaces, return structs" principle?

**What FAANG expects**: why this is idiomatic Go (callers get the full API, tests can substitute fakes, packages stay decoupled), and the exceptions (constructors that genuinely need to return a single abstract handle).

**Answer:**

Functions should accept interface parameters (flexibility) but return concrete types (clarity):

\`\`\`go
// GOOD
func Copy(dst io.Writer, src io.Reader) error // Accepts interfaces
func NewServer(addr string) *Server           // Returns concrete

// BAD (usually)
func NewWriter() io.Writer // Hides implementation
\`\`\`

Rationale:
- Callers can pass any compatible type
- Callers know exactly what they get back
- Implementation details visible when needed

**Follow-ups**:
- When does returning an interface still make sense? (hint: factory functions across backends, \`database/sql.Open\`)
- Why is over-interfacing on the producer side an anti-pattern in Go?

### Question 5: How would you design a plugin system using interfaces?

**What FAANG expects**: a core interface with lifecycle methods, plus optional "capability" interfaces probed via type assertion. This pattern is how the Go standard library (\`io.ReaderFrom\`, \`http.Hijacker\`, \`http.Flusher\`) and most serious Go frameworks extend types without breaking them.

**Answer:** Define a core \`Plugin\` interface with lifecycle methods, then use optional interfaces checked via type assertion for capabilities not all plugins share. A \`Manager\` iterates over registered plugins and probes each one for optional interfaces at runtime.

\`\`\`go
// Core plugin interface
type Plugin interface {
    Name() string
    Init(config map[string]any) error
    Start(ctx context.Context) error
    Stop(ctx context.Context) error
}

// Optional capabilities
type Healthchecker interface {
    HealthCheck(ctx context.Context) error
}

type MetricsProvider interface {
    Metrics() map[string]float64
}

// Plugin manager
type Manager struct {
    plugins []Plugin
}

func (m *Manager) Register(p Plugin) {
    m.plugins = append(m.plugins, p)
}

func (m *Manager) HealthCheck(ctx context.Context) error {
    for _, p := range m.plugins {
        // Check if plugin supports health checking
        if hc, ok := p.(Healthchecker); ok {
            if err := hc.HealthCheck(ctx); err != nil {
                return fmt.Errorf("plugin %s unhealthy: %w", p.Name(), err)
            }
        }
    }
    return nil
}
\`\`\`

**Follow-ups**:
- How does \`http.ResponseWriter\` use this pattern with \`http.Hijacker\` and \`http.Flusher\`?
- What is the cost of repeated type assertions in a hot path, and how do you avoid it?

### Q (Senior track): How would you design the interface boundary between a service layer and its persistence layer?

**What FAANG expects**: a concrete design that demonstrates the "accept interfaces, return structs" rule, interface segregation, and testability.

**Answer**: The service layer defines the interface. The persistence layer implements it. The interface lists only the methods the service actually calls, not everything the persistence implementation could do. If the service calls \`GetByID\`, \`Save\`, and \`Delete\`, the interface has exactly those three methods, not the fifteen methods the repository struct supports.

The service accepts the interface as a constructor parameter, not a concrete type. This lets tests substitute a fake implementation. For the concrete wiring in \`main\`, the service takes the real repository, which satisfies the interface because its method set is a superset of the interface's.

The persistence layer returns concrete types, not interfaces. A \`PostgresUserRepo\` returns \`*User\`, not \`UserReader\`. The caller gets full access to \`*User\`'s method set. If the caller wants to treat it as an interface, that is the caller's choice.

This shape gives you testability (fake the repository interface), swappability (swap the Postgres implementation for a test double or an alternative backend), and loose coupling (the service does not import the persistence package).

**Follow-ups**:
- What happens when the service layer needs a method the current interface does not include?
- How do you handle transactions across multiple repository methods?

### Q (Senior track): How do you decide whether an interface is too big?

**What FAANG expects**: a concrete rule and the reasoning behind it, not "small is good".

**Answer**: Two tests. First, the usage test: if no single caller uses all the methods, the interface is probably too big. Second, the fake test: if writing a test double feels like overhead, the interface is too big.

Specific numerical thresholds are less useful than the usage pattern. A three-method interface where callers use one method at a time is too big. A ten-method interface where every caller uses all ten is fine. The composition of small interfaces (\`io.ReadWriter = io.Reader + io.Writer\`) is the idiomatic fix for cases where one caller needs multiple capabilities: split into small interfaces and compose, rather than one big interface.

The other indicator is evolution. Adding a method to an interface breaks every implementation. A small interface evolves slowly because the contract is narrow. A big interface evolves fast because there are more reasons to change it. If the team is frequently breaking implementations by adding interface methods, the interface is too big.

**Follow-ups**:
- How would you refactor a 15-method \`UserRepository\` interface?
- What is the cost of splitting an interface into two, and when is the cost worth it?

### Q (Staff track): You need to add a method to a shared interface used by 12 teams. Walk through the rollout.

**What FAANG expects at staff**: you treat the interface as a wire protocol, you never force a coordinated deploy, and you can articulate the tradeoffs between in-place evolution and a parallel interface.

**Answer**: Two options, chosen by coupling risk.

**Option A, parallel interface (preferred for widely-used interfaces).** Create \`CacheV2\` that embeds \`Cache\` and adds the new method. Implementers upgrade at their own pace. Callers that need the new method take \`CacheV2\`. Existing callers stay on \`Cache\`. When \`CacheV2\` adoption reaches a threshold (often 80 percent), open a deprecation window on \`Cache\`, migrate stragglers, remove \`Cache\`. Total elapsed time: one to three quarters.

**Option B, in-place addition with default.** Add the method to \`Cache\`. Every implementer must add it before the interface change merges. For interfaces with three or four implementers owned by two or three teams, this is tractable. For a platform interface with 40 implementers across 12 teams, it is not. The rough rule: if you cannot name every implementer in 30 seconds, do not do in-place addition.

**Migration mechanics**: add the new method behind a \`WithStats(cache Cache) CacheWithStats\` adapter that provides a no-op default for implementers that have not yet upgraded. This lets callers start using the new interface immediately without blocking on every implementer. Remove the adapter when adoption is complete.

**What staff interviewers listen for**: do you mention deprecation, backward compatibility, the blast radius of the change, and the coordinated-migration cost? Do you distinguish between interfaces with three implementers and interfaces with 40? A candidate who says "just add the method" has never maintained a shared interface at scale.

### Q (Staff track): When would you reject an interface-driven design in favor of a different abstraction?

**What FAANG expects**: you know that interfaces are the default seam but not the only one, and you can name the alternatives.

**Answer**: Three situations.

1. **When the seam needs to be a process boundary, not a function call.** An interface gives in-process polymorphism. If the fault-isolation or scaling story needs a separate process, the correct abstraction is RPC (gRPC, HTTP), not an interface. The interface version gives you the testability benefit but misses the isolation benefit.
2. **When the extension points are data-driven rather than behaviour-driven.** A workflow engine where steps are described by configuration, not code, is better modelled as a data structure interpreted by a single engine than as an interface implemented by many step types. The interface version creates one type per step, which does not scale past a dozen.
3. **When the caller needs to manipulate the value structurally (serialize it, hash it, diff it).** An interface hides the data. Serialization or structural comparison requires access to fields. Concrete types or a struct-with-discriminator pattern is a better fit.

**Follow-ups**:
- Give a concrete example where you moved a design from interface-based to a different abstraction.
- How do you persuade a team that has converged on "interfaces everywhere" to use concrete types when the design calls for it?

---
`;
