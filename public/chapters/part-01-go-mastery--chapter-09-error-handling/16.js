export default `## Common Error Handling Mistakes (From "100 Go Mistakes")

Teiva Harsanyi's *100 Go Mistakes and How to Avoid Them* catalogs the error handling anti-patterns that appear most frequently in production Go code. The mistakes below (numbered as in the book) cover the ones with the highest real-world impact.

### Mistake #48: Panicking Inappropriately

**The Problem:** Using \`panic\` for normal error conditions instead of returning errors.

\`\`\`go
// WRONG: Panicking for recoverable errors
func GetUser(id string) *User {
    user, err := db.FindUser(id)
    if err != nil {
        panic(err) // DON'T DO THIS
    }
    return user
}

// CORRECT: Return errors for recoverable conditions
func GetUser(id string) (*User, error) {
    user, err := db.FindUser(id)
    if err != nil {
        return nil, fmt.Errorf("get user %s: %w", id, err)
    }
    return user, nil
}
\`\`\`

**When to Use Panic:**
- Programmer errors (nil pointer dereference that shouldn't happen)
- Initialization failures that prevent the program from running
- The \`Must\` pattern for compile-time initialization

### Mistake #49: Ignoring When to Wrap an Error

**The Problem:** Not wrapping errors or wrapping them incorrectly, losing context.

\`\`\`go
// WRONG: No context added
func ProcessOrder(orderID string) error {
    order, err := fetchOrder(orderID)
    if err != nil {
        return err // Lost context: where did this error occur?
    }
    return nil
}

// WRONG: Using %v instead of %w (can't use errors.Is/As)
func ProcessOrder(orderID string) error {
    order, err := fetchOrder(orderID)
    if err != nil {
        return fmt.Errorf("failed: %v", err) // Loses error chain
    }
    return nil
}

// CORRECT: Wrap with %w for error chain
func ProcessOrder(orderID string) error {
    order, err := fetchOrder(orderID)
    if err != nil {
        return fmt.Errorf("process order %s: %w", orderID, err)
    }
    return nil
}
\`\`\`

### Mistake #50: Checking Error Types Inaccurately

**The Problem:** Using type assertions instead of \`errors.As\` to check error types.

\`\`\`go
// WRONG: Direct type assertion (misses wrapped errors)
func handleError(err error) {
    if netErr, ok := err.(*net.OpError); ok {
        // Won't match if error is wrapped!
        handleNetworkError(netErr)
    }
}

// CORRECT: Use errors.As (handles wrapped errors)
func handleError(err error) {
    var netErr *net.OpError
    if errors.As(err, &netErr) {
        // Works even if error is wrapped
        handleNetworkError(netErr)
    }
}
\`\`\`

### Mistake #51: Checking Error Values Inaccurately

**The Problem:** Using \`==\` instead of \`errors.Is\` to check sentinel errors.

\`\`\`go
// WRONG: Direct comparison (misses wrapped errors)
if err == io.EOF {
    // Won't match fmt.Errorf("reading: %w", io.EOF)
}

// CORRECT: Use errors.Is (handles wrapped errors)
if errors.Is(err, io.EOF) {
    // Matches even when wrapped
}
\`\`\`

### Mistake #52: Handling an Error Twice

**The Problem:** The "log-and-return" anti-pattern, logging an error AND returning it to the caller. This causes the same error to appear multiple times in logs at different levels of the call stack, because every caller who receives the returned error will likely log it again. In a deep call stack, a single database timeout can produce five or six log lines, each slightly different, making it harder to understand what actually happened.

The rule is simple: **either handle the error (log it, emit a metric, return a default) OR return it to the caller, never both.**

\`\`\`go
// WRONG: The "log-and-return" anti-pattern
// Each layer logs AND returns, producing duplicate noise
func FetchUserProfile(userID string) (*Profile, error) {
    profile, err := db.GetProfile(userID)
    if err != nil {
        // First handling: logging the error here
        log.Printf("ERROR: failed to fetch profile for user %s: %v", userID, err)
        // Second handling: returning the error to the caller
        return nil, fmt.Errorf("fetch profile: %w", err)
    }
    return profile, nil
}

// The caller does the same thing...
func HandleProfileRequest(w http.ResponseWriter, r *http.Request) {
    userID := r.URL.Query().Get("id")
    profile, err := FetchUserProfile(userID)
    if err != nil {
        // Third handling: caller logs the SAME error again!
        log.Printf("ERROR: profile request failed: %v", err)
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }
    json.NewEncoder(w).Encode(profile)
}

// Result in logs for a single failure:
// ERROR: failed to fetch profile for user abc123: connection refused
// ERROR: profile request failed: fetch profile: connection refused
// Two log lines for ONE error. In a 5-layer stack, you get 5 lines.
\`\`\`

\`\`\`go
// CORRECT: Each layer adds context and returns - only the top-level handler logs
func FetchUserProfile(userID string) (*Profile, error) {
    profile, err := db.GetProfile(userID)
    if err != nil {
        // Only return with context - do NOT log here
        return nil, fmt.Errorf("fetch profile for user %s: %w", userID, err)
    }
    return profile, nil
}

// The top-level handler is the ONLY place that logs
func HandleProfileRequest(w http.ResponseWriter, r *http.Request) {
    userID := r.URL.Query().Get("id")
    profile, err := FetchUserProfile(userID)
    if err != nil {
        // Single log entry with full context chain
        log.Printf("ERROR: profile request failed: %v", err)
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }
    json.NewEncoder(w).Encode(profile)
}

// Result in logs for a single failure:
// ERROR: profile request failed: fetch profile for user abc123: connection refused
// ONE log line. Full context. Easy to trace.
\`\`\`

**The Exception:** When a function handles an error completely at its own level (does not return it), logging is appropriate because the error stops propagating:

\`\`\`go
// OK: Logging when you handle the error completely (not returning it)
func SaveWithFallback(data []byte) error {
    if err := primaryStore.Save(data); err != nil {
        // Log because we're handling it here - falling back, not returning
        log.Printf("WARN: primary store failed, trying fallback: %v", err)

        // Fallback - this is the actual handling
        if fallbackErr := fallbackStore.Save(data); fallbackErr != nil {
            return fmt.Errorf("save to fallback: %w", fallbackErr)
        }
        return nil // Error was handled - not returned
    }
    return nil
}
\`\`\`

### Mistake #53: Not Handling an Error

**The Problem:** Ignoring returned errors silently.

\`\`\`go
// WRONG: Ignoring error
func closeFile(f *os.File) {
    f.Close() // Error ignored!
}

// CORRECT: Handle or document why it's safe to ignore
func closeFile(f *os.File) {
    if err := f.Close(); err != nil {
        log.Printf("warning: failed to close file: %v", err)
    }
}
\`\`\`

### Mistake #54: Not Handling Defer Errors

**The Problem:** Ignoring errors from deferred functions.

\`\`\`go
// WRONG: Ignoring defer error
func writeConfig(cfg *Config) error {
    f, err := os.Create("config.json")
    if err != nil {
        return err
    }
    defer f.Close() // Error ignored!

    return json.NewEncoder(f).Encode(cfg)
}

// CORRECT: Handle defer error with errors.Join (Go 1.20+)
func writeConfig(cfg *Config) error {
    f, err := os.Create("config.json")
    if err != nil {
        return err
    }

    err = json.NewEncoder(f).Encode(cfg)
    return errors.Join(err, f.Close())
}
\`\`\`

### Error Handling Mistakes Quick Reference

| Mistake | Wrong | Correct |
|---------|-------|---------|
| #48 | \`panic(err)\` | \`return err\` |
| #49 | \`return err\` (no context) | \`return fmt.Errorf("ctx: %w", err)\` |
| #50 | \`err.(*Type)\` | \`errors.As(err, &target)\` |
| #51 | \`err == sentinel\` | \`errors.Is(err, sentinel)\` |
| #52 | Log AND return | Log OR return (not both) |
| #53 | \`_ = fn()\` | Handle or document why safe |
| #54 | \`defer f.Close()\` | \`errors.Join(err, f.Close())\` |

### Review Enforcement

Each mistake has a linter or a code-review pattern. \`errorlint\` catches \`==\` against errors and \`panic(err)\` patterns. \`errcheck\` catches discarded errors. Code review catches wrap-context gaps. Wire the tooling into CI. The tooling catches consistent issues, and review catches the judgment calls.

---
`;
