export default `## 2.7 Error Handling Basics

Go doesn't have exceptions. Instead, functions return errors as values. This is one of Go's most important design decisions, and it forces you to handle errors explicitly at every step.

### The Error Pattern

\`\`\`go
file, err := os.Open("data.txt")
if err != nil {
    fmt.Println("Failed to open file:", err)
    return
}
defer file.Close()
// ... use the file ...
\`\`\`

This \`value, err := function(); if err != nil { handle it }\` pattern appears on nearly every page of Go code. It might look verbose at first, but it makes error handling visible and intentional. You'll never have a hidden exception crash your production server at 3 AM because you forgot a \`try/catch\` somewhere.

### Creating Errors

\`\`\`go
import "errors"
import "fmt"

// Simple error
err := errors.New("something went wrong")

// Formatted error (more common)
err := fmt.Errorf("user %s not found", username)

// Custom error from a function
func divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, fmt.Errorf("division by zero: cannot divide %f by %f", a, b)
    }
    return a / b, nil  // nil means "no error"
}
\`\`\`

### Don't Ignore Errors

This is a rule, not a suggestion:

\`\`\`go
// BAD: ignoring the error
result, _ := divide(10, 0)

// GOOD: handling the error
result, err := divide(10, 0)
if err != nil {
    log.Fatal(err)
}
\`\`\`

The only time you should ignore an error with \`_\` is when you've consciously decided that the error genuinely doesn't matter (e.g., closing a read-only file). Even then, consider logging it.

We'll cover Go's error handling in much greater depth in Chapter 9, including custom error types, error wrapping, and the \`errors.Is\`/\`errors.As\` functions.

### Panic and Recover (Don't Use These for Normal Errors)

\`panic\` crashes the program. \`recover\` catches a panic. These exist for truly unrecoverable situations (programming bugs, impossible states), not for regular error handling:

\`\`\`go
// panic stops the program
func mustConnect(url string) *Connection {
    conn, err := connect(url)
    if err != nil {
        panic("failed to connect to " + url + ": " + err.Error())
    }
    return conn
}
\`\`\`

If you're coming from Python or Java, resist the urge to use \`panic\`/\`recover\` like \`try\`/\`except\`. Return errors instead. The Go community considers \`panic\` for normal error handling to be a code smell.

### Errors Are Values, Not Control Flow

The mental model that distinguishes Go's error handling from every exception-throwing language is this. An error is a return value, identical in status to the other return values of the function. It is not a separate channel that bypasses the call site, it is not invisible at the type signature, and it is not handled implicitly by an enclosing block somewhere up the stack. Every function that can fail says so in its signature. Every caller decides explicitly whether to handle the failure, propagate it up, or ignore it (and ignoring is loud, with a \`_\`). The cost is verbose-looking code. The benefit is that there is exactly one mechanism to learn, the failure path is visible in every snippet, and there is no try-catch budget to manage at the architecture level.

This is also why Go programs are rarely surprised in production. The class of "an exception leaked out of a library boundary that the caller did not know about" cannot exist, because the function's signature does not have a hidden exception channel. If a Go function returns \`(T, error)\`, you handle the error or you do not, and the choice is visible at the line where the call happens.

### Error Wrapping with \`%w\` (Go 1.13+)

The \`fmt.Errorf\` function gained a special verb \`%w\` in Go 1.13 that wraps an existing error inside a new one while preserving the chain. Combined with \`errors.Is\` and \`errors.As\`, this is the basis of every modern Go error-handling discipline:

\`\`\`go
import "errors"
import "fmt"

var ErrUserNotFound = errors.New("user not found")

func loadUser(id string) (*User, error) {
    row, err := db.Query(id)
    if err != nil {
        return nil, fmt.Errorf("loadUser %s: %w", id, err)
    }
    if row == nil {
        return nil, ErrUserNotFound
    }
    return parseUser(row)
}

// At the call site
u, err := loadUser("alice")
if errors.Is(err, ErrUserNotFound) {
    return http.StatusNotFound
}
\`\`\`

Three rules to internalise:

1. **Use \`%w\` when you want callers to be able to inspect the underlying error.** Use \`%v\` (or \`%s\`) when you want to format the error for human consumption only, with no inspectability.
2. **Wrap with context, not noise.** A good wrap message says "what was I trying to do when this happened", for example \`fmt.Errorf("authenticating user %s: %w", username, err)\`. A bad wrap repeats the verb and adds nothing, for example \`fmt.Errorf("error: %w", err)\`.
3. **Wrap once per layer, not at every line.** A wrap chain that is ten layers deep with a generic message at each layer is unreadable at log time. Wrap when crossing a meaningful boundary (package, subsystem, transaction).

### \`errors.Is\` vs \`errors.As\`

\`errors.Is(err, target)\` returns true when \`target\` (a sentinel error like \`ErrUserNotFound\`) is anywhere in \`err\`'s wrap chain. \`errors.As(err, &target)\` walks the chain looking for an error whose dynamic type matches \`target\`'s pointed-to type and assigns it. The two are not interchangeable. Use \`Is\` for comparing against sentinel error values. Use \`As\` for extracting a typed error so you can read its fields:

\`\`\`go
var pe *os.PathError
if errors.As(err, &pe) {
    log.Printf("path error on %s: %v", pe.Path, pe.Err)
}
\`\`\`

### Sentinel Errors vs Typed Errors

A sentinel error is a package-level \`var ErrXxx = errors.New("...")\` that callers compare against with \`errors.Is\`. It is the right shape when "did this specific named failure happen" is the only question callers ask. A typed error is a custom struct that implements the \`error\` interface, often holding fields like \`Op\`, \`Path\`, or \`Code\`, which callers extract with \`errors.As\`. It is the right shape when callers need data about the failure (the path that did not exist, the validation field that failed, the HTTP status to return).

Both have a third option: never expose the error type to callers at all. For internal errors that callers should not branch on, returning a wrapped error with no sentinel and no typed structure is fine. The discipline question for senior engineers reviewing a package's public API is "what are callers allowed to assume about this error?". The answer should be intentional, not a side effect of which library happened to be imported.

### When \`panic\` Is the Right Answer

\`panic\` is correct in three narrow situations:

1. **Unrecoverable invariant violations during program startup.** A \`mustConnect\` to a service that, if absent, makes the program meaningless. The convention is to prefix such functions with \`Must\`, e.g. \`template.Must(template.ParseFiles(...))\`.
2. **Programmer-error that should never happen in a correct program.** Index-out-of-bounds, division by a constant zero in test code, switch defaults that catch enum values that should not exist. These are bugs, and crashing loud is better than continuing in an undefined state.
3. **Inside a tightly-scoped recoverable region in code generation, parser combinators, or the standard library's \`regexp\` engine.** A function panics deep in the recursion to bubble out cheaply, and a top-level \`defer recover()\` converts the panic back into an error at the API boundary. This is an intentional optimisation, not a default pattern.

For everything else, return \`error\`. A library that panics on normal failures is a library that will be removed from the dependency list at the next code review.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer scans for in error-handling-heavy code:

1. **Inconsistent wrap discipline.** Some functions wrap with \`%w\`, some with \`%v\`, some return raw, some wrap repeatedly. The team's ability to write \`errors.Is(err, ErrFoo)\` at the top level depends on every layer below using \`%w\`. Document the rule (we wrap with \`%w\` at every layer except for human-facing messages) and lint for it where possible.
2. **Sensitive data leaking into error messages.** \`fmt.Errorf("login failed for %s: %w", username, err)\` is fine. \`fmt.Errorf("login failed for %s with password %s: %w", username, password, err)\` ships passwords to the log aggregator. The general rule is that error messages are observability data, and observability data is shipped, retained, and indexed, often for years. Treat them with the same data-sensitivity discipline as any other observability surface.
3. **Discarded errors with \`_\`.** Almost always wrong. The handful of legitimate cases (closing a read-only resource, a \`WriteString\` to a \`bytes.Buffer\` that cannot fail) deserve a brief comment. Everything else is a bug waiting to be filed.

### Migration Lens

Coming from Java or Python, the absence of exceptions is the single biggest mental shift. The replacement is "every function that can fail returns an \`error\` and the caller handles it explicitly". The verbosity is real. The benefit is that the failure path is visible at every line, which means code review catches bugs that exception handling hides. Coming from Rust, the closest analogue to Go's \`error\` is \`Result<T, E>\`, and the closest analogue to \`?\` is the \`if err != nil { return err }\` pattern. Go does not have \`?\` and proposals to add it have been declined, on the grounds that the explicitness of the \`if\` block is a feature. Coming from Node.js, the closest analogue is the \`(err, value)\` callback convention, with the difference that Go returns synchronously and concurrency is provided by goroutines instead of callbacks.
`;
