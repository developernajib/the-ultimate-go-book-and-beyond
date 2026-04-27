export default `## 9.4 Sentinel Errors

Sentinel errors are package-level variables created with \`errors.New\` that represent fixed, well-known error conditions. Because each call to \`errors.New\` produces a unique value, callers can reliably check for a specific condition using \`errors.Is\` without parsing error message strings. Sentinel errors work best for simple conditions that carry no additional data beyond their identity.

\`\`\`go
var (
    ErrNotFound     = errors.New("not found")
    ErrUnauthorized = errors.New("unauthorized")
    ErrInvalidInput = errors.New("invalid input")
    ErrConflict     = errors.New("conflict")
)

func getUser(id int) (User, error) {
    user, ok := users[id]
    if !ok {
        return User{}, ErrNotFound
    }
    return user, nil
}

// Usage
user, err := getUser(123)
if errors.Is(err, ErrNotFound) {
    // Handle missing user - maybe return 404
    http.Error(w, "User not found", http.StatusNotFound)
    return
}
\`\`\`

### Standard Library Sentinel Errors

The standard library defines sentinel errors for conditions that callers frequently need to distinguish. Knowing these avoids reinventing them in your own packages:

\`\`\`go
// io package
io.EOF              // End of input
io.ErrUnexpectedEOF // EOF when more data expected
io.ErrClosedPipe    // Write to closed pipe

// os package
os.ErrNotExist      // File doesn't exist
os.ErrExist         // File already exists
os.ErrPermission    // Permission denied

// context package
context.Canceled         // Context was canceled
context.DeadlineExceeded // Context deadline passed

// database/sql
sql.ErrNoRows       // Query returned no rows
sql.ErrTxDone       // Transaction already committed/rolled back

// net/http
http.ErrServerClosed // Server was shut down
\`\`\`

### When to Use Sentinel Errors

**Good uses:**
- Well-known conditions callers need to check
- API boundaries where callers need to differentiate errors
- Standard library patterns (io.EOF, os.ErrNotExist, sql.ErrNoRows)

**Avoid when:**
- Error needs additional context (use error types instead)
- Error is an implementation detail
- Too many sentinels needed (consider error types)

### Sentinel Error Naming Convention

Sentinel errors follow the \`Err\` prefix convention established by the standard library (e.g., \`io.EOF\`, \`sql.ErrNoRows\`). This naming makes sentinel errors immediately identifiable at call sites and in code reviews.

\`\`\`go
// Convention: prefix with \`Err\`
var (
    ErrInvalidID     = errors.New("invalid ID")
    ErrAlreadyExists = errors.New("already exists")
    ErrTimeout       = errors.New("timeout")
    ErrRateLimited   = errors.New("rate limited")
)

// NOT these:
var (
    InvalidIDError  = errors.New("invalid ID")  // Wrong - use Err prefix
    INVALID_ID      = errors.New("invalid ID")  // Wrong - Go style
    invalidId       = errors.New("invalid ID")  // Wrong - not exported
)
\`\`\`

### Sentinel Errors vs Error Types Decision Tree

Choosing between sentinel errors and custom error types depends on whether callers need to extract structured data from the error. The following decision tree guides this choice based on caller requirements.

\`\`\`
Need to check for specific error condition?
├── No → Return generic error with fmt.Errorf
└── Yes → Does caller need additional information?
    ├── No → Use sentinel error (var ErrX = errors.New(...))
    └── Yes → Use error type (type XError struct{...})
\`\`\`

### Sentinel Discipline

Sentinel errors become part of the package's public API. The senior-track rules:

1. **Every exported sentinel is a stable contract.** Removing or renaming is a breaking change.
2. **Every exported sentinel deserves a doc comment.** Explain when callers see it.
3. **Sentinels that are never compared to are dead code.** If no caller uses \`errors.Is\` against the sentinel, the sentinel is just a fancy error message. Use \`fmt.Errorf\` instead.

---
`;
