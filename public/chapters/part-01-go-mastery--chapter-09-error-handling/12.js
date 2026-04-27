export default `## 9.11 Common Mistakes

### 1. Ignoring Errors

Discarding errors with \`_\` silently hides failures, \`json.Marshal\` can fail on unsupported types, and \`file.Write\` can fail on a full disk. Each ignored error is a silent data-corruption or partial-write bug waiting to surface in production under load.

\`\`\`go
// Bad - silently ignoring errors
data, _ := json.Marshal(obj)
file.Write(data) // Also ignoring Write error!

// Good - handle or explicitly document
data, err := json.Marshal(obj)
if err != nil {
    return fmt.Errorf("marshal user: %w", err)
}
if _, err := file.Write(data); err != nil {
    return fmt.Errorf("write data: %w", err)
}
\`\`\`

### 2. Not Wrapping Errors

Returning a raw \`os.ReadFile\` error gives the caller no indication of which operation failed or in which function. Wrapping with \`fmt.Errorf("read config file: %w", err)\` builds a call-stack narrative that makes the failure location obvious in logs without requiring a debugger.

\`\`\`go
// Bad: loses context of where error occurred
func loadConfig() (Config, error) {
    data, err := os.ReadFile("config.json")
    if err != nil {
        return Config{}, err  // Where did this fail?
    }
    // ...
}

// Good: adds context
func loadConfig() (Config, error) {
    data, err := os.ReadFile("config.json")
    if err != nil {
        return Config{}, fmt.Errorf("read config file: %w", err)
    }
    // ...
}
\`\`\`

### 3. Wrapping with %v Instead of %w

\`%v\` formats the error as a string, severing the error chain. Downstream callers using \`errors.Is\` or \`errors.As\` to inspect specific sentinel values or custom error types will get false negatives. Use \`%w\` to preserve the chain so callers can unwrap and match errors by identity or type.

\`\`\`go
// Bad: breaks error chain, errors.Is/As won't work
return fmt.Errorf("failed: %v", err)

// Good: preserves error chain
return fmt.Errorf("failed: %w", err)
\`\`\`

### 4. Comparing Errors with ==

Direct \`==\` comparison only matches the exact error value and fails when the error has been wrapped by any intermediate layer. \`errors.Is\` recursively unwraps the error chain, making it the correct and future-proof way to test for a specific sentinel error.

\`\`\`go
// Bad: doesn't work with wrapped errors
if err == ErrNotFound {
    // This might miss wrapped ErrNotFound
}

// Good: works through wrapping
if errors.Is(err, ErrNotFound) {
    // Works even if err is wrapped multiple times
}
\`\`\`

### 5. Type Asserting Errors

A direct type assertion on a wrapped error will always fail because the outer wrapper is a different concrete type. \`errors.As\` traverses the chain until it finds an error whose type can be assigned to the target variable, making it the correct API for extracting typed errors through layers of wrapping.

\`\`\`go
// Bad: doesn't work with wrapped errors
if qerr, ok := err.(*QueryError); ok {
    // Won't match if QueryError is wrapped
}

// Good: works with wrapped errors
var qerr *QueryError
if errors.As(err, &qerr) {
    // Works even if QueryError is wrapped
}
\`\`\`

### 6. Returning Error and Value Together

Returning a zero-value \`User{}\` alongside an error lets careless callers proceed with an empty struct and silently corrupt data. Returning \`*User\` makes the absence of a value explicit, a nil pointer is an unambiguous signal that no user was found or retrieved.

\`\`\`go
// Bad: caller might use zero value
func getUser(id int) (User, error) {
    if id <= 0 {
        return User{}, errors.New("invalid id")
    }
    // What if user isn't found? Return empty User{}?
}

// Good: use pointer to make it clear
func getUser(id int) (*User, error) {
    if id <= 0 {
        return nil, errors.New("invalid id")
    }
    user, err := db.FindUser(id)
    if err != nil {
        return nil, err
    }
    return user, nil // nil user means not found
}
\`\`\`

### 7. Logging and Returning

Logging at every level where an error is handled produces duplicate log lines, making it hard to correlate a single failure event. The idiomatic approach is to wrap-and-return at each layer without logging, then log exactly once at the top-level boundary (e.g., the HTTP handler) where the full error chain is available.

\`\`\`go
// Bad: error gets logged multiple times
func process() error {
    err := doSomething()
    if err != nil {
        log.Printf("error: %v", err)  // Logged here
        return err  // And will be logged by caller too
    }
    return nil
}

// Good: log at the top level only
func process() error {
    err := doSomething()
    if err != nil {
        return fmt.Errorf("process: %w", err)  // Just wrap and return
    }
    return nil
}

// At the top level (e.g., HTTP handler)
func handler(w http.ResponseWriter, r *http.Request) {
    err := process()
    if err != nil {
        log.Printf("request failed: %v", err)  // Log once here
        http.Error(w, "Internal error", 500)
    }
}
\`\`\`

### 9. Panic in Library Code

\`panic\` in a library crashes the calling application unless the caller wraps every library call in a \`recover\`, an unreasonable burden. Library code should surface invalid inputs as returned errors so callers can decide how to handle them without the program terminating.

\`\`\`go
// Bad: library panics affect callers
func (c *Client) Do(req *Request) *Response {
    if req == nil {
        panic("nil request")  // Crashes caller's program!
    }
    // ...
}

// Good: return error for callers to handle
func (c *Client) Do(req *Request) (*Response, error) {
    if req == nil {
        return nil, errors.New("nil request")
    }
    // ...
}
\`\`\`

### Review Checklist

For each PR, check: (1) every error is wrapped with context, (2) no sensitive data in messages, (3) no double-log-and-return, (4) no panic in library code, (5) typed-nil returns replaced with explicit \`return nil\`. Wire as much as possible into linters. Catch the rest in review.

---
`;
