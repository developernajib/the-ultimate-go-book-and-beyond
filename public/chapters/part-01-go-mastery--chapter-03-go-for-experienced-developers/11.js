export default `## 3.10 Interview Questions

These questions target engineers moving to Go from another language. Interviewers at FAANG and Go-first shops (Cloudflare, Uber, Stripe, MongoDB, HashiCorp) use them to check whether you have internalized Go's design, not just its syntax.

> **What FAANG actually tests here**: whether you can translate your existing mental model accurately, recognize the patterns that do and do not port across, and articulate tradeoffs without sliding into "my old language did this better" defensiveness.

### Q1: Contrast Go's interfaces with Java's, and explain why the Go design scales better for large codebases.

**What FAANG expects**: a clear statement of structural versus nominal typing, the practical consequence (define interfaces at the consumer), and a concrete example of how this reduces coupling. Strong candidates mention accept-interfaces-return-structs as a convention.

**Answer**: Go interfaces are satisfied structurally. Any type with the required method set implements the interface, with no \`implements\` keyword and no declaration linking the two. Java interfaces are nominal. A class must explicitly declare that it implements an interface, and the dependency points from the implementer to the abstraction. The practical difference shows up at architecture scale. In Go, you define an interface in the package that consumes it, and any existing type with matching methods satisfies it for free. This means packages can depend on abstractions they define locally, without forcing producers to import interface definitions, which inverts the usual dependency arrow. The convention "accept interfaces, return structs" falls out of this. Returning concrete types gives callers the full API, while accepting interfaces lets callers substitute fakes in tests and alternative implementations in production.

\`\`\`go
// package storage defines the interface it needs
package storage

type Reader interface {
    Read(key string) ([]byte, error)
}

func Load(r Reader, key string) ([]byte, error) {
    return r.Read(key)
}

// package cache never imports storage and never declares intent to satisfy Reader
package cache

type RedisCache struct{ ... }
func (c *RedisCache) Read(key string) ([]byte, error) { ... }
\`\`\`

**Follow-ups**:
- What is the cost of structural typing at compile time, and how does the Go compiler handle method-set checking efficiently?
- When would you prefer a nominal system like Java's?
- How does Go's approach interact with mocking frameworks?

### Q2: Explain the typed-nil pitfall with interfaces and how to avoid it in production code.

**What FAANG expects**: an accurate model of interface as a (type, value) pair, the exact reason the comparison fails, and a coding rule that prevents the bug. This is one of the most-cited Go gotchas in senior interviews.

**Answer**: An interface value in Go is a two-word structure, one word for the dynamic type, one word for the value. The interface equals nil only when both words are nil. Returning a typed nil pointer through an interface return type ships a non-nil interface whose value happens to be nil. Downstream \`if err != nil\` checks then pass when the caller expects them to fail.

\`\`\`go
type MyError struct{}
func (e *MyError) Error() string { return "boom" }

func doWork() error {
    var e *MyError  // typed nil
    return e        // interface is (*MyError, nil), NOT nil
}

if err := doWork(); err != nil {
    // this branch runs even though the underlying pointer is nil
}
\`\`\`

The defense is a project-wide rule. Never return a typed error variable. Return \`nil\` explicitly on the success path. \`go vet\` catches many cases through its \`nilness\` analyzer, and in code review a returned \`*MyError\` through an \`error\` slot is a red flag.

**Follow-ups**:
- How does this interact with \`errors.Is\` and \`errors.As\`?
- Can you construct the same bug with a non-error interface, for example \`io.Reader\`?
- Why did the Go team keep this behavior instead of making typed nil equal to nil?

### Q3: Compare Go's error model to Java checked exceptions and Python try/except. Where does each win?

**What FAANG expects**: an honest tradeoff analysis, not advocacy. Interviewers want candidates who can name specific scenarios where Go's explicit errors help or hurt versus exceptions.

**Answer**: Java checked exceptions encode the failure contract in the type system and force the caller to either handle or declare. They prevent the "I forgot this could throw" class of bugs, but they propagate verbosely across layer boundaries and encourage engineers to wrap everything in \`throws Exception\` to escape the paperwork, which defeats the purpose. Python exceptions are unchecked, concise, and ergonomic, but control flow is invisible at the call site, and teams rely on code review plus runtime tests to catch missing handlers. Go returns errors as values. Every failure is visible on the page, the call graph for errors matches the call graph for normal control flow, and \`errors.Is\` plus \`errors.As\` give you typed handling when you need it. The cost is vertical space and a pattern that repeats at every call site. Go wins when reviewability and explicit failure handling are the priority, which is the profile of most infrastructure and backend systems. Exceptions win when the failure is genuinely exceptional and layered handling is rare, which is the profile of most application code in a Rails or Django service.

**Follow-ups**:
- When would \`panic\` be appropriate in Go, and how is that different from throwing an exception?
- How does \`errors.Join\` change the story for parallel work like \`errgroup\`?
- Show how you would convert a panic in a goroutine into a propagated error without crashing the process.

### Q4: Walk me through goroutines versus OS threads at the scheduler level.

**What FAANG expects**: the G-M-P model, work stealing, what happens during blocking syscalls, and why the numbers differ by orders of magnitude. Hand-wavy "goroutines are lightweight" fails senior bar.

**Answer**: The Go scheduler is an M:N scheduler where many goroutines (G) run on M OS threads through P logical processors. Each P holds a local run queue of goroutines, plus a global queue exists as a fallback. When an M with a P runs out of work, it steals half the goroutines from a random other P's queue. When a goroutine blocks on a syscall, the scheduler detaches the P from the blocked M, spawns or reuses another M to pair with that P, and keeps running other goroutines. The numerical gap comes from three places. Goroutine stacks start at 2 KB and grow by copy-and-adjust, versus the 1 to 2 MB default for OS thread stacks. Goroutine creation is a function call plus a small runtime allocation, around 200 nanoseconds, versus microseconds for a thread plus syscall. Context switches between goroutines are user-space register swaps, versus a kernel mode transition for OS threads. That is why a single Go process can hold a million concurrent goroutines where a Java service would fall over at tens of thousands of threads.

**Follow-ups**:
- What is the sysmon goroutine and when does it preempt?
- How did Go 1.14 asynchronous preemption change the story from the earlier cooperative model?
- Describe a pathological pattern that defeats the scheduler.

### Q5: Explain Go's composition-over-inheritance model with a concrete migration story from Java.

**What FAANG expects**: real design thinking, not just "use embedding." Interviewers look for the ability to translate a class hierarchy into idiomatic Go without forcing the old shape.

**Answer**: Java class hierarchies usually encode two things at once. A data shape, and a set of virtual methods. In Go you split those. Data shapes become structs, behavior becomes interfaces, and reuse happens through embedding. Consider a Java \`HttpClient\` with \`AuthenticatedHttpClient extends HttpClient\` and a \`LoggingHttpClient extends AuthenticatedHttpClient\`. In Go, define one \`Client\` interface with the methods callers care about. Build a \`baseClient\` struct with core HTTP logic. Build \`authClient\` that embeds \`baseClient\` and adds auth headers. Build \`loggingClient\` that takes a \`Client\` and wraps it. This is the decorator pattern, not a hierarchy. Each piece is testable in isolation, composition is explicit at construction time, and you never get stuck because a new behavior does not fit the inherited chain. The phrase "favor composition over inheritance" is a Java-era motto. In Go it is the only option, and after a few months you stop missing hierarchies.

**Follow-ups**:
- How does method promotion work when you embed a struct, and what are the ambiguity rules?
- When would you still reach for interface composition (\`interface { io.Reader. io.Closer }\`)?
- What breaks if you try to translate an abstract base class with protected state directly to Go?

### Q6: How do Go modules handle versioning and the diamond dependency problem?

**What FAANG expects**: accurate understanding of semantic import versioning, minimum version selection (MVS), and how this differs from npm or Maven. A bonus is understanding replace directives and workspace mode.

**Answer**: Go modules use minimum version selection. Given a module graph, the build picks the lowest version of each dependency that satisfies all transitive requirements. This is the opposite of npm's "latest that satisfies the range," and it is deterministic by design. A diamond resolves to the highest minimum anyone asks for, never higher. Major versions follow semantic import versioning. \`v2\` and above require a \`/v2\` suffix in the import path, so \`v1\` and \`v2\` of the same module are distinct import paths that can coexist in one binary, which defuses the classic Scala or Python binary compatibility break. \`go.mod\` records the module's own version requirements, \`go.sum\` pins content hashes for every resolved module plus its go.mod, and \`go mod tidy\` keeps them honest. The \`replace\` directive lets you swap a dependency for a local path or a fork, which is the standard workflow during active multi-module work. Go 1.18 introduced workspace mode, \`go.work\`, which lets you develop across several modules locally without pushing \`replace\` directives into shared \`go.mod\` files.

**Follow-ups**:
- Why does Go prefer minimum versions over latest? What failure mode does that prevent?
- How does the Go proxy (\`proxy.golang.org\`) and checksum database (\`sum.golang.org\`) protect against supply-chain attacks?
- When would you use \`go.work\` versus a monorepo with \`replace\`?

### Q7: What Go anti-patterns do developers coming from other languages most often import, and how do you correct them in review?

**What FAANG expects**: a senior lens from reviewing real migration PRs, not a blog-post checklist. Interviewers use this as a values check.

**Answer**: Five show up constantly. First, over-interfacing at the producer. Python or Java converts often define one interface per type "in case we need to mock later," which is noise. The Go convention is to define interfaces where they are consumed. Second, \`context.Context\` stashed inside structs or globals. \`context\` should flow as a first argument through every call chain that does I/O. Embedding it in a struct hides cancellation. Third, exception-style error swallowing, where engineers translate \`try { ... } catch (Exception e) {}\` into \`_, _ = f()\` because the boilerplate feels the same. That silently drops production errors. Fourth, goroutine leaks from a \`go f()\` without a cancellation path. A goroutine that reads from a channel with no writer, or waits on a syscall with no timeout, holds resources forever. Fifth, using channels where a mutex is simpler. "Share memory by communicating" is idiomatic advice, not dogma. Guarding a counter with \`sync.Mutex\` plus \`sync.Once\` is usually the right call, and channels are for coordination across goroutine lifetimes, not for replacing locks.

**Follow-ups**:
- How would you review a PR that wraps every method call in \`if err != nil { return fmt.Errorf(...) }\`? When is the wrap adding signal?
- Walk me through detecting a goroutine leak in a running production service.
- When does \`sync.Mutex\` genuinely beat a channel-based solution, and can you name a case where the opposite is true?

### Q8: Walk me through how you would migrate a Java microservice to Go, end to end.

**What FAANG expects**: a structured plan with sequencing, risk management, and the ability to articulate when not to migrate. This is the question that separates engineers who have done a real migration from those who have only read about one.

**Answer**: Start with the question of whether to migrate at all. A Java service that hits 100 RPS with no operational pain has no migration ROI. The right candidates are services with active pain (memory pressure on the JVM, slow cold starts, tuning fatigue, deployment-image bloat) where Go would specifically address the pain. Once the candidate is chosen, plan the migration in three phases. Phase one is the strangler-fig setup. Stand the new Go service alongside the Java one, route a small percentage of traffic to it, and verify behaviour parity through dual-read or dual-write patterns depending on the service shape. Phase two is the cutover. Move traffic incrementally, with a clear rollback plan and dashboards that compare Go and Java behaviour side by side. Phase three is the decommissioning. Delete the Java code, delete the dual-write paths, simplify the deployment surface. The discipline that makes the difference is sequencing the phases so that each one ships value independently. A multi-quarter "cut over to Go in one shot" plan loses sponsorship before it ships. Smaller, individually shippable phases compound into the migration.

The technical work is the easier half. The harder half is the operational work. The team needs Go runbooks, Go on-call procedures, Go tooling in the deployment pipeline, and Go expertise distributed across enough engineers that on-call rotation works. Plan for the dual-language window, where the team owns both stacks simultaneously. The window is the highest-risk part of the migration and it is the part that most plans underestimate.

**Follow-ups**:
- How do you decide what level of behavioural parity is required between the Java and Go versions? Is byte-identical output the bar?
- What is your strategy for services that share libraries with the rest of the Java codebase?
- How do you handle the case where Go is the right choice for the new service but the team has no Go-fluent engineers?

### Q9: How would you design the package structure for a 50-service Go monorepo?

**What FAANG expects**: a structured answer that addresses team boundaries, public-vs-internal API surface, build performance, and the interaction with Go's module system. This is a senior-track architecture question.

**Answer**: Three principles. First, each team owns one or more top-level directories under a clear team-named root. The team-named root is not a Go-language construct, it is a social one, but it is the lever that makes ownership visible without a separate config file. Second, every team's private code lives under their team's \`internal/\` directory, which Go enforces at compile time by preventing imports from outside the parent module. Public APIs live in a \`pkg/\` or \`api/\` subdirectory and have explicit deprecation policies. Third, executables live under \`cmd/<servicename>/main.go\`, with each service in its own subdirectory so the CI system can enumerate and build them independently.

The hard question is whether the monorepo is one Go module or many. One module is simpler to reason about (one \`go.mod\`, one \`go.sum\`, one MVS resolution), but it forces all teams onto the same dependency versions, which is a coordination cost that grows with team count. Many modules give teams independent dependency cadences but require Go workspaces (\`go.work\`) for cross-module development, and the dependency graph can become hard to reason about. The 2026 default for new monorepos is one module unless there is a specific reason for many. The exception is when distinct teams have distinct release cadences for libraries they expose to other teams, in which case those libraries become separate modules.

The build-performance question matters at scale. \`go build ./...\` on a million-line monorepo is slow without remote build caching, and the Go toolchain does not have a built-in remote cache. Bazel with \`rules_go\` is the standard answer for Go monorepos that need remote build caching, with the cost that the team has to maintain Bazel rules in addition to \`go.mod\`.

**Follow-ups**:
- When does a multi-module monorepo become unmanageable, and what is the migration path back to one module?
- How do you handle a library that is consumed by many services and needs to be versioned independently?
- What CI strategies make Go monorepo builds fast enough for an engineer to iterate?

### Q10: How do you choose between \`panic\`, returning an error, and using \`log.Fatal\`?

**What FAANG expects**: a clear decision rule, not a list of cases. The candidate should articulate the underlying principle that distinguishes the three.

**Answer**: The underlying question is "who is the right entity to handle this failure?". \`panic\` says "this is unrecoverable in this code path, the caller decides whether to recover". \`log.Fatal\` (or \`os.Exit(1)\`) says "this is unrecoverable for the entire process, the operator decides whether to restart". Returning an \`error\` says "this is potentially recoverable, the caller has enough context to decide".

Concretely, return errors for anything that the caller might handle, which is the vast majority of failure paths. Use \`panic\` for programmer-error (impossible cases, invariant violations) and for \`Must...\`-style helpers where the documented contract is "if this fails, your program is broken". Use \`log.Fatal\` only at startup in \`main\`, where the only sensible response to a configuration or initialisation failure is to exit and let the orchestrator (Kubernetes, systemd) handle the restart.

The one rule that is always wrong: never use \`log.Fatal\` inside a library function. \`log.Fatal\` calls \`os.Exit(1)\` after logging, which bypasses every \`defer\`, every cleanup handler, and every test that expects to assert on the error. Library functions return errors. Period.

**Follow-ups**:
- What does \`log.Fatal\` do that \`panic\` does not, and when does that matter?
- Why does the standard library use \`panic\` in \`regexp.MustCompile\` but not in \`regexp.Compile\`?
- How does \`recover()\` interact with deferred functions, and what happens if you recover from a panic that started in another goroutine?

---
`;
