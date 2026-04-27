export default `# Interview Questions

These questions mirror patterns from FAANG and top-tier Go interviews. Work through them after reading the chapter.

### Q1: What are zero values in Go, and why does the language guarantee them?

**What FAANG expects**: Name the zero values per kind and explain the safety and performance implications.

**Answer**: Every type in Go has a well-defined zero value that the runtime assigns when a variable is declared without an initializer. Numeric types are 0, booleans are false, strings are "", pointers, interfaces, slices, maps, channels, and function values are nil, and structs are a struct whose fields are each their own zero value. Arrays are an array of zero values with the declared length.

The guarantee matters for two reasons. First, it eliminates the class of bugs caused by reading uninitialized memory that plagues C and C++. Second, it lets library authors design types so the zero value is directly useful, as \`sync.Mutex\`, \`bytes.Buffer\`, and \`strings.Builder\` all demonstrate. You can declare \`var mu sync.Mutex\` and call \`mu.Lock()\` without any constructor.

The cost is that allocation implies zeroing. For hot paths that allocate large structs, this shows up in profiles as \`runtime.memclrNoHeapPointers\`. Pooling with \`sync.Pool\` or reusing buffers is the standard mitigation.

**Follow-ups**:
- What is the zero value of an interface variable, and why does that differ from a nil pointer wrapped in an interface?
- How would you design a type whose zero value is unusable, and why might that be a mistake?

### Q2: Explain Go's multiple return values. When is a named return appropriate?

**What FAANG expects**: Distinguish the mechanics from the idioms, and call out when named returns help or hurt.

**Answer**: Go functions can return any number of values. The calling convention passes return slots on the stack (or in registers under the register-based ABI introduced in 1.17 and refined since), so multiple returns are not a tuple allocation. The canonical pattern is \`(value, error)\`, and the compiler enforces that unused returns are either assigned or explicitly discarded with \`_\`.

Named returns declare variables in the function signature, pre-initialized to their zero values, and a bare \`return\` returns them. They are appropriate in three cases. First, when a deferred function needs to observe or modify the return value, for example to wrap an error or record a metric. Second, for documentation value on complex signatures where the name clarifies intent. Third, in short functions where the name avoids a trivial intermediate variable.

They hurt when the function is long, because the named variables feel like regular locals and shadowing bugs become easy. They also hurt when \`return\` without arguments hides what is actually being returned at the call site.

**Follow-ups**:
- Show how a deferred function can convert a panic into a returned error using named returns.
- What happens if you assign to a named return and then \`return explicitValue\`?

### Q3: Compare \`var x = 5\`, \`var x int = 5\`, and \`x := 5\`. When must you use each?

**What FAANG expects**: Correct scoping rules and knowledge of where short declaration is illegal.

**Answer**: All three produce an \`int\` named \`x\` with value 5. \`var x int = 5\` is explicit about the type and legal at package scope and function scope. \`var x = 5\` infers the type from the expression and is also legal at both scopes. \`x := 5\` is the short variable declaration, legal only inside functions, and it both declares and assigns in one token.

You must use \`var\` at package scope because \`:=\` is forbidden there. You must use the explicit type form when the inferred type is wrong, for example \`var x int64 = 5\` when you need 64 bits regardless of platform, or when declaring a variable without an initializer so there is no expression to infer from.

Short declaration has a subtle rule that trips people up. In \`a, b := f()\`, at least one of \`a\` or \`b\` must be new in the current scope. The others are reassigned. This is what allows the common \`if err := ...; err != nil\` pattern to coexist with earlier \`err\` variables, but it is also the mechanism behind shadowing bugs.

**Follow-ups**:
- Why does \`:=\` require at least one new variable on the left?
- What does \`go vet\` detect about short declarations, and what does it miss?

### Q4: What is variable shadowing in Go, and how do you prevent the classic error-shadowing bug?

**What FAANG expects**: Concrete example, detection tooling, and a coding discipline.

**Answer**: Shadowing occurs when a new variable in an inner scope reuses the name of a variable in an outer scope. The inner variable hides the outer for the duration of the inner scope. Go's block-scoping plus \`:=\` makes this easy to do accidentally.

The classic bug:

\`\`\`go
func load(id string) error {
    data, err := fetch(id)
    if err != nil {
        return err
    }
    if cond {
        data, err := transform(data)
        if err != nil {
            return err
        }
        _ = data
    }
    return err
}
\`\`\`

Inside the \`if\`, \`data, err := transform(data)\` creates new \`data\` and \`err\` because both names are on the left and the block is a new scope. The outer \`err\` is never updated, so the function returns stale state.

Prevention rests on three habits. Use \`=\` instead of \`:=\` when you intend to reuse existing variables. Run \`go vet -vettool=\$(which shadow)\` or equivalent linter passes in CI. Keep functions small enough that shadowing is visually obvious. Generics and closures amplify the risk, so extra scrutiny in those areas pays off.

**Follow-ups**:
- Why did the Go team not make shadowing an error by default?
- How does the for-range loop variable change in Go 1.22 affect shadowing reasoning?

### Q5: What are composite literals, and what is the difference between \`&T{}\`, \`new(T)\`, and \`T{}\`?

**What FAANG expects**: Precise semantics and knowledge of escape analysis implications.

**Answer**: A composite literal constructs a value of a struct, array, slice, or map type in place, for example \`Point{X: 1, Y: 2}\`, \`[]int{1, 2, 3}\`, or \`map[string]int{"a": 1}\`. The field-name form is the norm for structs because positional literals break when the struct grows.

\`T{}\` produces a value of type \`T\` with all fields at their zero or specified values. \`&T{}\` produces \`*T\` by taking the address of the composite literal, which is a language-level shortcut for declaring a local and taking its address. \`new(T)\` allocates a zeroed \`T\` and returns \`*T\`, but it cannot set fields, so it is strictly less flexible than \`&T{}\`. Idiomatic Go prefers \`&T{}\` whenever any field needs a non-zero value and often even when none do.

Whether the allocation lands on the heap or the stack is decided by escape analysis, not by which syntax you used. If the pointer escapes the function, all three forms heap-allocate. If it does not, all three can stack-allocate. \`go build -gcflags=-m\` shows the decision.

**Follow-ups**:
- When would you prefer \`new(T)\` over \`&T{}\` in real code?
- How do composite literals interact with unexported fields in another package?

### Q6: What changed about \`for\` loops in Go 1.22, and why did it matter?

**What FAANG expects**: correct mechanics plus awareness that this was one of the rare breaking semantic changes and that older code is still in the wild.

**Answer**: Go 1.22 changed two things. First, loop variables declared in the \`for\` clause are now scoped to each iteration rather than shared across iterations. Second, \`for i := range n\` is legal where \`n\` is an integer, yielding 0..n-1 without needing \`for i := 0; i < n; i++\`.

The per-iteration scoping change fixed a class of long-standing bugs. Before 1.22, this code leaked the same \`i\` to every goroutine:

\`\`\`go
for i := 0; i < 5; i++ {
    go func() { fmt.Println(i) }() // prints 5 five times, usually
}
\`\`\`

The 2026 form prints 0 through 4 in some order because each goroutine captures its own copy of \`i\`. The cost is that any code relying on the old shared-variable semantics quietly breaks. The \`GODEBUG=loopvar=0\` knob exists for very old code, and \`go vet\` warns on suspicious patterns.

The \`range int\` addition is smaller but pleasant. \`for i := range 10 { ... }\` reads like Python's \`range(10)\` and avoids the off-by-one that hand-written \`<\` comparisons occasionally invite.

**Follow-ups**:
- How does the compiler achieve per-iteration scoping without a runtime hit?
- Why did the Go team accept a breaking change here after a decade of refusing them for the Go 1 compatibility promise?
- What does \`GODEBUG=loopvar\` do in Go 1.21 vs 1.22+?

### Q7: What are range-over-func iterators (Go 1.23), and when should you reach for one?

**What FAANG expects**: understand the three iterator signatures (\`iter.Seq\`, \`iter.Seq2\`, and the push-style \`yield\` function), and name a realistic use case beyond toy examples.

**Answer**: Go 1.23 extended \`range\` to support iterator functions. A function of type \`func(yield func(V) bool)\` can be ranged over directly. Returning \`false\` from \`yield\` cancels iteration, so the producer can release resources.

\`\`\`go
func Lines(r io.Reader) iter.Seq[string] {
    return func(yield func(string) bool) {
        s := bufio.NewScanner(r)
        for s.Scan() {
            if !yield(s.Text()) {
                return
            }
        }
    }
}

for line := range Lines(file) {
    if strings.HasPrefix(line, "FATAL") {
        process(line)
    }
}
\`\`\`

Reach for iterators when the producer owns resources that need cleanup (file handles, database cursors, streaming APIs), when the consumer may want to stop early without materializing the whole sequence, or when you want the ergonomics of \`range\` over a transformation pipeline (\`maps.Keys\`, \`slices.Values\`, custom filters) without allocating an intermediate slice. The standard library was rewritten in 1.23 to expose many helpers as \`iter.Seq\` rather than slice-returning functions for exactly this reason.

Avoid iterators for small, bounded sequences where a slice is simpler, and for code that will be read by engineers unfamiliar with the pattern. Push-style iterators have subtle correctness requirements (you cannot yield after returning false, and the scanner above had to respect yield's return).

**Follow-ups**:
- What is \`iter.Seq2\` and when do you need two values per yield?
- Why is \`yield\` a function rather than a channel?
- Compare push iterators in Go 1.23 to generators in Python or C#. What trade-offs did the Go team make differently?

### Q8: What does \`append\` do, and when does it produce a slice that aliases its input?

**What FAANG expects**: a precise mental model of slice headers and capacity growth, and the ability to predict aliasing without running the code.

**Answer**: \`append(s, x...)\` returns a slice. If \`len(s) + len(x) <= cap(s)\`, the elements are written into the existing backing array and the returned slice header points to the same array as \`s\`, so \`s\` and the returned value alias. If the result would exceed \`cap(s)\`, the runtime allocates a new array, copies the existing elements, and returns a slice header pointing to the new array, so the input and the result no longer alias.

The growth policy doubles capacity for small slices and grows by roughly 25% above a threshold around 256 elements, which has shifted across Go versions. Pre-allocating with \`make([]T, 0, knownSize)\` avoids the geometric copy chain when the final size is known.

The aliasing behaviour is the source of nearly every "I do not understand what just happened" slice bug in Go. The defensive idioms are to clone with \`slices.Clone(s)\` when you need an independent copy, to never write to a slice argument unless the function's contract documents that it may mutate, and to never return a sub-slice of an internal buffer without making the contract explicit at the boundary.

**Follow-ups**:
- Show a 5-line program where two slices unexpectedly share storage and a write through one is visible through the other.
- What does \`s = s[:0]\` free, and what does it not?
- How do \`slices.Clip\`, \`slices.Grow\`, and \`slices.Clone\` differ?

### Q9: Explain value receivers vs pointer receivers. Which should you default to, and why does mixing them matter?

**What FAANG expects**: the interface-satisfaction consequences and a justifiable default.

**Answer**: A method with a value receiver \`func (t T) M()\` operates on a copy of \`t\`. A method with a pointer receiver \`func (t *T) M()\` operates on the original through a pointer. Pointer receivers can mutate the value and avoid copying for large structs. Value receivers cannot mutate (the change is to a copy that is discarded) and they keep the value semantics intact.

Mixing receiver types on the same type breaks interface satisfaction in a non-obvious way. The method set of \`T\` includes value-receiver methods only. The method set of \`*T\` includes both. So a type with mixed receivers will satisfy an interface from a \`*T\` value but not from a \`T\` value, and the failure shows up at compile time with errors that read as inscrutable until you have seen the rule.

The default for any non-trivial type is pointer receivers. Three reasons. First, consistency is easier to maintain than to retrofit. Second, pointer receivers avoid copies that get expensive as the type grows. Third, mutation, embedded mutexes, and methods that need to set fields all force pointer receivers, and mixed-receiver types are a code smell. The exceptions are small immutable value types (\`Point\`, \`Time\`, \`Currency\`) where value semantics are a feature, not an oversight.

**Follow-ups**:
- What happens when you copy a struct that contains a \`sync.Mutex\`?
- Why is \`time.Time\` a value-receiver type and \`os.File\` a pointer-receiver type?
- How does receiver type interact with \`go vet\`'s \`copylocks\` analyser?

### Q10: When should you use \`panic\`, and when must you not?

**What FAANG expects**: the three legitimate uses and a clear "do not use it for normal errors" stance with reasoning.

**Answer**: \`panic\` is correct in three narrow cases. First, unrecoverable invariant violations during program startup, typically wrapped in \`Must...\` helpers like \`template.Must\` or \`regexp.MustCompile\`, where failure means the program is meaningless. Second, programmer-error that should never happen in a correct program (impossible switch defaults, indices that the surrounding logic guarantees are in range), where crashing loud is better than continuing in an undefined state. Third, tightly-scoped recovery in code generation, parser combinators, or recursive routines where a panic-and-recover pair is an intentional optimisation, with a clear \`defer recover()\` at the API boundary that converts the panic back into an error before it escapes.

For everything else, return \`error\`. A library that panics on normal failures is a library that the next code review will remove from the dependency list. The reason is composability. A caller that has to defend against a library panicking has to wrap every call in \`defer recover()\`, which is verbose, error-prone, and silently catches panics that should have crashed.

**Follow-ups**:
- What is the difference between \`panic\` and \`runtime.Goexit\`?
- How does \`recover\` behave outside a deferred function?
- Why does the Go runtime panic on a nil-map write but only return an error on a nil-channel send (in some conditions)?

### Q11 (Senior track): How would you design the error contract for a public Go package?

**What FAANG expects**: a coherent answer covering sentinel vs typed errors, wrapping discipline, stability across versions, and observability impact.

**Answer**: Three decisions. First, what callers are allowed to branch on. Sentinel errors (\`var ErrNotFound = errors.New("not found")\`) for named, stable failure modes that callers commonly handle. Typed errors (\`type ValidationError struct { Field, Reason string }\`) for failures where callers need data, not just identity. Opaque errors (wrapped with context but no exported sentinel or type) for everything else, signalling that callers should not branch.

Second, wrapping discipline. Use \`%w\` at every layer that adds context, use \`%v\` only for human-facing messages where inspectability does not matter. Wrap once per meaningful boundary (package, subsystem, transaction), not at every line. Document at the package level that callers can use \`errors.Is(err, ErrFoo)\` and \`errors.As(err, &target)\` to inspect.

Third, stability. The set of exported error sentinels and types is part of the package's public API and changes to them are breaking changes. Adding a new wrapped error at a deeper layer is not breaking, because the existing \`errors.Is\` and \`errors.As\` checks continue to work. Removing a sentinel or changing the type of a typed error is breaking. The discipline is the same as for any other API surface: additive changes are safe, removals require a major version bump.

The observability angle matters too. Error messages are shipped, indexed, and retained. They must not leak credentials, PII, or other sensitive data. The team's logging discipline and error-wrapping discipline have to be designed together, not bolted on after a security review.

**Follow-ups**:
- How would you handle errors that should be retried vs errors that should not?
- What is \`errors.Join\` (Go 1.20+) and when does it help?
- How do you communicate error semantics to consumers who read your package's documentation but not its source?

### Q12 (Senior track): Walk me through the design of an onboarding programme for a Python-fluent engineer joining a Go team.

**What FAANG expects**: a concrete plan, not a list of links, with a defensible week-by-week structure and an answer to "what do they ship by the end of week one?".

**Answer**: Week one builds syntax fluency and a working dev environment. Day one is \`go install\`, \`gopls\` in their editor, \`go mod init\`, hello world, and the contact book from Chapter 2 typed by hand. Day two is the same contact book extended with persistence and a unit test, deliverable end-of-day. Day three is reading three real PRs on the team's main repository, with a senior engineer pair-reviewing the comments. Day four is the engineer's first PR against a tiny team-owned package, scoped so the diff is under 50 lines. Day five is retro plus the second PR.

Week two introduces concurrency, errors, and the team's tooling. Goroutines, channels, \`select\`, the team's preferred error-wrapping discipline, the team's structured-logging conventions, the CI pipeline, the deployment story. Deliverable end-of-week is a shipped change to a real service, scoped to be reversible.

Week three introduces system design and the team's architecture. Service map, data flow, the team's principal-engineer-approved patterns, the things the team has tried and rejected. Deliverable is a one-page design note for a small feature.

The structural lesson is that fluency is a week-one problem and engineering judgment is a multi-month problem. Confusing the two and giving an architecture deck on day one is the most common onboarding failure mode at the senior-hire level. The contact book is the right shape for day-two practice precisely because it is small enough to internalise and rich enough to teach the layer of the stack a Go service touches.

**Follow-ups**:
- How do you adjust this for an engineer coming from Java? From Rust?
- What metrics tell you the onboarding is working?
- How do you handle an engineer who is fluent in Go on day one but unfamiliar with your team's domain?
`;
