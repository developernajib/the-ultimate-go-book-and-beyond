## 107.10 Production Pitfalls: Security Breaches That Ended Careers

### Pitfall 1: Trusting Client-Side Validation

**Incident Pattern**: An e-commerce platform validated discount codes on the frontend. Attackers used browser dev tools to bypass validation and apply 100% discounts, causing millions in losses before detection.

**The Anti-Pattern**:
```go
// WRONG: Assuming frontend validation is sufficient
func ApplyDiscount(w http.ResponseWriter, r *http.Request) {
    code := r.FormValue("discount_code")
    discount := r.FormValue("discount_percent") // User-controlled!

    // Just apply whatever the client sends
    discountPercent, _ := strconv.Atoi(discount)
    order.ApplyDiscount(discountPercent) // Attacker sends 100
}
```

**The Better Approach**:
```go
// RIGHT: Server-side validation of all business logic
func ApplyDiscount(w http.ResponseWriter, r *http.Request) {
    code := r.FormValue("discount_code")

    // Look up discount in database - single source of truth
    discount, err := db.GetDiscountByCode(r.Context(), code)
    if err != nil {
        http.Error(w, "Invalid discount code", http.StatusBadRequest)
        return
    }

    // Validate discount is still active
    if discount.ExpiresAt.Before(time.Now()) {
        http.Error(w, "Discount code expired", http.StatusBadRequest)
        return
    }

    // Validate usage limits
    if discount.UsageCount >= discount.MaxUsage {
        http.Error(w, "Discount code limit reached", http.StatusBadRequest)
        return
    }

    // Apply server-determined discount amount
    order.ApplyDiscount(discount.Percent)
}
```

**Key Insight**: Never trust any data from the client. All business logic validation must happen server-side because attackers control everything before your API receives it.

---

### Pitfall 2: Insecure Direct Object References (IDOR)

**Incident Pattern**: A healthcare portal allowed users to access patient records by changing the ID in the URL (`/patient/123` to `/patient/124`). An attacker enumerated hundreds of thousands of patient records before detection.

**The Anti-Pattern**:
```go
// WRONG: No authorization check on resource access
func GetPatientRecord(w http.ResponseWriter, r *http.Request) {
    patientID := chi.URLParam(r, "id")

    // Fetch directly without checking if user can access this patient
    patient, err := db.GetPatient(r.Context(), patientID)
    if err != nil {
        http.Error(w, "Not found", http.StatusNotFound)
        return
    }

    json.NewEncoder(w).Encode(patient)
}
```

**The Better Approach**:
```go
// RIGHT: Always verify authorization for resource access
func GetPatientRecord(w http.ResponseWriter, r *http.Request) {
    patientID := chi.URLParam(r, "id")
    userID := auth.UserIDFromContext(r.Context())

    // Check if this user can access this patient
    canAccess, err := authz.CanAccessPatient(r.Context(), userID, patientID)
    if err != nil || !canAccess {
        // Log attempted unauthorized access for security monitoring
        log.Warn("unauthorized patient access attempt",
            "user_id", userID,
            "patient_id", patientID,
            "ip", r.RemoteAddr)
        http.Error(w, "Forbidden", http.StatusForbidden)
        return
    }

    patient, err := db.GetPatient(r.Context(), patientID)
    if err != nil {
        http.Error(w, "Not found", http.StatusNotFound)
        return
    }

    json.NewEncoder(w).Encode(patient)
}

// Use UUIDs instead of sequential IDs to make enumeration harder
// This is defense in depth, not a replacement for authorization
type Patient struct {
    ID string `json:"id"` // UUID: 550e8400-e29b-41d4-a716-446655440000
}
```

**Key Insight**: Every resource access must verify the requesting user has permission. Sequential IDs make enumeration trivial, but UUIDs are not a security measure - authorization is.

---

### Pitfall 3: SQL Injection Through Dynamic Ordering

**Incident Pattern**: A fintech API allowed sorting by column name. Attackers discovered the ORDER BY clause wasn't parameterized and extracted the entire database using CASE-based blind injection.

**The Anti-Pattern**:
```go
// WRONG: Dynamic column names in SQL
func ListTransactions(w http.ResponseWriter, r *http.Request) {
    sortBy := r.URL.Query().Get("sort") // User input!
    order := r.URL.Query().Get("order")  // "ASC" or "DESC"

    // SQL injection vector - ORDER BY can't be parameterized
    query := fmt.Sprintf(
        "SELECT * FROM transactions ORDER BY %s %s",
        sortBy, // "amount; DROP TABLE transactions--"
        order,
    )

    rows, _ := db.Query(query)
    // ...
}
```

**The Better Approach**:
```go
// RIGHT: Allowlist valid column names
var allowedSortColumns = map[string]string{
    "date":   "created_at",
    "amount": "amount_cents",
    "status": "status",
}

var allowedOrders = map[string]string{
    "asc":  "ASC",
    "desc": "DESC",
}

func ListTransactions(w http.ResponseWriter, r *http.Request) {
    sortParam := r.URL.Query().Get("sort")
    orderParam := strings.ToLower(r.URL.Query().Get("order"))

    // Map to allowed column or use default
    sortColumn, ok := allowedSortColumns[sortParam]
    if !ok {
        sortColumn = "created_at" // Safe default
    }

    orderDir, ok := allowedOrders[orderParam]
    if !ok {
        orderDir = "DESC" // Safe default
    }

    // Now safe to use in query - values are from allowlist
    query := fmt.Sprintf(
        "SELECT * FROM transactions ORDER BY %s %s",
        sortColumn,
        orderDir,
    )

    rows, _ := db.Query(query)
    // ...
}
```

**Key Insight**: Parameterized queries protect values but not identifiers (column names, table names). Use strict allowlists for any dynamic SQL structure.

---

### Pitfall 4: Rate Limiting Bypass Through Header Manipulation

**Incident Pattern**: A login API rate-limited by IP address. Attackers added `X-Forwarded-For` headers with random IPs, bypassing rate limiting entirely and brute-forcing thousands of accounts.

**The Anti-Pattern**:
```go
// WRONG: Trusting X-Forwarded-For without validation
func getClientIP(r *http.Request) string {
    // Attacker sends: X-Forwarded-For: 1.2.3.4
    if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
        return strings.Split(xff, ",")[0] // Spoofable!
    }
    return r.RemoteAddr
}

func RateLimitMiddleware(next http.Handler) http.Handler {
    limiter := rate.NewLimiter(10, 5) // Per what? Spoofed IP!
    limiters := make(map[string]*rate.Limiter)

    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        ip := getClientIP(r) // Can be any value attacker wants
        // ...
    })
}
```

**The Better Approach**:
```go
// RIGHT: Only trust XFF from known proxies
type TrustedProxies struct {
    cidrs []*net.IPNet
}

func NewTrustedProxies(ranges []string) *TrustedProxies {
    tp := &TrustedProxies{}
    for _, r := range ranges {
        _, cidr, _ := net.ParseCIDR(r)
        tp.cidrs = append(tp.cidrs, cidr)
    }
    return tp
}

func (tp *TrustedProxies) GetRealIP(r *http.Request) string {
    remoteIP, _, _ := net.SplitHostPort(r.RemoteAddr)

    // Only trust XFF if request came from known proxy
    if tp.isTrusted(net.ParseIP(remoteIP)) {
        if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
            // Walk backwards through chain, find first untrusted IP
            ips := strings.Split(xff, ",")
            for i := len(ips) - 1; i >= 0; i-- {
                ip := strings.TrimSpace(ips[i])
                if !tp.isTrusted(net.ParseIP(ip)) {
                    return ip
                }
            }
        }
    }

    return remoteIP // Fall back to direct connection IP
}

// Also rate limit by user ID after authentication, not just IP
func RateLimitMiddleware(tp *TrustedProxies) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Primary: Rate limit by real IP
            ip := tp.GetRealIP(r)
            if !checkIPLimit(ip) {
                http.Error(w, "Too many requests", http.StatusTooManyRequests)
                return
            }

            // Secondary: Rate limit by user after auth
            if userID := auth.UserIDFromContext(r.Context()); userID != "" {
                if !checkUserLimit(userID) {
                    http.Error(w, "Too many requests", http.StatusTooManyRequests)
                    return
                }
            }

            next.ServeHTTP(w, r)
        })
    }
}
```

**Key Insight**: X-Forwarded-For is trivially spoofable. Only trust it from known proxy IPs and use multiple rate limiting dimensions (IP + user + endpoint).

---

### Pitfall 5: Timing Attacks on Authentication

**Incident Pattern**: A security researcher discovered that a password check returned faster for non-existent users than for wrong passwords. They enumerated tens of thousands of valid usernames before attempting any password attacks.

**The Anti-Pattern**:
```go
// WRONG: Different code paths reveal information
func Login(w http.ResponseWriter, r *http.Request) {
    username := r.FormValue("username")
    password := r.FormValue("password")

    user, err := db.GetUserByUsername(r.Context(), username)
    if err != nil {
        // Returns immediately - user doesn't exist (fast)
        http.Error(w, "Invalid credentials", http.StatusUnauthorized)
        return
    }

    // Only does bcrypt compare if user exists (slow)
    if err := bcrypt.CompareHashAndPassword(
        []byte(user.PasswordHash),
        []byte(password),
    ); err != nil {
        http.Error(w, "Invalid credentials", http.StatusUnauthorized)
        return
    }

    // Success
}
```

**The Better Approach**:
```go
// RIGHT: Constant-time authentication flow
var dummyHash, _ = bcrypt.GenerateFromPassword(
    []byte("dummy-password-for-timing"),
    bcrypt.DefaultCost,
)

func Login(w http.ResponseWriter, r *http.Request) {
    username := r.FormValue("username")
    password := r.FormValue("password")

    user, err := db.GetUserByUsername(r.Context(), username)

    var hashToCompare []byte
    if err != nil {
        // User doesn't exist - use dummy hash to maintain timing
        hashToCompare = dummyHash
    } else {
        hashToCompare = []byte(user.PasswordHash)
    }

    // Always do the expensive comparison
    err = bcrypt.CompareHashAndPassword(hashToCompare, []byte(password))

    // Check both conditions - user must exist AND password must match
    if user == nil || err != nil {
        // Add small random jitter to further obscure timing
        time.Sleep(time.Duration(rand.IntN(50)) * time.Millisecond)
        http.Error(w, "Invalid credentials", http.StatusUnauthorized)
        return
    }

    // Success - also don't reveal "password changed successfully"
    // vs "email sent" differences in password reset flows
}
```

**Key Insight**: Timing differences reveal information. Authentication must take the same time regardless of whether the user exists, the password is wrong, or the account is locked.

---

### Security Pitfall Quick Reference

| Pitfall | Impact | Fix |
|---------|--------|-----|
| Client-side validation only | Business logic bypass | Always validate server-side |
| No IDOR protection | Data breach via enumeration | Check authorization on every access |
| Dynamic SQL identifiers | SQL injection | Allowlist column/table names |
| Trusting X-Forwarded-For | Rate limit bypass | Only trust from known proxies |
| Timing side channels | User enumeration | Constant-time comparisons |

### Junior → FAANG: Learning From Pitfalls Before They Happen to You

The pitfalls in this section are not theoretical. They have caused real data breaches and ended real careers. Juniors who can name them and explain their root cause in an interview demonstrate security maturity beyond their experience level.

**Gap to close:** The most important pitfall for a junior to internalize is IDOR (Insecure Direct Object Reference), which maps to OWASP A01 (Broken Access Control). It is trivially easy to implement and catastrophically easy to miss. Every handler that reads a resource by ID must verify that the authenticated user has permission to access that specific resource. "The user is authenticated" is not "the user owns this resource."

**First-job habit:** Write an authorization test for every new handler that accesses a resource. The test should attempt to access the resource with a user who did not create it and assert a 403 response. This single habit eliminates IDOR for all new code. If your current codebase does not have these tests, ask your team to add them as a quality initiative.

**Interview framing:** When an interviewer describes a scenario ("a user ID is in the URL and the handler fetches the record from the database"), recognize it immediately as an IDOR risk, describe the attack (attacker tries different IDs), and describe the fix (query with both the resource ID and the authenticated user ID as filters, or verify ownership after fetch). Recognizing the pattern quickly signals practical security thinking.

### Senior @ FAANG: Making Pitfalls Structurally Impossible

The senior security contribution for pitfalls is eliminating entire categories by design, not by training engineers to avoid individual mistakes.

**Eliminating IDOR by repository design:** If the repository layer requires the caller to pass an owner context (a user ID or tenant ID) that is applied to every query, IDOR becomes structurally harder to create. The query `GetOrder(ctx, orderID, userID)` makes authorization explicit. The query `GetOrder(ctx, orderID)` makes it optional and therefore forgettable. Design your data access layer so the authorized path is the default path and the unauthorized path requires explicit, reviewable effort.

**Eliminating timing side channels by policy:** Define an engineering standard: "All secret comparisons use `crypto/subtle.ConstantTimeCompare`. All authentication flows take a consistent response time regardless of failure reason (use dummy work to equalize timing for non-existent users)." Encode this in a code review checklist and a custom linter. The standard addresses timing attacks at the policy level so individual engineers do not need to reason about it case by case.

**X-Forwarded-For governance:** The `X-Forwarded-For` header spoofing pitfall requires an infrastructure-level solution: configure the load balancer or ingress to strip or rewrite `X-Forwarded-For` before it reaches application code. If you control the infrastructure, the application code should never need to distrust the header because the header is always trustworthy (set by the infrastructure, not the client). Document this assumption explicitly in your infrastructure runbook.

**Pitfall tracking as a metric:** Maintain a registry of known security pitfall patterns for your codebase. Each pattern has an associated detection mechanism (SAST rule, integration test pattern, or code review checklist item). Track the count of each pattern found and fixed each quarter. A pitfall with zero detections in two consecutive quarters either means it is absent from your codebase (good) or your detection mechanism is broken (bad, needs a canary test). This metric-driven approach to pitfall elimination is a staff-level security practice.

---
