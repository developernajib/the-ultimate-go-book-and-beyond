export default `## 1.9 Interview Questions

These questions appear in real FAANG screens for backend, infrastructure, and platform roles. The answer shape matters as much as the content. Interviewers score for clarity of reasoning, knowledge of tradeoffs, and the ability to map a language choice to concrete production concerns.

> **What FAANG actually tests here**: the "Why Go?" line of questioning is rarely about trivia. It probes whether you can reason about language design under production constraints (team size, compilation, operational complexity, concurrency model) and whether you know the shape of the ecosystem you claim to work in.

### Q1: Why did Google create Go?

**What FAANG expects**: a crisp answer that names the concrete engineering pains (build time, dependency sprawl, onboarding friction, concurrency primitives) and ties each to a Go design decision. Candidates who recite "Go is fast and simple" without connecting cause and effect usually score below bar.

**Answer**: Go was started at Google in 2007 because large C++ services hit four compounding problems. Build times stretched into hours as header dependencies fanned out. The concurrency model (threads plus shared memory with locks) produced hard-to-reproduce bugs at Google's scale. Dependency management through header files and build systems was fragile. New engineers took months to navigate multi-million-line codebases because every team invented its own idioms. Rob Pike, Robert Griesemer, and Ken Thompson designed Go to attack each pain directly. Fast dependency-aware compilation (sub-second on million-line trees), goroutines and channels as first-class primitives, an explicit module system, and a deliberately small language spec with gofmt enforcement so that code written in Tokyo reads the same as code written in Berlin.

**Follow-ups**:
- If Go is so good for large teams, why did Google also invest in Dart and Carbon?
- Which of these original pain points do you think Go has solved versus traded for new problems?
- Name a design choice you disagree with, and explain what you would change.

### Q2: Explain goroutines and how they differ from OS threads.

**What FAANG expects**: you can describe the M:N scheduler (G, M, P), give concrete numbers for stack size and scheduling cost, and know when goroutines still hurt (blocking syscalls, GOMAXPROCS misconfiguration, goroutine leaks). Hand-wavy "goroutines are lightweight threads" answers fail at senior bar.

**Answer**: A goroutine is a user-space coroutine scheduled by the Go runtime onto OS threads. Each goroutine starts with a small stack (2 KB in modern Go, grown and shrunk on demand) versus 1 to 2 MB for an OS thread, so memory overhead is roughly three orders of magnitude lower. The runtime scheduler is M:N: M machine threads back P logical processors, and any runnable goroutine G can run on any M holding a P. Goroutine creation is a function call plus a small runtime allocation, roughly 100 to 200 nanoseconds, compared to microseconds for thread creation and a full OS context switch. When a goroutine blocks on a syscall, the scheduler parks the M, hands the P to another M, and keeps other goroutines running. This is why a Go service can hold a million open connections on a single host without thread-per-connection costs killing it.

**Follow-ups**:
- What is work stealing in the Go scheduler, and when does it help?
- How does GOMAXPROCS interact with container CPU limits before and after Go 1.25?
- Give one failure mode where goroutines hurt more than threads.

### Q3: Why does Go insist on explicit \`if err != nil\` everywhere?

**What FAANG expects**: you can defend the design on readability and composition grounds, acknowledge the ergonomic cost honestly, and describe the modern error-wrapping idioms (\`errors.Is\`, \`errors.As\`, \`%w\`). Reciting "explicit is better than implicit" without mentioning the tradeoffs reads as dogma.

**Answer**: Go treats errors as values rather than control-flow constructs. Each function call that can fail returns an error alongside the result, and the caller must decide what to do. The payoff is that every error path is visible on the page, so reviewers can see exactly where failure propagates, where it is swallowed, and where it is wrapped with context. Exception-based languages hide that flow graph behind implicit unwinding, which makes it easy to forget a rollback or skip a resource cleanup. The cost is vertical space and boilerplate, which Go addresses partially through \`errors.Is\` and \`errors.As\` for typed checks, \`fmt.Errorf("...: %w", err)\` for wrapping, and \`errors.Join\` for combining errors from parallel work. The cost is real, but in production incidents the ability to grep for every error return and reason about the failure graph has saved more debugging hours than the typing costs.

**Follow-ups**:
- Walk me through wrapping an error with \`%w\` and later recovering the original type with \`errors.As\`.
- When would \`panic\` be the right tool instead of returning an error?
- What new error-handling proposals has the Go team considered and rejected, and why?

### Q4: Why did Go ship without generics for 13 years, and what changed in 1.18?

**What FAANG expects**: historical awareness (the CLU-style proposal, contract-based proposals, the 2020 type-parameters design) plus pragmatic understanding of what generics solved and what they did not. Candidates who say "Go was dumb to skip generics" usually haven't read the design history.

**Answer**: The Go team explicitly traded type-parameter expressiveness for compilation speed, language simplicity, and a clean implementation. Several proposals were attempted (contracts, runtime-dispatch generics, various template shapes) and rejected because they either exploded the language spec or broke the fast-compile invariant. Go 1.18 (March 2022) shipped type parameters with interface-typed constraints, using a hybrid implementation called GC shape stenciling. This gives you generic containers and algorithms without either the code bloat of C++ templates or the boxing costs of Java erasure. Generics handled the headline use cases (containers, functional helpers, database-row mappers) but were deliberately not extended to method type parameters or higher-kinded types, which keeps the spec small. Go 1.26 (February 2026) adds self-referential generic types, making recursive shapes like \`type Node[T any] struct { Left, Right *Node[T] }\` express cleanly.

**Follow-ups**:
- Explain GC shape stenciling versus full monomorphization.
- Why can't Go methods have their own type parameters, and what would break if they could?
- Show a real case where you reached for generics and regretted it.

### Q5: \`make\` versus \`new\`, and why the distinction matters.

**What FAANG expects**: you can say what each returns, when each is required, and why slices, maps, and channels need \`make\`. Bonus points for connecting this to zero-value semantics and the header-plus-backing-array model of slices.

**Answer**: \`new(T)\` allocates zeroed memory for a value of type T and returns a pointer \`*T\`. \`make\` initializes the internal runtime structure for a slice, map, or channel and returns the value (not a pointer). The distinction exists because slices, maps, and channels have a header plus backing storage that the runtime must initialize. A zero-value slice header (\`nil\`) points at no backing array, so \`append\` works but indexing panics. A zero-value map is a read-only nil map where writes panic. A zero-value channel blocks forever on send and receive. \`make\` is the only way to get these types into a usable state with the right capacity or buffer size. Use \`new\` when you need a pointer to a zeroed struct or numeric value, though in practice most Go code writes \`&T{}\` for that.

\`\`\`go
p := new(int)                 // *int, points to 0
s := make([]int, 0, 10)       // slice with cap 10, len 0
m := make(map[string]int)     // writable empty map
ch := make(chan int, 10)      // buffered channel of capacity 10
\`\`\`

**Follow-ups**:
- What does \`append\` do when you hit the slice's capacity?
- Why does iterating a nil map work but writing to it panic?
- When should you preallocate a map with \`make(map[K]V, hint)\`?

### Q6: How does Go compile a ten-million-line codebase in under a minute?

**What FAANG expects**: you can describe the package-at-a-time compilation model, the lack of header files, the import-as-interface rule, and the build cache. Strong candidates connect this to the language's deliberate spec minimalism.

**Answer**: Three design decisions combine to give Go its compile speed. First, every package compiles once and emits a binary export file describing its exported API. Dependents read that export file instead of re-parsing source, so compilation time scales with the package graph, not with transitive source size. Second, imports must form a DAG. Circular imports are a compile error, which lets the compiler topologically sort packages and parallelize independent subtrees. Third, the language spec is deliberately small. No template metaprogramming, no preprocessor, no overload resolution, no implicit conversions. Every one of those costs compile time elsewhere. On top of this, \`go build\` caches compiled packages by content hash, so incremental builds touch only what changed. A million-line Go service typically rebuilds in seconds after a one-file edit.

**Follow-ups**:
- Where does \`go build\` keep its cache, and what invalidates entries?
- How does the compiler handle generics without slowing down incremental builds?
- What is profile-guided optimization (PGO) and when does it pay off in build cost?

### Q7: Walk me through Go's approach to memory management.

**What FAANG expects**: you can explain the concurrent tricolor GC, escape analysis, the stack-versus-heap decision, and how the Green Tea GC in Go 1.26 changes the picture. Candidates should know that Go does not offer manual allocation controls the way Rust does, and articulate why that is usually fine.

**Answer**: Go uses a concurrent, non-moving, tricolor mark-sweep garbage collector. Most of the GC runs concurrently with the application, with short stop-the-world pauses typically under a millisecond even on heaps in the tens of gigabytes. The compiler performs escape analysis at compile time and keeps variables on the goroutine stack whenever the analyzer can prove they do not outlive the calling frame. This is why short-lived temporaries cost effectively nothing, and why passing small values rather than pointers is often the allocation-efficient choice in Go. Stacks themselves grow and shrink automatically. In Go 1.25 the Green Tea collector was introduced as an experiment, improving locality and CPU scalability during marking. Go 1.26 made Green Tea the default, typically yielding 10 to 40 percent lower GC overhead on allocation-heavy workloads. Container-aware GOMAXPROCS (1.25) also means the runtime respects cgroup CPU limits by default, which removes a whole category of pathological behavior in Kubernetes.

**Follow-ups**:
- What does \`GOGC=off\` do, and when would you ship a service with it?
- How do you detect and fix excessive heap allocation in a hot path?
- What escape-analysis pattern has bitten you in production?

### Q8: When would you pick Python, Rust, or Java over Go?

**What FAANG expects**: senior engineers recognize that Go is a good default but not a universal answer. Interviewers want concrete tradeoffs, not tribal advocacy.

**Answer**: Pick Python for data science, notebook-driven analysis, ML training, and short glue scripts where developer iteration speed dwarfs runtime cost. The ecosystem (NumPy, PyTorch, pandas) has no equivalent in Go. Pick Rust when you need predictable latency with no GC pauses, zero-cost abstractions, or memory safety for a low-level component (kernel modules, browser engines, cryptography primitives, embedded firmware). The ownership model is an investment but pays back in services that cannot tolerate GC jitter. Pick Java or Kotlin when you are inside a large JVM ecosystem (Netflix's Spring stack, most investment banks, Android) or when you need mature async frameworks like Project Loom's virtual threads with decades of JIT-optimized library code. Pick Go for network services, CLI tools, infrastructure daemons, and anywhere team-size matters more than peak per-core throughput. The rule of thumb is that Go wins when your bottleneck is team cognitive load and operational simplicity, and loses when your bottleneck is either raw numerics (Python with C extensions) or microsecond-tier latency (Rust, C++).

**Follow-ups**:
- You're given a green-field trading system targeting p99 under 100 microseconds. What do you pick and why?
- You inherit a Python monolith doing 50 million requests per day and causing ops pain. Rewrite in Go or refactor in place?
- Name a situation where Go was chosen and should not have been.

### Q9: What are the most common Go anti-patterns that fail code review at FAANG?

**What FAANG expects**: a senior-flavored answer that comes from reviewing real code, not blog-post checklists. Interviewers use this to separate candidates who have shipped Go from those who have only studied it.

**Answer**: Five recur constantly. First, goroutine leaks where a worker is started without a cancellation path, usually because someone forgot to plumb a \`context.Context\` through. Second, unchecked errors from \`defer\`-ed calls like \`defer f.Close()\` on a writer, which silently drops errors that should propagate. Third, \`sync.Mutex\` guarding one field in a struct that has other unguarded fields accessed from the same goroutines, creating subtle races. Fourth, using channels when a mutex would be simpler. Channels are powerful but allocate, involve the scheduler, and are overkill for "protect this counter" situations. The adage from the Go team is "share memory by communicating, but also, use a mutex when it fits." Fifth, over-reliance on \`interface{}\` or \`any\` in places where generics would preserve type safety. Each of these is a common line in a production postmortem, and interviewers know that.

**Follow-ups**:
- Show me how you would detect a goroutine leak in a running service.
- When is \`errgroup\` the right tool over a raw \`sync.WaitGroup\` plus error channel?
- Why is \`time.After\` in a \`select\` inside a loop a memory-leak hazard before Go 1.23?

### Junior → FAANG Track: Entry-Level Questions You Will Actually Get

The nine questions above are the full senior-bar set. For a phone screen, a coding screen, or an early-career on-site, interviewers open with simpler questions that still sort candidates hard by whether they have actually written Go or have only read about it. Treat these as the floor, not the ceiling.

#### Q10: What does \`go mod init\` do, and what is the role of \`go.mod\` and \`go.sum\`?

**What FAANG expects (phone screen)**: you have typed \`go mod init\` into a terminal in your life. The single biggest junior failure here is describing modules from a Stack Overflow answer without having used them.

**Answer**: \`go mod init <module-path>\` creates a \`go.mod\` file that declares the module identity (typically \`github.com/user/project\`) and the minimum Go version required. Every subsequent \`go get\` or \`go build\` records dependencies in \`go.mod\`. The \`go.sum\` file records content hashes of every module version your module transitively depends on, which the toolchain verifies on every build: if someone rewrote a module version on the server, your build breaks with a checksum mismatch. The two files together let you reproduce any past build exactly, and both should be committed to version control.

**Follow-ups**:
- What is \`go mod tidy\` for?
- If \`go.sum\` has entries you don't use, is that a problem?
- What does \`replace\` do in \`go.mod\`, and when have you needed it?

#### Q11: What is the difference between \`len()\` and \`cap()\` on a slice?

**What FAANG expects**: you know that slices are a \`{pointer, len, cap}\` header referring to a backing array. Candidates who answer "len is length, cap is capacity" without explaining the backing-array model have not internalized slices.

**Answer**: \`len(s)\` is the number of elements you can index (\`s[0]\` through \`s[len(s)-1]\`). \`cap(s)\` is the size of the backing array from the current offset; it is how much \`append\` can add before the slice must reallocate. When \`append\` exceeds cap, the runtime allocates a new backing array (typically 2x the old cap for small slices, 1.25x for larger), copies elements over, and returns the new slice. The \`len\` / \`cap\` distinction matters for performance: \`make([]T, 0, 100)\` when you know the final size avoids repeated reallocations in a hot append loop.

**Follow-ups**:
- If \`a := []int{1,2,3}\` and \`b := a[1:2]\`, what is \`cap(b)\`?
- Why can \`append\` mutate a slice you did not expect to change?
- When would you use \`slices.Clip\` or \`slices.Clone\`?

#### Q12: What does \`defer\` do, and when is it executed?

**What FAANG expects**: you know that deferred calls run in LIFO order when the enclosing function returns (including on panic), and that argument evaluation happens at the defer statement, not at call time. Missing either of those is a junior tell.

**Answer**: \`defer\` schedules a function call to run when the enclosing function exits: either normally or via panic. Multiple defers run in last-in-first-out order. The arguments to the deferred call are evaluated at the \`defer\` statement, so \`defer fmt.Println(i)\` captures the current value of \`i\`, not the value at function exit. This is the idiom for cleanup (\`defer f.Close()\`, \`defer mu.Unlock()\`, \`defer tx.Rollback()\`) and it works correctly on panic, which is why Go's crash-safety story is livable.

\`\`\`go
func example() {
    i := 1
    defer fmt.Println(i)  // prints 1 (value captured now)
    defer func() { fmt.Println(i) }()  // prints 2 (closure reads final value)
    i = 2
}
// Output: 2, then 1 (LIFO)
\`\`\`

**Follow-ups**:
- What is the performance cost of defer? When would you avoid it?
- How does \`recover()\` work, and why must it be called from a deferred function?
- Can you defer a method call on a nil pointer?

#### Q13: What is a \`context.Context\` and when do you use it?

**What FAANG expects**: you know that context carries cancellation signals, deadlines, and request-scoped values across API boundaries, and that every long-running or cancellable function should accept a \`ctx context.Context\` as its first argument. This is probably the single most-tested topic after goroutines.

**Answer**: \`context.Context\` is a carrier for three things: cancellation signal (so a caller can tell a goroutine "stop, I no longer need your result"), deadline (so every downstream call inherits the same timeout budget), and request-scoped values (trace IDs, auth principal, though these should be typed carefully). The canonical idiom is that every exported function that does I/O, starts a goroutine, or makes network calls takes \`ctx context.Context\` as its first parameter and passes it down. HTTP handlers get a context from \`r.Context()\` that is cancelled when the client disconnects; gRPC handlers get one that is cancelled when the caller times out. The context is the backbone of Go's end-to-end cancellation story: without it, a cancelled HTTP request would still run its full database query and waste resources.

**Follow-ups**:
- What's the difference between \`context.WithCancel\`, \`context.WithTimeout\`, and \`context.WithDeadline\`?
- Why is it bad to store a context in a struct field?
- What is \`context.WithCancelCause\`, and when have you needed it?

#### Q14: Explain the difference between buffered and unbuffered channels.

**What FAANG expects**: you know that send/receive on an unbuffered channel is a synchronous rendezvous, while a buffered channel decouples sender and receiver up to its capacity. You can also name a concrete use case for each.

**Answer**: \`make(chan int)\` creates an unbuffered channel. A send blocks until a receiver is ready, and vice versa: this is a synchronization point, useful for enforcing that "before goroutine B does X, goroutine A must have completed Y." \`make(chan int, 10)\` creates a buffered channel. Sends do not block until the buffer is full; receives do not block until the buffer is empty. Use buffered channels for pipelines, work queues, and situations where you want to smooth over short rate mismatches. Use unbuffered channels for handshakes and when you want backpressure to travel end-to-end.

**Follow-ups**:
- What happens if you send on a closed channel?
- What is the idiomatic way for a producer to signal "I'm done" to consumers?
- Can you receive from a nil channel? What happens?

#### Q15: Write the smallest complete Go program that prints "Hello, World!" and compiles with \`go run main.go\`.

**What FAANG expects**: you can write the whole file from muscle memory, including \`package main\`, the \`import\`, and \`func main()\`. Candidates who need to think about it have not written Go outside a tutorial.

**Answer**:
\`\`\`go
package main

import "fmt"

func main() {
    fmt.Println("Hello, World!")
}
\`\`\`

The likely follow-up: "now change it to read a name from stdin and greet that name." Then: "now run it concurrently for three hard-coded names using goroutines." These compound questions are how interviewers check that you can move through the basics fluidly rather than memorized-and-stuck.

**Follow-ups**:
- What happens if you change \`package main\` to \`package hello\`?
- What happens if you leave out the \`import "fmt"\`? Will the compiler explain the error helpfully?
- Why does \`go run\` produce a binary in a temp directory instead of the current one?

### Staff / Principal Track: Strategic and Architectural Questions

At staff-plus interview loops (Google L6+, Meta E6+, Uber staff, Stripe staff), the interview tests judgment on language adoption, team scaling, and org-level engineering strategy. The coding questions shrink; the design questions grow. A sampling:

#### Q16: Your organization has 300 engineers, a Python monolith that serves 80% of user-facing traffic, and three small Go services running infrastructure. The VP is asking you to recommend a direction: "Go everywhere" or "keep the Python monolith, Go for infrastructure only"? How do you decide?

**What FAANG expects**: a framework, not an opinion. The bad answer is "Go is better, rewrite everything." The good answer is a set of diagnostic questions whose answers determine the recommendation.

**Answer shape**: I would refuse to recommend without first collecting five pieces of data: (1) where are the actual operational incidents in the last year? If 80% of on-call pages trace to Python-specific issues (memory, GIL, dependency conflicts, cold starts), the rewrite case is strong; if they trace to infrastructure or data issues that are language-agnostic, rewriting the language solves the wrong problem. (2) What is the team's current Go experience, and what's the ramp-up cost? A 300-engineer org with three Go services probably has 15–30 engineers with production Go experience; the rest need training. (3) What is the modularity of the Python monolith? If it is already a modular monolith with clear service boundaries, incremental extraction to Go is viable; if it is a ball of mud, the rewrite is a two-year project regardless of language. (4) What is the business case? If the company is growing 3x per year and the monolith is a scaling bottleneck, the investment may be justified; if the company is mature, the rewrite is usually the wrong call. (5) What do the engineers who would do the work want? A rewrite imposed against team preference burns morale and ships late. My default recommendation, absent specific data: expand Go in the infrastructure layer, convert one service at a time on the user-facing edge starting with the highest-incident service, keep the Python monolith as the system of record for two-to-three years, and revisit the decision annually. The lesson from Twitter, Airbnb, and similar large rewrites is that "rewrite everything" almost always overshoots the actual pain.

**Follow-ups**:
- What metrics would you track to know the migration is succeeding?
- At what point would you declare the migration a failure and revert?
- How do you handle engineers who do not want to switch languages?

#### Q17: You are the first staff engineer on a new Go platform team. Your CTO wants to know in ninety days whether Go is the right language for the org's new data-plane product. What is your plan?

**What FAANG expects**: you treat this as a research project, not a coding project. You scope the investigation, define success criteria in advance, and produce a document the CTO can share with their peers. Candidates who answer "I'd just start coding" fail at staff bar.

**Answer shape**: I would spend week one defining the success criteria with the CTO: explicit numbers for latency tail, memory footprint, throughput, binary size, and engineer-productivity proxies like commits-per-engineer-per-week over the evaluation. Weeks two through six, build a realistic prototype of the critical path in Go, Rust, and whatever language the team is most familiar with today (call it language X). Identical benchmarks, identical load profiles, identical deployment environment. Weeks seven to ten, do an honest teardown of the three prototypes: measure, profile, interview the engineers who wrote each. Weeks eleven to thirteen, write the recommendation document with the data, the team's preferences, the hiring implications, and a clear "we recommend Go / Rust / language X for the following reasons, and the following reasons against." The document should be short enough that a director can read it in fifteen minutes. Then present it, answer objections, and commit to a decision with the CTO. The trap I would avoid: doing the prototype in Go first and getting anchored, then measuring Rust against a polished Go prototype. Build them in parallel, with the same engineer writing each where possible.

**Follow-ups**:
- How do you avoid the "all three prototypes are equally fine" outcome?
- What's the failure mode of this process, and how do you mitigate?
- How do you handle team members who are strongly advocating for one language before you start?

#### Q18: Your team has 20 Go engineers and is about to double. Describe the first three things you would standardize to scale the codebase to 40 engineers without losing coherence.

**What FAANG expects**: a short list of specific, concrete standardizations with rationale. Bad answers are abstract ("standardize style"). Good answers name specific tools, patterns, and artifacts.

**Answer shape**: First, a repo-wide \`.golangci.yml\` with the full lint config, enforced in CI as a blocking check. Without this, every team drifts to its own "near-gofmt" style, and code review hours bleed into style debates. Second, an engineering-wide error-handling guideline document that specifies: use \`errors.Is\` / \`errors.As\` for error comparison, wrap with \`%w\` at every layer that adds context, define a small number of sentinel errors (\`ErrNotFound\`, \`ErrUnauthorized\`) at the package boundary rather than per-package variants. Third, a service-template repo that new services are forked from, with the production-readiness checklist (logging, metrics, tracing, graceful shutdown, health checks, \`govulncheck\` CI) pre-wired. This single template decision eliminates the "every new service is someone's personal framework experiment" failure mode that kills scaling teams. If I had a fourth, I would add a short (two-page) internal Go style guide that describes the specific local conventions (package layout, naming, interface placement at consumer) so new hires have a single artifact to read during week one. The theme: standardization at doubling time is cheap, doing it at 4x team growth is painful and contested.

**Follow-ups**:
- How do you handle a team that resists the standard?
- What is your escalation if a tech lead ships a service that violates the template?
- Which of your standards would you relax if velocity visibly drops?

#### Q19: A senior engineer proposes introducing a dependency-injection framework (Wire) across all services. You think this is wrong for your team. How do you make the technical case?

**What FAANG expects**: you can push back on a peer's proposal technically, without politics, citing specific costs and proposing an alternative. The bad answer is "I'd escalate." The good answer engages the argument.

**Answer shape**: I would structure the pushback as three questions asked of the proposer, not as a counter-proposal to fight for. "What specific problem are we solving that constructor functions plus functional options don't solve today?" If the answer is "large graph of dependencies is tedious to wire by hand," I would note that Wire generates code at build time and the generated code is equivalent to what we would have written by hand, so the win is modest. "What is the onboarding cost for the next engineer hired?" Wire adds a concept, a code-generation step, and a debugging overhead when the generated code does not match intuition. "Are we going to enforce Wire everywhere, or is it optional?" Optional makes the codebase inconsistent (some services have Wire, some don't); enforcing it everywhere is a large migration. If at the end of those three questions the proposer still has a strong case (e.g., specific services where the dependency graph is so complex that manual wiring costs hours per change) then Wire might be justified in those services but not company-wide. The framing is "let's not solve a problem we don't have," delivered kindly. This kind of scoped, measured technical pushback is exactly the conversational pattern Go's community has developed over a decade around the "more abstractions, fewer abstractions" debate, and it is what senior reviewers at a FAANG-equivalent are looking for.

**Follow-ups**:
- What if the proposer is more senior than you and disagrees?
- What evidence would actually change your mind?
- When have you reversed your own position on a similar technical call?

### How to Actually Deliver These Answers

Reading the answers is not enough. Delivery is half the grade.

- **Open with the shape before the substance.** "Let me give you the 30-second version and then expand." Interviewers are scoring whether you can compress under pressure.
- **Name the tradeoff explicitly.** Every answer above names what is given up, not just what is gained. Candidates who present pure wins signal bias.
- **Commit to a position.** "It depends" is the worst answer. "In this scenario I would do X, with the specific risk of Y, and I would revisit if Z became true" is a senior answer.
- **Admit the edges of your knowledge.** "I know the broad shape of Go's scheduler but I have not read the M:N code paths recently" is better than bluffing. Interviewers test for intellectual honesty.
- **Use concrete numbers when you have them.** "Goroutines start at 2KB" beats "goroutines have smaller stacks than threads." Numbers signal that you have actually measured, not read.
- **Connect to production.** The best candidates routinely bridge "and the reason this matters operationally is ..." between a language fact and a production consequence. That is the senior signal.

---
`;
