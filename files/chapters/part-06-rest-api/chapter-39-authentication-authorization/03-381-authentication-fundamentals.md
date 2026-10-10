## 39.1 Authentication Fundamentals

### Authentication vs Authorization

**Authentication (AuthN)** answers "Who are you?" and happens first, verifying identity via username/password, OAuth tokens, or API keys. **Authorization (AuthZ)** answers "What can you do?" and happens after, enforcing permissions via RBAC, ABAC, or ACLs.

Key domain types used throughout this chapter:

```go
// User represents an authenticated user
type User struct {
    ID       string   `json:"id"`
    Email    string   `json:"email"`
    Roles    []string `json:"roles"`
    TenantID string   `json:"tenant_id,omitempty"`
    Scopes   []string `json:"scopes,omitempty"` // For API key auth
}

type Permission struct {
    Resource string // e.g., "posts", "users"
    Action   string // e.g., "read", "write", "delete"
}
```

### Common Authentication Methods

Bearer token extraction and constant-time comparison are used across all auth methods:

```go
// ... imports omitted for brevity (crypto/subtle, encoding/base64, errors, net/http, strings)

// BearerToken extracts Bearer token from Authorization header
func BearerToken(r *http.Request) (string, error) {
    auth := r.Header.Get("Authorization")
    if !strings.HasPrefix(auth, "Bearer ") {
        return "", ErrNoCredentials
    }
    return auth[7:], nil
}

// SecureCompare performs constant-time comparison (prevents timing attacks)
func SecureCompare(a, b string) bool {
    return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
```

### Junior → FAANG: prerequisite concepts for authentication fundamentals

Three concepts in the snippet above are doing a lot of silent work. Understand them before you write your first auth handler.

Constant-time comparison is a real defense, not a ceremony. A naive `a == b` string compare in Go short-circuits at the first mismatched byte. An attacker who can time your responses at microsecond resolution can walk a secret byte by byte by sending guesses and observing which one takes slightly longer to reject. `crypto/subtle.ConstantTimeCompare` looks at every byte regardless of early mismatches, so the response time is independent of where the mismatch occurred. Use it for comparing API keys, password hashes, HMAC tags, and CSRF tokens. Never use `==` or `bytes.Equal` for secrets.

Bearer semantics mean "whoever holds this token is the user". There is no additional proof of possession on a plain bearer token, which is why stealing one through a logging mistake, a proxy misconfiguration, or an XSS attack is game over until the token expires. This is the entire reason passkeys, DPoP, and mTLS-bound tokens exist. Until you adopt one of those, treat bearer tokens like cash. Never log them, never put them in URLs (they leak into referer headers and server access logs), never store them in `localStorage` if an `HttpOnly` cookie will do.

`Authorization: Bearer <token>` is the standard header per RFC 6750. Clients that invent their own header (`X-Auth-Token`, `Token`, `Session`) are doing it wrong and will interop badly with every reverse proxy, observability tool, and SDK in the ecosystem. Stick to the standard.

For a first worked exercise, extend the snippet with a middleware that extracts the Bearer token, looks it up in an in-memory map, attaches the user to `context.Context`, and calls the next handler. Then add a second middleware that reads the user from context and rejects the request with 403 if `user.Roles` does not contain a required role. Run it against three users with different roles and watch the log lines. You have now built the smallest useful authn plus authz stack in Go, and every production system is a variation on this pattern.

### Senior @ FAANG: fundamentals that the snippet is silent about

The `User` struct and two helper functions above are fine as a teaching scaffold, but a staff engineer reviewing this design has at least seven objections, and each is a real production concern.

First, the `User` struct leaks an anti-pattern. `Roles []string` and `Scopes []string` as string slices invite typos and make refactoring dangerous. A change from `"admin"` to `"administrator"` compiles clean and silently breaks every authorization check. The discipline is typed constants or an enum-like custom type, plus a central registry that every check routes through. At FAANG scale this becomes a policy language (Cedar, Rego for OPA, Zanzibar relations) so that policy authors are not Go engineers and policy decisions are auditable without reading Go code.

Second, `TenantID` as an optional string with `omitempty` is a data integrity footgun. In a multi-tenant product, every request outside a small allow-list of global endpoints has a tenant. Making the field optional means a bug that forgets to populate it results in unfiltered queries that leak cross-tenant data. The correct design is a required, validated field with a specific sentinel (`TenantGlobal`) for the handful of truly tenant-free endpoints, and a linter that rejects queries without a tenant predicate. Large multi-tenant SaaS teams converge on exactly this pattern.

Third, `BearerToken` accepts any non-empty token after the prefix. It does not reject the `Bearer ` prefix with trailing whitespace, does not handle `bearer ` lowercase (HTTP headers are case-insensitive for the field name but the scheme token should be compared case-insensitively per RFC 9110), and does not length-limit the token. A malicious client sending a 10 MB `Authorization` header can exhaust memory before the token is ever validated. The production version rejects tokens over a hard limit (4 KB is generous), uses `strings.EqualFold` on the scheme, and handles the `token68` syntax from RFC 9110 correctly.

Fourth, `SecureCompare` is correct for bytes of equal length but reveals length through early return. `crypto/subtle.ConstantTimeCompare` returns 0 for unequal lengths without looking at the bytes, which is fine for HMAC tags (fixed length) but leaks length for variable-length secrets. For API keys use a fixed-length, hex-encoded or base64url-encoded key so lengths always match. For password hashes always hash the input before comparison so the comparison is always over the hash's fixed output length.

Fifth, there is no rate limit on credential verification. An attacker with a list of 10 million leaked email-password pairs (credential stuffing is the dominant account takeover vector in 2026) will hammer your login endpoint at tens of thousands of requests per second unless you stop them. Production auth endpoints have per-IP, per-account, and global rate limits with sliding windows, plus CAPTCHA or proof-of-work challenges after a threshold, plus account lockout with a time-based cooldown. Netflix and Cloudflare publish their credential stuffing defense playbooks. Read them.

Sixth, there is no audit log. Every authentication attempt (successful or failed) at a senior company is logged with structured fields: user ID, IP, user agent, geo, device fingerprint, outcome, reason code. These feed an anomaly detection system that triggers MFA step-up on risky signals (new device, impossible travel, tor exit node). The auth handler is the most security-critical piece of code in your service and the one where "I forgot to log it" gets you fired after an incident.

Seventh, the design assumes one primary factor. In 2026, authentication is multi-factor by default for any application with PII, money, or enterprise data. The factor model is know plus have plus are, where any two satisfy MFA, and passkey plus device biometric satisfies both have and are in a single ceremony which is why platform vendors are pushing passkeys as a complete single-step MFA replacement. A senior design for this chapter would show a state machine: primary factor succeeds, evaluate risk, optionally require a second factor, issue a token whose claims encode which factors were used (`amr: [pwd, otp]`), and let downstream authorization decisions consult those claims. This is the `amr` and `acr` mechanism from OIDC and it is how step-up authentication is implemented at scale.

---
