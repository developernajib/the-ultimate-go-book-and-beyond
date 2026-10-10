## Validation Pitfalls: When Input Handling Goes Wrong

### The ReDoS Attack Through Regex Validation

**What actually makes a regex vulnerable**: Catastrophic backtracking needs *ambiguity*, meaning more than one way for the pattern to split the same input. A quantifier nested inside another quantifier over an overlapping character class is the classic shape. `^([a-zA-Z0-9_.-]+)+@example\.com$` is genuinely vulnerable: the inner `+` and the outer `+` compete for the same characters, so a non-matching input like `aaaa...a!` forces the engine to try every partition. On a PCRE-style engine the cost doubles with each added character, so 18 characters take milliseconds, 24 take most of a second, and roughly 40 outlive your patience.

Contrast that with `^([a-zA-Z0-9]+)@([a-zA-Z0-9]+\.)+[a-zA-Z]{2,}$`. This one *looks* dangerous because of the nested `+`, but the group is anchored by a literal `.` that the character class cannot match. Each iteration therefore consumes exactly one dot-terminated chunk, the partition is forced, and there is nothing to backtrack over. Test before you assume. Plenty of "ReDoS" findings filed against email regexes are false positives for exactly this reason, and plenty of genuinely dangerous patterns look harmless.

**Go's built-in protection**: Go's `regexp` package uses the RE2 engine, which guarantees linear-time matching and is structurally immune to catastrophic backtracking. Both patterns above run safely in Go. This is a real and underrated advantage of the language. The risk returns when your Go service shells out to a PCRE-based tool, calls a C library through cgo, hands a pattern to a database (Postgres `~` uses a backtracking engine), or accepts a user-supplied pattern that it forwards elsewhere. Even under RE2, a large enough input still costs linear CPU, so bound the length first.

```go
// Go's regexp package uses RE2, so neither pattern can backtrack here.
// Still, prefer simple patterns and length checks as defense in depth.
var emailRegex = regexp.MustCompile(`^([a-zA-Z0-9]+)@([a-zA-Z0-9]+\.)+[a-zA-Z]{2,}$`)

func validateEmail(email string) bool {
    return emailRegex.MatchString(email)
}

// BETTER: Length check first, then use net/mail for RFC-compliant parsing
func validateEmailSafe(email string) error {
    // Length check first (fast fail)
    if len(email) > 254 { // RFC 5321
        return errors.New("email too long")
    }

    // Simple structure check
    at := strings.LastIndex(email, "@")
    if at < 1 || at > len(email)-4 {
        return errors.New("invalid email format")
    }

    local := email[:at]
    domain := email[at+1:]

    if len(local) > 64 || len(domain) > 253 {
        return errors.New("invalid email format")
    }

    if !strings.Contains(domain, ".") {
        return errors.New("invalid domain")
    }

    // Use net/mail for final validation (handles edge cases correctly)
    _, err := mail.ParseAddress(email)
    return err
}

// A timeout wrapper for matching work you do NOT control (a cgo call into a
// PCRE library, a subprocess, a database regex). Understand its limit before
// reaching for it: this bounds how long the CALLER waits, it does not stop
// the work. Go cannot preempt a running match, so on timeout the goroutine
// keeps burning a core until it finishes on its own. Under attack that is a
// slower way to lose, not a defense.
//
// The buffered channel matters: with an unbuffered channel the abandoned
// goroutine would block forever on send and leak permanently.
//
// The real control is upstream: cap the input length first, reject
// user-supplied patterns, and prefer RE2 so the problem cannot arise.
func matchWithTimeout(ctx context.Context, match func(string) bool, input string) (bool, error) {
    ctx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
    defer cancel()

    resultCh := make(chan bool, 1) // buffered: abandoned sender must not block

    go func() {
        resultCh <- match(input)
    }()

    select {
    case result := <-resultCh:
        return result, nil
    case <-ctx.Done():
        return false, fmt.Errorf("validation timeout after %d bytes: %w", len(input), ctx.Err())
    }
}
```

### The Mass Assignment Vulnerability

**The Incident**: A user profile endpoint allowed updates via JSON body. The struct had an `IsAdmin` field for internal use. An attacker included `"is_admin": true` in their profile update request. The JSON decoder populated the field, and a regular user became admin. The attacker accessed all customer data within minutes.

```go
// WRONG: Binding directly to domain model
type User struct {
    ID        int64  `json:"id"`
    Name      string `json:"name"`
    Email     string `json:"email"`
    IsAdmin   bool   `json:"is_admin"` // Internal field exposed!
    CreatedAt time.Time
}

func UpdateProfile(w http.ResponseWriter, r *http.Request) {
    user := getCurrentUser(r)

    // Attacker can set is_admin: true!
    if err := json.NewDecoder(r.Body).Decode(&user); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    db.Save(user) // Saves attacker-controlled IsAdmin!
}

// CORRECT: Separate input DTOs from domain models
type UpdateProfileRequest struct {
    Name  string `json:"name" validate:"omitempty,min=1,max=100"`
    Email string `json:"email" validate:"omitempty,email"`
    // IsAdmin not included, so it cannot be set via the API
}

func UpdateProfile(w http.ResponseWriter, r *http.Request) {
    user := getCurrentUser(r)

    var req UpdateProfileRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    // Validate
    if err := validate.Struct(req); err != nil {
        writeValidationError(w, err)
        return
    }

    // Only update allowed fields
    if req.Name != "" {
        user.Name = req.Name
    }
    if req.Email != "" {
        user.Email = req.Email
    }

    db.Save(user)
}

// Even better: DisallowUnknownFields prevents extra fields
func UpdateProfileStrict(w http.ResponseWriter, r *http.Request) {
    var req UpdateProfileRequest

    dec := json.NewDecoder(r.Body)
    dec.DisallowUnknownFields() // Reject {"is_admin": true}

    if err := dec.Decode(&req); err != nil {
        if strings.Contains(err.Error(), "unknown field") {
            http.Error(w, "Unknown field in request", http.StatusBadRequest)
            return
        }
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }
    // ...
}
```

### The Error Message Information Leak

**The pattern**: A login endpoint returns different error messages for "User not found" and "Invalid password". That single distinction turns the endpoint into an oracle: an attacker scripts a list of candidate addresses and keeps the ones that come back with the password error, because those are the accounts that exist. Paired with credential-stuffing against a breach list, enumeration is the reconnaissance step that makes the rest cheap. The helpful error message is the vulnerability.

Note the message is only half of it. If the "user not found" path skips password hashing and returns in 2 ms while the real path spends 200 ms in bcrypt, the response time leaks exactly the same fact. Fix both or you have fixed neither: always run a hash comparison against a dummy value on the not-found path so the work is symmetric.

```go
// WRONG: Different errors reveal information
func Login(w http.ResponseWriter, r *http.Request) {
    var req LoginRequest
    json.NewDecoder(r.Body).Decode(&req)

    user, err := db.GetUserByEmail(req.Email)
    if err == ErrNotFound {
        http.Error(w, "User not found", http.StatusUnauthorized) // Leaks!
        return
    }

    if !checkPassword(req.Password, user.PasswordHash) {
        http.Error(w, "Invalid password", http.StatusUnauthorized) // Leaks!
        return
    }

    // Success...
}

// CORRECT: Generic error message, detailed logging
func Login(w http.ResponseWriter, r *http.Request) {
    var req LoginRequest
    json.NewDecoder(r.Body).Decode(&req)

    requestID := getRequestID(r.Context())

    user, err := db.GetUserByEmail(req.Email)
    if errors.Is(err, ErrNotFound) {
        // Log detailed info for debugging
        log.Info("login failed: user not found",
            "email_hash", hashEmail(req.Email),
            "request_id", requestID)

        // Burn the same CPU the real path would, so response timing does
        // not reveal whether the account exists. Without this, the message
        // is generic but the latency still answers the attacker's question.
        checkPassword(req.Password, dummyHash)

        // Generic response to client
        http.Error(w, "Invalid email or password", http.StatusUnauthorized)
        return
    }

    if !checkPassword(req.Password, user.PasswordHash) {
        log.Info("login failed: wrong password",
            "user_id", user.ID,
            "request_id", requestID)

        // Same generic response
        http.Error(w, "Invalid email or password", http.StatusUnauthorized)
        return
    }

    // Success, log that too
    log.Info("login successful",
        "user_id", user.ID,
        "request_id", requestID)
    // ...
}

// For database errors, NEVER expose SQL details
func handleDBError(w http.ResponseWriter, err error, requestID string) {
    // Log the full error
    log.Error("database error",
        "error", err.Error(),
        "request_id", requestID)

    // Generic response
    http.Error(w, "An internal error occurred", http.StatusInternalServerError)
}
```

### The Validation Bypass Through Double Decoding

**First, kill a myth.** A file system does not decode percent-encoding. Nothing below the HTTP layer does. If you write a file named `..%2Fetc`, you get a file with a literal `%` in its name. The widely repeated story that `..%2F..%2Fetc%2Fpasswd` slips past a `..` check and then "gets decoded by the file system" is simply false, and repeating it teaches the wrong mental model.

**What is actually true in Go**: `r.URL.Query().Get("filename")` returns the value **already percent-decoded, exactly once**. So `..%2F..%2Fetc%2Fpasswd` arrives at your handler as the literal string `../../etc/passwd`, and a naive `strings.Contains(filename, "..")` catches it. The decoding you were worried about already happened, before your check ran.

**The real bug is decoding twice.** It appears when someone "hardens" a handler by adding an explicit `url.QueryUnescape` on a value `Query()` already decoded. Now `..%252F` (where `%25` is an encoded `%`) decodes once to the inert `..%2F`, passes your `..` check as a harmless literal, and then your extra unescape turns it into `../`. The defensive line manufactured the traversal. The rule is not "decode before validating." It is **decode exactly once, then validate what you will actually use, and use exactly what you validated.**

```go
// WRONG: decoding a second time, then validating the wrong string.
func uploadFileWrong(w http.ResponseWriter, r *http.Request) {
    filename := r.URL.Query().Get("filename") // already decoded once

    // "Extra safety" that is actually the vulnerability:
    // "..%252F" -> Query() gives "..%2F" -> this gives "../"
    decoded, _ := url.QueryUnescape(filename)

    if strings.Contains(decoded, "..") {
        http.Error(w, "Invalid filename", http.StatusBadRequest)
        return
    }
    // Validated `decoded` but writes with `decoded`, built by a second
    // decode the client never asked for. Sequence exists only because of
    // the extra unescape.
    os.WriteFile(filepath.Join(uploadDir, decoded), data, 0o644)
}

// CORRECT: trust the single decode Query() already did, then constrain
// the value to a strict allowlist and re-verify containment on the path
// you actually open.
var safeName = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,128}$`)

func uploadFile(w http.ResponseWriter, r *http.Request) {
    // Already decoded exactly once by Query(). Do NOT unescape again.
    filename := r.URL.Query().Get("filename")

    // Allowlist beats denylist. This rejects "/", "\", NUL, control bytes,
    // absolute paths, and every encoding trick at once, because anything
    // not in the class is simply not permitted.
    if !safeName.MatchString(filename) {
        http.Error(w, "Invalid filename", http.StatusBadRequest)
        return
    }

    // The allowlist already excludes separators, so "." and ".." are the
    // only traversal-ish names that can still get through.
    if filename == "." || filename == ".." {
        http.Error(w, "Invalid filename", http.StatusBadRequest)
        return
    }

    // Belt and braces: verify the resolved path is still inside uploadDir.
    // filepath.Clean alone never prevents traversal, it only normalizes.
    absUpload, err := filepath.Abs(uploadDir)
    if err != nil {
        http.Error(w, "Server error", http.StatusInternalServerError)
        return
    }
    fullPath := filepath.Join(absUpload, filename)
    if !strings.HasPrefix(fullPath, absUpload+string(os.PathSeparator)) {
        http.Error(w, "Invalid filename", http.StatusBadRequest)
        return
    }

    // On Linux, os.OpenInRoot (Go 1.24+) is stronger still: it enforces
    // containment in the kernel, so a symlink inside uploadDir pointing at
    // /etc cannot escape the way a prefix check can be tricked into allowing.
    f, err := os.OpenInRoot(absUpload, filename)
    if err != nil {
        http.Error(w, "Invalid filename", http.StatusBadRequest)
        return
    }
    defer f.Close()
    // ... write to f
}
```

### Quick Reference: Validation Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| ReDoS | Server hangs on input | Simple patterns, timeouts, RE2 |
| Mass assignment | Privilege escalation | Separate input DTOs |
| Verbose errors | Information leak | Generic client errors, detailed logs |
| Double decoding | Security controls bypassed | Decode exactly once, validate what you use |
| Missing length limits | OOM, slow processing | Validate lengths first |
| Client-side only | All validation bypassed | Always validate server-side |
| Trusting Content-Type | Wrong parser, security issues | Validate actual content |
| Missing null bytes | Path truncation attacks | Reject null bytes in strings |

### Junior → FAANG: Reading Pitfalls Like an Incident Responder

Every pitfall above is someone's postmortem. When you read them, do not memorize the patches. Memorize the shape of the reasoning. "The validation passed but the file system decoded the path" is a class of bug, not one bug. "The error message leaked the existence of the account" is a class, not one bug. Interviewers test the class, not the instance.

Worked example for the double-decoding bypass. A junior reads "decode before you validate" and thinks "I will call `url.QueryUnescape` everywhere." That instinct is what *creates* the bug, because `Query().Get` already decoded once and the second decode is what turns an inert `..%252F` into a live `../`. A mid-level engineer asks the better question: "where has decoding already happened?" The answer is a list worth memorizing. `r.URL.Query()` decodes. `r.FormValue` and multipart parsing decode. Router path parameters may or may not, depending on the library and on whether it routes over `Path` or `RawPath`. Headers and cookies are not percent-decoded at all. Any proxy in front of you may normalize, re-encode, or decode again. The pitfall is not "decode before validate." It is "you do not know how many times this string has been decoded." The senior fix is to define a canonical form per field (decoded exactly once, NFC-normalized, trimmed, case-folded where appropriate), convert to it at exactly one place, validate that form, and use that same value downstream, with tests that feed in single-encoded, double-encoded, and mixed-case-encoded variants and assert identical outcomes.

The "why did this fail" reflex for each pitfall. ReDoS: are you on Go's RE2 (linear time, no backtracking), and if not, because you shelled out to `grep`, called a C library through cgo, or handed the pattern to Postgres, did you bound input length first? Mass assignment: did you bind the request body directly to a domain struct, and if so, every field on that struct is now attacker-controllable. Error message leak: is your error text different per failure mode, and does the timing of the two paths differ enough to measure? Double decoding: how many times was this string decoded before you validated it, and is the value you validated byte-for-byte the value you used? Length: did you cap body size with `http.MaxBytesReader`, and did you cap string length with `utf8.RuneCountInString` rather than `len`, which counts bytes and will reject a legitimate name in Japanese long before an attacker's ASCII payload?

Prerequisite gaps to close for a security-conscious first job. Read the OWASP Top 10:2025 at least once. Two of its categories are this chapter's subject matter: A05 Injection (what unvalidated input becomes) and A10 Mishandling of Exceptional Conditions, a category added in 2025 covering improper error handling, logical errors, and failing open. If your handler returns 500 on bad user input, or swallows an error and continues, that is now a named entry on the industry's canonical risk list, not merely untidy code. Know that `json.Decoder.DisallowUnknownFields` exists and when to use it. Know that `subtle.ConstantTimeCompare` and `hmac.Equal` exist and why. Know that `filepath.Clean` does not prevent traversal on its own. Know that `log.Info("password", req.Password)` is a production incident waiting to happen.

The entry-point interview pattern. When the prompt is "here is a handler, what could go wrong," walk the ladder out loud: transport layer (TLS, size caps, timeouts), parser layer (content type, decode errors, unknown fields), validation layer (format, length, canonical form), authorization layer (does this user own this resource), business layer (invariants, idempotency, race conditions), response layer (shape, status, information leakage), observability layer (request ID, structured log, PII redaction). A candidate who walks that ladder is hired. A candidate who jumps straight to "you should sanitize the input" is not.

### Senior @ FAANG: Pitfall Classes, Governance, and the Defense-in-Depth Model

At staff and principal level, pitfalls are not taught one at a time. They are grouped into classes, and governance is designed so that a whole class cannot ship.

The five classes worth tracking organization-wide. Class one, parser trust: any code path that decodes untrusted input must be bounded by size, timeout, and a strict schema with unknown-field rejection. Class two, canonical form: any string used as a key, path component, or identifier must be normalized (Unicode NFC, case-folded per locale rules, trimmed, decoded exactly once) before it hits any comparison, uniqueness check, or storage. Class three, privilege transitivity: any writable field on a domain object must be gated by an explicit allowlist at the API boundary, and the compiler should enforce this through separate DTO types generated from the API spec. Class four, response leakage: any response must emit a shape from a small vocabulary of approved shapes, and the linter must reject `http.Error` calls outside a short allowlist of packages. Class five, observability: every failure must carry a request ID and a stable code, and every log line must pass through a redacting handler before leaving the process.

ADR-grade controls for each class. Class one: platform-provided HTTP middleware that sets `MaxBytesReader`, a decode helper that sets `DisallowUnknownFields`, and a CI lint that fails PRs introducing raw `json.NewDecoder(r.Body).Decode` calls in handler packages. Class two: a `canonical` package whose types wrap strings and expose `.Canonical()` methods, enforced by a vet tool that rejects direct string-to-string comparisons on identifier fields. Class three: DTOs generated from OpenAPI or proto schemas, with a linter that rejects handlers binding request bodies directly to domain types. Class four: Problem Details middleware, Spectral rules in CI, a registry of approved error codes, and a runtime assertion that panics in development when an unregistered code leaves the process. Class five: a `slog.Handler` wrapper that redacts by attribute key regex, a middleware that sets a request ID from `traceparent` or generates one, and a log sink that fails CI if it detects a PII-class attribute in a sample.

Maturity model on input handling. L1: validation is ad-hoc in handlers, pitfalls are discovered by customer reports. L2: validation lives in a library, handlers call it, but coverage is uneven. L3: validation is mandatory by convention and code review, and the five classes above are written down as a style guide. L4: each class has compile-time or CI enforcement, and a new service cannot ship without opting into the platform middleware. L5: the pitfall classes are baked into the SDK and spec generator, so a new endpoint cannot be defined in a way that introduces a class-one through class-five bug, and a security review focuses on business logic rather than input handling.

Bar-raiser prompt. "You own the API platform. A pentester filed five findings, one in each class above. Ship controls that make the next pentester file zero." Expected plan: a written taxonomy that groups findings into classes, a platform library change that closes each class at the framework layer rather than per service, a migration plan that tracks coverage per service and publishes a dashboard, a blocking CI check that prevents regression, and an SLO on "percentage of endpoints on current platform version" with a deprecation clock for services that do not migrate. Candidates who propose only per-service fixes fail the loop. The signal is that controls scale, education does not.

Defense-in-depth for a payments endpoint, walked end to end. Transport: TLS 1.3, `http.MaxBytesReader` at 64KB, request timeout at 5 seconds. Parser: `DisallowUnknownFields`, `json.Number` for amounts, content type must be `application/json`. Validation: format via struct tags, business via service layer, canonical form for card numbers and emails, Luhn check, rate limit per account and per IP. Authorization: OAuth scope required, resource ownership check, MFA step-up for amounts above threshold. Business: idempotency key required, double-entry ledger write in a single transaction, unique constraint on external ID. Response: Problem Details shape, request ID, no raw error strings, `Retry-After` on 429 and 503. Observability: structured log with redaction, metrics per error code, distributed trace with span per check. Every layer is a separate control, and removing any one of them produces one of the pitfall classes above.

---
