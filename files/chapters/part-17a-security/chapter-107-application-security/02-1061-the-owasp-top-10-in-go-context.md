## 107.1 The OWASP Top 10 in Go Context

The Open Worldwide Application Security Project (OWASP) maintains a list of the most critical security risks to web applications. Let's examine each vulnerability through the lens of Go development.

### OWASP Top 10 (2021 Edition)

The OWASP Top 10 catalogs the most critical and prevalent web application security risks, serving as the baseline security checklist for any production web service. The following examples demonstrate Go-idiomatic defenses against each category, integrated into the standard request handling pipeline.

```
┌─────────────────────────────────────────────────────────────┐
│                    OWASP Top 10 (2021)                      │
├─────────────────────────────────────────────────────────────┤
│ A01 - Broken Access Control                                 │
│ A02 - Cryptographic Failures                                │
│ A03 - Injection                                             │
│ A04 - Insecure Design                                       │
│ A05 - Security Misconfiguration                             │
│ A06 - Vulnerable and Outdated Components                    │
│ A07 - Identification and Authentication Failures            │
│ A08 - Software and Data Integrity Failures                  │
│ A09 - Security Logging and Monitoring Failures              │
│ A10 - Server-Side Request Forgery (SSRF)                    │
└─────────────────────────────────────────────────────────────┘
```

### A01: Broken Access Control in Go

Access control ensures users can only access resources they're authorized to view. Common failures include:

```go
// WRONG: Direct object reference without authorization check
func GetUserProfile(w http.ResponseWriter, r *http.Request) {
    userID := r.URL.Query().Get("id")

    // Dangerous: No check if requesting user can access this profile
    user, err := db.GetUser(userID)
    if err != nil {
        http.Error(w, "User not found", http.StatusNotFound)
        return
    }

    json.NewEncoder(w).Encode(user)
}

// RIGHT: Verify authorization before access
func GetUserProfile(w http.ResponseWriter, r *http.Request) {
    requestingUserID := GetUserIDFromSession(r)
    targetUserID := r.URL.Query().Get("id")

    // Check if user can access this profile
    if !CanAccessProfile(requestingUserID, targetUserID) {
        http.Error(w, "Forbidden", http.StatusForbidden)
        return
    }

    user, err := db.GetUser(targetUserID)
    if err != nil {
        http.Error(w, "User not found", http.StatusNotFound)
        return
    }

    json.NewEncoder(w).Encode(user)
}
```

**Production Pattern: Middleware-based Authorization**

```go
package middleware

import (
    "context"
    "net/http"
)

type Permission string

const (
    PermissionRead   Permission = "read"
    PermissionWrite  Permission = "write"
    PermissionDelete Permission = "delete"
    PermissionAdmin  Permission = "admin"
)

type contextKey string

const userContextKey contextKey = "user"

// RequirePermission enforces permission checks at middleware level
func RequirePermission(perm Permission) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            user, ok := r.Context().Value(userContextKey).(*User)
            if !ok {
                http.Error(w, "Unauthorized", http.StatusUnauthorized)
                return
            }

            if !user.HasPermission(perm) {
                http.Error(w, "Forbidden", http.StatusForbidden)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// User represents an authenticated user with permissions
type User struct {
    ID          string
    Permissions map[Permission]bool
}

func (u *User) HasPermission(perm Permission) bool {
    // Admin has all permissions
    if u.Permissions[PermissionAdmin] {
        return true
    }
    return u.Permissions[perm]
}

// WithUser returns a new context with the user attached.
func WithUser(ctx context.Context, u *User) context.Context {
    return context.WithValue(ctx, userContextKey, u)
}
```

### Junior → FAANG: Reading the OWASP Top 10 as a Checklist

The OWASP Top 10 is the most referenced security document in backend interviews. Every junior joining a FAANG-adjacent company should be able to name each category, describe what it means, and name the Go-idiomatic control for it.

**Common gap:** Juniors often know A03 (Injection) well because SQL injection is widely taught, but they are vague on A01 (Broken Access Control), which has been the number one risk since 2021. Broken access control means a user can access resources or perform actions beyond their granted permissions. In Go, the most common form is a handler that checks authentication (is the user logged in?) but not authorization (is this user allowed to access this specific resource?). Always check both.

**Worked example:** A handler that fetches `/orders/{id}` and returns the order without verifying that the order belongs to the authenticated user is a broken access control vulnerability. The fix is one line: `if order.UserID != authedUser.ID { return 403 }`. Simple to fix, catastrophic to miss.

**Interview framing:** When asked "how do you approach security in a new feature?", start with "I map the feature to the OWASP Top 10 and identify which categories are relevant." This signals structured thinking. Then describe the controls you apply for each relevant category.

### Senior @ FAANG: Operationalizing OWASP at Organization Scale

The OWASP Top 10 is a starting point, not a finish line. Senior engineers at FAANG companies treat it as the floor, not the ceiling, and they build organizational processes that ensure every service clears it automatically.

**ADR application:** When adopting a new framework or RPC layer, write an ADR that explicitly maps framework features to OWASP categories. For example: "We are adopting ConnectRPC. It does not provide built-in CSRF protection (A01/A08 relevant for browser clients) so we will add a CORS policy and require Origin header validation at the gateway layer." This kind of documented reasoning is what separates a senior architectural decision from a junior framework preference.

**Threat modeling integration:** The OWASP Top 10 maps directly onto STRIDE categories used in threat modeling. Broken Access Control maps to Elevation of Privilege. Injection maps to Tampering. Cryptographic Failures map to Information Disclosure. When you run a threat modeling session for your service, use the OWASP categories as a structured enumeration to ensure completeness. Any threat model that does not address all 10 categories is incomplete.

**Governance and measurement:** Staff engineers track OWASP findings as metrics: number of A01 findings in SAST per quarter, mean time to remediate critical injection findings, percentage of services with broken access control tests in their integration suite. These metrics appear in security review boards and OKR reviews. If you cannot measure it, you cannot manage it.

**Bar-raiser signals:** A strong L6 candidate will say: "After an incident involving broken access control, I ran a full audit of resource-level authorization across 40 services. I found 12 gaps, wrote a shared middleware that enforced ownership checks declaratively, and retrained the team on the pattern. Six months later the same SAST rule had zero findings org-wide." That answer demonstrates scope, systemic thinking, and measurable outcome. It is categorically different from "I fixed the bug in our service."

---
