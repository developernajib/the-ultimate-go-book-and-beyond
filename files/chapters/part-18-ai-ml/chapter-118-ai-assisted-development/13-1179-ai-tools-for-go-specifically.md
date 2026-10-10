## 118.9 AI Tools for Go Specifically

### Go-Specific Prompting Tips

Go has idioms that AI sometimes violates. Enforce them explicitly:

**For idiomatic error handling**:
```text
When writing Go code:
- Return errors, never panic (except main setup)
- Wrap errors with context: fmt.Errorf("doing X: %w", err)
- Use errors.Is for checking specific error types
- Never check err != nil after ignoring it with _
```
**For interfaces**:
```text
In Go, interfaces are satisfied implicitly. When defining interfaces:
- Define interfaces in the package that uses them (consumer-owned interfaces)
- Keep interfaces small (1-3 methods when possible)
- Name single-method interfaces with -er suffix (Reader, Writer, Stringer)
- Don't pre-emptively create interfaces for types with one implementation
```
**For concurrency**:
```text
When writing concurrent Go code:
- Use channels for communication, mutexes for protecting state
- Start with sync.Mutex/RWMutex before reaching for channels
- Always document which goroutine owns what data
- Every goroutine needs a way to be stopped (context or done channel)
- Use go test -race to verify concurrent code
```
### Getting AI to Follow Go Idioms

The most common AI Go anti-patterns and how to prompt against them:

**Over-engineering interfaces**:
```text
Do NOT create interfaces for everything. Only create an interface when:
1. Multiple implementations exist now
2. You need to mock for testing
3. The interface is defined in a different package from the implementation
```
**Java-style getters/setters**:
```text
Do NOT write getter/setter methods for struct fields.
Go prefers direct field access for simple types.
Methods should represent behavior, not field access.
```
**Unnecessary object-orientation**:
```text
Prefer functions over methods when the function doesn't need the struct's state.
Prefer composition over inheritance.
Prefer simple structs over complex class hierarchies.
```
**Exception-style error handling**:
```text
Do NOT use panic/recover as a substitute for error handling.
Panic is for programmer error: a violated invariant that means the program
is already in a state its author believed impossible. It is not for a
failed database call, a bad request, or a missing file.
Return errors. Always.
```
### AI for Go Performance Analysis

Use AI for initial performance analysis, then verify with profiling:

```text
Here is a hot path in our API that handles 10K requests/second.
The p99 latency is higher than expected (>100ms).

Identify potential performance issues:
[paste code]

Focus on:
1. Memory allocations (especially in loops)
2. Lock contention
3. Unnecessary copies of large structs
4. Unnecessary database round trips
5. Inefficient string operations

For each issue: describe the problem, estimate the impact, suggest the fix.
Note: I will profile before optimizing - I need a list of hypotheses to test.
```
**Using AI to interpret pprof output**:

```text
Here is pprof CPU profile output from our service under load:
[paste pprof text or flamegraph description]

Explain:
1. What function is consuming the most CPU
2. What the call chain suggests about why
3. What to look at in the code to understand and fix it
```
### AI + gopls Integration

`gopls` (the Go language server) provides real-time feedback that complements AI suggestions. The combination is powerful:

- `gopls` catches type errors, missing imports, and unused variables immediately, as you type
- AI catches (some) logic errors, security issues, and architectural problems, on demand

Configure both tools to work together:

```json
// VS Code settings.json for Go development
{
  "go.languageServerFlags": [
    "-rpc.trace"
  ],
  "gopls": {
    "staticcheck": true,
    "analyses": {
      "shadow": true,
      "unusedparams": true,
      "unusedwrite": true,
      "nilness": true
    }
  }
}
```
When using Cursor or VS Code with Copilot, both `gopls` and the AI assistant are active simultaneously. `gopls` will underline errors in AI-generated code in real-time, giving you immediate feedback on compilation and type errors before you even run the code.

---

### Junior → FAANG: Go-Specific AI Tool Integration as Language Mastery Evidence

The Go-specific prompting tips and tooling integrations in this section demonstrate that effective AI-assisted Go development requires actual Go knowledge, not just AI tool knowledge. Knowing to ask AI to use errors.Is instead of string comparison requires knowing why string comparison on errors is wrong in Go. Knowing to tell AI to propagate context as the first argument requires knowing Go's context propagation pattern. Knowing to specify pgx named parameters requires knowing the difference between pgx and database/sql. Each Go-specific instruction you give an AI is evidence of your own Go knowledge.

The gopls integration is the highest-value tool in the Go AI-assisted development stack, because it gives you compiler-accurate feedback on AI-generated code before you run it. When AI invents a function that does not exist, calls one with the wrong argument types, or declares a variable it never uses, gopls says so instantly, and those are exactly the hallucinations from Section 118.5.

Be precise about the limit, though. gopls is a static analyzer: it tells you the code is well-formed, not that it is right. It cannot tell you that a type assertion will panic on this afternoon's JSON, that a mutex is protecting the wrong field, or that the query is missing a tenant filter. Those are runtime and semantic properties, and the tools for them are `go test -race`, real tests, and your own reading. Use gopls as the cheap first pass that removes the mechanical errors, then apply the manual checklist to what survives.

### Senior @ FAANG: Go Language Server as Quality Gate Infrastructure

At senior level, gopls is not just a developer tool. It is a quality gate infrastructure component. gopls runs in the editor, where its findings are advisory and easy to ignore. The CI equivalent is golangci-lint, which bundles the same underlying analyzers (`govet`, `staticcheck`, `errcheck`, and others) and makes them blocking. Distribute a shared `.golangci.yml` across the organization's repositories and wire it into CI. The Go mistakes AI makes most often (unchecked errors, dropped context, misused interfaces) are largely the mistakes these linters were written to catch. Running these checks automatically on every PR means that Go-specific AI quality issues are caught in CI rather than in code review, reducing review burden and catching issues that reviewers might miss under time pressure.
