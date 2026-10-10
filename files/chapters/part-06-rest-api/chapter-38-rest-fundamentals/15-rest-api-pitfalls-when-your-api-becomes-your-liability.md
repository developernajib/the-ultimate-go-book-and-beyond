## REST API Pitfalls: When Your API Becomes Your Liability

### The Breaking Change Disaster

**The Incident**: A mobile banking app API returned user accounts as an array: `{"accounts": [...]}`. A backend developer "cleaned up" the response to return the array directly: `[...]`. The change seemed backward compatible: same data, less nesting. But every mobile app version in the wild crashed on launch because they expected an object with an "accounts" key. The app stores pulled the update, customer support was overwhelmed, and the company lost a meaningful share of daily active users who never reinstalled.

```go
// WRONG: Breaking response shape without versioning
type AccountsResponseOld struct {
    Accounts []Account `json:"accounts"`
}

type AccountsResponseNew []Account // "Cleaner" but breaks clients!

func GetAccounts(w http.ResponseWriter, r *http.Request) {
    accounts := fetchAccounts()
    json.NewEncoder(w).Encode(accounts) // Changed from struct to array
}

// CORRECT: Never break response shapes, use versioning
func GetAccountsV1(w http.ResponseWriter, r *http.Request) {
    accounts := fetchAccounts()
    json.NewEncoder(w).Encode(AccountsResponseV1{
        Accounts: accounts,
    })
}

func GetAccountsV2(w http.ResponseWriter, r *http.Request) {
    accounts := fetchAccounts()
    json.NewEncoder(w).Encode(AccountsResponseV2{
        Data: accounts,
        Meta: PaginationMeta{...},
    })
}

// Version detection middleware
func VersionMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        version := r.Header.Get("API-Version")
        if version == "" {
            version = r.URL.Query().Get("v")
        }
        if version == "" {
            version = "1" // Default to oldest supported
        }

        ctx := context.WithValue(r.Context(), "api_version", version)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}
```

### The Enumeration Attack Surface

**The Incident**: A social platform's API returned `404 Not Found` for non-existent users but `403 Forbidden` for private profiles. An attacker used this to enumerate all usernames on the platform: any non-404 response meant the user existed. They built a database of tens of millions of usernames to sell to spammers, and used the private profile list for targeted phishing.

```go
// WRONG: Leaking existence information through different status codes
func GetProfile(w http.ResponseWriter, r *http.Request) {
    userID := r.PathValue("id")

    user, err := db.GetUser(userID)
    if err == ErrNotFound {
        http.Error(w, "User not found", http.StatusNotFound) // Leaks "doesn't exist"
        return
    }

    if !user.IsPublic && !isAuthorized(r, user) {
        http.Error(w, "Private profile", http.StatusForbidden) // Leaks "exists but private"
        return
    }

    json.NewEncoder(w).Encode(user)
}

// CORRECT: Consistent response for both cases
func GetProfile(w http.ResponseWriter, r *http.Request) {
    userID := r.PathValue("id")
    viewer := getAuthenticatedUser(r)

    user, err := db.GetUser(userID)
    if err == ErrNotFound {
        // Return 404 in all "can't see" cases
        writeNotFound(w, "Profile not found or is private")
        return
    }

    // Check visibility
    if !canViewProfile(viewer, user) {
        // Same response as non-existent - prevents enumeration
        writeNotFound(w, "Profile not found or is private")
        return
    }

    json.NewEncoder(w).Encode(user)
}

func canViewProfile(viewer, target *User) bool {
    if target.IsPublic {
        return true
    }
    if viewer == nil {
        return false
    }
    if viewer.ID == target.ID {
        return true
    }
    return areFriends(viewer.ID, target.ID)
}

// For login endpoints - constant-time comparison and consistent timing
func Login(w http.ResponseWriter, r *http.Request) {
    var req LoginRequest
    json.NewDecoder(r.Body).Decode(&req)

    // Always perform password check, even for non-existent users
    // This prevents timing attacks
    user, err := db.GetUserByEmail(req.Email)

    var hashedPassword string
    if err == ErrNotFound {
        // Use fake hash to maintain constant time
        hashedPassword = "$argon2id$v=19$m=65536,t=3,p=4$fakesalt$fakehash"
    } else {
        hashedPassword = user.PasswordHash
    }

    // Constant-time comparison (same duration regardless of user existence)
    valid := argon2.VerifyPassword(req.Password, hashedPassword)

    if !valid || err == ErrNotFound {
        // Same message for both cases
        http.Error(w, "Invalid email or password", http.StatusUnauthorized)
        return
    }

    // Success...
}
```

### The Unbounded Request Body Bomb

**The Incident**: A fintech API accepted JSON requests without size limits. An attacker sent a 10GB JSON payload with deeply nested arrays. The server tried to parse it, exhausted memory, and crashed, along with every other service on the same Kubernetes node. The attack cost the attacker one HTTP request. The downtime cost the company six figures in lost transactions.

```go
// WRONG: No request body limits
func CreateOrder(w http.ResponseWriter, r *http.Request) {
    var order Order
    // This will happily try to parse gigabytes of JSON
    if err := json.NewDecoder(r.Body).Decode(&order); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }
    // ...
}

// CORRECT: Multiple layers of protection
const (
    MaxBodySize     = 1 * 1024 * 1024  // 1MB
    MaxJSONDepth    = 10
    MaxArrayLength  = 1000
)

func CreateOrder(w http.ResponseWriter, r *http.Request) {
    // Layer 1: Limit body size
    r.Body = http.MaxBytesReader(w, r.Body, MaxBodySize)

    // Layer 2: Use decoder with limits
    dec := json.NewDecoder(r.Body)
    dec.DisallowUnknownFields() // Reject unexpected fields

    var order Order
    if err := dec.Decode(&order); err != nil {
        var maxBytesErr *http.MaxBytesError
        if errors.As(err, &maxBytesErr) {
            http.Error(w, "Request too large", http.StatusRequestEntityTooLarge)
            return
        }
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    // Layer 3: Check there's no trailing data
    if dec.More() {
        http.Error(w, "Request body must contain a single JSON object", http.StatusBadRequest)
        return
    }

    // Layer 4: Business-level limits
    if len(order.Items) > MaxArrayLength {
        http.Error(w, "Too many items in order", http.StatusBadRequest)
        return
    }

    // ...
}

// Middleware for global body limits
func MaxBodyMiddleware(maxSize int64) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if r.ContentLength > maxSize {
                http.Error(w, "Request too large", http.StatusRequestEntityTooLarge)
                return
            }
            r.Body = http.MaxBytesReader(w, r.Body, maxSize)
            next.ServeHTTP(w, r)
        })
    }
}
```

### The Response Timing Oracle

**The Incident**: A password reset endpoint took over a second when the email existed (it sent the email inline) and a few milliseconds when it didn't. An attacker measured response times to enumerate valid email addresses. Combined with credential stuffing from other breaches, they compromised thousands of accounts before anyone noticed.

```go
// WRONG: Variable timing reveals information
func RequestPasswordReset(w http.ResponseWriter, r *http.Request) {
    email := r.FormValue("email")

    user, err := db.GetUserByEmail(email)
    if err == ErrNotFound {
        // Fast path - returns immediately
        w.WriteHeader(http.StatusOK)
        json.NewEncoder(w).Encode(map[string]string{
            "message": "If an account exists, you'll receive an email",
        })
        return
    }

    // Slow path - sends email (2+ seconds)
    sendPasswordResetEmail(user.Email)

    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(map[string]string{
        "message": "If an account exists, you'll receive an email",
    })
}

// CORRECT: Constant-time responses with background processing
func RequestPasswordReset(w http.ResponseWriter, r *http.Request) {
    email := r.FormValue("email")

    // Queue the work, don't wait for it
    resetQueue <- PasswordResetJob{
        Email:     email,
        RequestID: GetRequestID(r.Context()),
        Timestamp: time.Now(),
    }

    // Same response regardless of email existence
    w.WriteHeader(http.StatusAccepted)
    json.NewEncoder(w).Encode(map[string]string{
        "message": "If an account exists with this email, you'll receive reset instructions",
    })
}

// Background worker processes the queue
func processPasswordResets() {
    for job := range resetQueue {
        user, err := db.GetUserByEmail(job.Email)
        if err == ErrNotFound {
            // Log for monitoring but don't take action
            log.Info("password reset requested for non-existent email",
                "email_hash", hashEmail(job.Email))
            continue
        }

        if err := sendPasswordResetEmail(user); err != nil {
            log.Error("failed to send reset email", "error", err)
            // Retry logic...
        }
    }
}

// Even better: Add artificial delay for consistent timing
func RequestPasswordResetWithTiming(w http.ResponseWriter, r *http.Request) {
    start := time.Now()
    email := r.FormValue("email")

    // Queue the work
    resetQueue <- PasswordResetJob{Email: email}

    // Ensure minimum response time to mask timing differences
    minDuration := 200 * time.Millisecond
    elapsed := time.Since(start)
    if elapsed < minDuration {
        time.Sleep(minDuration - elapsed)
    }

    w.WriteHeader(http.StatusAccepted)
    json.NewEncoder(w).Encode(map[string]string{
        "message": "If an account exists, you'll receive an email",
    })
}
```

### The JSON Injection Through User Data

**The Incident**: A profile API returned user-provided "bio" field in JSON. A user set their bio to: `","admin":true,"`. The server used string concatenation to build JSON responses. The injected JSON gave the attacker admin privileges because the parser saw `"admin": true` in the response that the frontend trusted.

```go
// WRONG: Building JSON through string concatenation
func GetProfile(w http.ResponseWriter, r *http.Request) {
    user := getUser(r)

    // JSON injection via user-controlled data!
    w.Header().Set("Content-Type", "application/json")
    fmt.Fprintf(w, `{"id": %d, "name": "%s", "bio": "%s"}`,
        user.ID, user.Name, user.Bio)
    // If bio contains: ","admin":true,"
    // Result: {"id": 1, "name": "hacker", "bio": "","admin":true,""}
}

// CORRECT: Always use proper JSON marshaling
func GetProfile(w http.ResponseWriter, r *http.Request) {
    user := getUser(r)

    response := ProfileResponse{
        ID:   user.ID,
        Name: user.Name,
        Bio:  user.Bio, // Automatically escaped
    }

    w.Header().Set("Content-Type", "application/json")
    if err := json.NewEncoder(w).Encode(response); err != nil {
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }
    // Bio is properly escaped: "bio": "\",\"admin\":true,\""
}

// Also sanitize on input
func UpdateProfile(w http.ResponseWriter, r *http.Request) {
    var req UpdateProfileRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    // Validate and sanitize
    req.Bio = sanitizeBio(req.Bio)

    // ...
}

func sanitizeBio(bio string) string {
    // Remove or escape potentially dangerous characters
    bio = strings.TrimSpace(bio)

    // Limit length
    if len(bio) > 500 {
        bio = bio[:500]
    }

    // Remove control characters (but keep newlines for formatting)
    var clean strings.Builder
    for _, r := range bio {
        if r >= 32 || r == '\n' || r == '\r' || r == '\t' {
            clean.WriteRune(r)
        }
    }

    return clean.String()
}
```

### The Seven Production HTTP Server Safeguards

In [Most Go Http Servers are missing these 7 production Safeguards](https://medium.com/@yaninyzwitty/7-simple-mistakes-that-are-breaking-your-go-web-server-in-production-a0684fca8c08), engineer Yaninyz witty identifies why minimal boilerplate like `http.ListenAndServe(":8080", router)` or an unconfigured `&http.Server{}` passes local testing but collapses under production conditions. Production reliability in Go does not require heavy web frameworks; it requires applying the configuration primitives built directly into `net/http`.

```go
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"syscall"
	"time"

	"github.com/google/uuid"
)

type contextKey string

const (
	RequestIDKey contextKey = "request_id"
	MaxBodyBytes int64      = 1 << 20 // 1 MB limit
)

// 1. Explicit Timeouts: Protects against Slowloris and stalled connections
func NewServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 3 * time.Second,  // Defends against Slowloris attacks
		ReadTimeout:       5 * time.Second,  // Bounds body reading duration
		WriteTimeout:      10 * time.Second, // Sized for slowest legitimate response
		IdleTimeout:       120 * time.Second,// Keep-alive socket lifecycle
	}
}

// 2. Panic Recovery Middleware: Traps unhandled panics and returns 500
func RecoveryMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					logger.Error("panic recovered in HTTP handler",
						"error", rec,
						"stack", string(debug.Stack()),
						"path", r.URL.Path,
					)
					http.Error(w, "internal server error", http.StatusInternalServerError)
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// 3. Request Body Size Limits: Terminates TCP socket if payload exceeds ceiling
func LimitBodyMiddleware(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			next.ServeHTTP(w, r)
		})
	}
}

// 4. Correlation ID Injection: Attaches traceable request identifiers
func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := r.Header.Get("X-Request-ID")
		if reqID == "" {
			reqID = uuid.NewString()
		}
		ctx := context.WithValue(r.Context(), RequestIDKey, reqID)
		w.Header().Set("X-Request-ID", reqID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// 5. Concurrency Limiter: Provides deterministic backpressure (HTTP 503)
func ConcurrencyLimitMiddleware(limit int) func(http.Handler) http.Handler {
	sem := make(chan struct{}, limit)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
				next.ServeHTTP(w, r)
			default:
				w.Header().Set("Retry-After", "5")
				http.Error(w, "service unavailable: overloaded", http.StatusServiceUnavailable)
			}
		})
	}
}

// 6. Context-Aware Handlers: Canceling work when clients disconnect
func ContextAwareHandler(dbQueryFunc func(context.Context) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		if err := dbQueryFunc(ctx); err != nil {
			if errors.Is(err, context.Canceled) || ctx.Err() != nil {
				// Client closed connection; terminate without writing response
				return
			}
			http.Error(w, "query failed", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}
}

// 7. Graceful Shutdown: Drains in-flight requests on SIGTERM/SIGINT
func RunServer(srv *http.Server, logger *slog.Logger) error {
	serverErr := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-serverErr:
		return err
	case sig := <-stop:
		logger.Info("shutdown signal received", "signal", sig.String())
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}
```

The subtlety in production graceful shutdown involves detached asynchronous work. If an endpoint must persist an audit event or dispatch an email after writing the HTTP response, using `r.Context()` fails because it is canceled when the response completes. Reaching for `context.Background()` strips trace baggage and correlation IDs. The standard Go 1.21+ solution is `context.WithoutCancel(r.Context())`, which preserves structured context values while detaching the deadline and cancellation tree.

### Quick Reference: REST API Pitfalls

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| Breaking changes | Client crashes | Version your API, never change shapes |
| Enumeration attacks | User data scraped | Consistent responses for all cases |
| Request body bombs | Server OOM | MaxBytesReader, size limits |
| Timing oracles | Information leakage | Constant-time responses, background jobs |
| JSON injection | Privilege escalation | Always use proper JSON marshaling |
| Missing pagination | Slow endpoints, OOM | Cursor-based pagination |
| No idempotency | Duplicate operations | Idempotency keys for mutations |
| Verbose errors | Information disclosure | Generic errors to clients, detailed logs |

### Junior → FAANG: Learning to See Pitfalls as Liability Curves

Each pitfall above describes a concrete incident with a dollar cost. Learn to see them as liability curves, not as rules. A rule says "add MaxBytesReader." A liability curve says "every unbounded input on every public endpoint is a CVE waiting for a fuzzer."

Prerequisite gaps to close. First, threat modeling basics. STRIDE (spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege) is a checklist you walk every endpoint through. The five pitfalls above map directly. Breaking changes are not STRIDE, they are SRE risk. Enumeration is information disclosure. Body bombs are denial of service. Timing oracles are information disclosure. JSON injection is tampering plus elevation of privilege. Learn STRIDE by walking through your own endpoints out loud.

Second, constant-time thinking. You cannot write secure authentication without understanding that a branch on user existence leaks user existence through timing. The fix is not "make both paths fast." It is "make both paths indistinguishable." That means computing the fake hash even when the user does not exist, and measuring the two paths with `time.Since` in tests that fail the build if the ratio exceeds 1.1.

Third, JSON encoding hygiene. Never concatenate strings into JSON. Ever. Not for logs, not for responses, not for debug output. Always `json.Marshal`. This is a reflex, not a rule.

Worked example, entry-point drill. Prompt: "here is a login handler, what is wrong with it." You must spot three things. The timing difference between found and not-found branches. The error message that distinguishes between wrong email and wrong password. The lack of rate limit per IP plus per account. Answering all three in under two minutes is L4 bar.

"Why did this fail" reflex on pitfalls. An incident report lands on your desk saying attackers enumerated 50M usernames. Your first question is not "what is the fix." It is "what signal distinguished existent from non-existent users." The signal could be status code, response body, timing, or header. Walk all four. Fix whichever one leaked. This mental model applies to every information-disclosure bug you will ever see.

First-job context. You will inherit a codebase with all eight pitfalls above present. Do not file a single 50-item PR to fix them all. File one PR per pitfall, with tests that fail on the current code and pass on the fix. That pace makes review tractable and produces a commit log that tells the security story.

Interview entry-point. "Walk me through how you would audit an endpoint for security issues." The L4 answer is STRIDE plus the eight pitfalls above, walked aloud, with specific fixes named. Rehearse this on a sample endpoint until it is muscle memory.

### Senior @ FAANG: Pitfalls as Governance and Detection

At staff and principal level the question is not "did you fix this pitfall." It is "does your platform make this pitfall impossible to ship." That distinction is the entire staff-engineering lens on security.

Governance artifacts per pitfall. Breaking changes caught by `openapi-diff` or `buf breaking` in CI, gated on the PR label. Enumeration attacks caught by a security review checklist plus a code scanner that flags divergent responses between "not found" and "forbidden." Body bombs caught by a mandatory gateway-level size limit (1MB default, opt-in larger with security review sign-off). Timing oracles caught by a test harness that measures p50 latency between two code paths and fails the build if the ratio exceeds threshold. JSON injection caught by a linter that bans `fmt.Fprintf(w, ...)` with a raw-string format containing curly braces. Pagination absence caught by a Spectral rule that requires pagination schema on every list endpoint. Idempotency absence caught by a Spectral rule that requires `Idempotency-Key` header declaration on every POST. Verbose errors caught by a top-level recovery middleware that replaces all 5xx bodies with a generic message plus request ID.

ADR template for each pitfall. Context: the incident class and its blast radius. Decision: the platform-level control. Consequences: what is now impossible, what exceptions are allowed, who approves them. Alternatives: detection versus prevention, centralized versus federated enforcement. Review cadence: quarterly audit with a dashboard.

Maturity model on security pitfalls. L1: team is unaware. L2: team knows from incidents. L3: team has written a checklist. L4: CI fails the build on violation. L5: platform makes the pitfall structurally impossible (e.g., the gateway strips unbounded bodies before they reach any service). Move one level per year.

Bar-raiser prompt, "you just inherited 500 endpoints, how do you harden them without breaking production." Answer in phases. Phase 1, detect. Run Spectral against the OpenAPI, run `openapi-diff` against the previous release, run a fuzzer against the auth paths, run a timing-oracle test against the login paths. Produce a P0/P1/P2 report with owners and due dates. Phase 2, contain. Deploy gateway-level body size limits, rate limits, and auth requirements as defaults, with per-endpoint opt-outs that require security review sign-off. This buys time. Phase 3, fix. Per-endpoint owner files the PR, with regression tests, within the due date. Phase 4, prevent. Ship the platform artifacts (linters, middleware, review workflow) that make new endpoints compliant by default. Phase 5, verify. Quarterly re-audit with the same tooling, measure regression rate, report to the API review board.

Detection tooling worth building or buying. OpenAPI schema fuzzer (schemathesis). Contract test runner (Pact). Breaking-change detector (`openapi-diff`, `buf breaking`). Security-focused Spectral ruleset (the community OWASP API Security ruleset, or your own). Timing-oracle test harness (custom, thirty lines of Go). JSON injection scanner (custom linter on AST, bans raw-format writes to `http.ResponseWriter`). Body-bomb regression test (fuzz every endpoint with 100MB payload, confirm 413). Enumeration tester (automated A/B of valid and invalid inputs with response diff).

Organizational placement. Security is everyone's job, but the API platform team owns the controls. The security team owns the threat model and the audit cadence. Product teams own the per-endpoint fixes. The API review board adjudicates exceptions. Document this in a written charter.

Principal-level instinct. Pitfalls recur not because engineers forget but because the platform makes the unsafe default easy. Every pitfall above can be structurally eliminated by a gateway feature, a middleware default, or a linter rule. The principal's job is to identify which structural investment has the highest risk-reduction per engineer-quarter and fund it. That ranking is the principal contribution, not the fix itself.

Deprecation of unsafe patterns. The pitfalls catalog is a deprecation roadmap. Each pitfall has a "legacy pattern" and a "new default." Publish the new defaults. Announce a sunset for the legacy patterns. Enforce through the middleware stack. Audit quarterly. Track regression rate. This is slow work, measured in years, and it is the actual shape of security-at-scale.

---
