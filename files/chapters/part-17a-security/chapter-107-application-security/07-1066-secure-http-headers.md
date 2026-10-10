## 107.6 Secure HTTP Headers

Headers provide an additional layer of security against various attacks.

```go
package middleware

import "net/http"

// SecureHeaders sets security-focused HTTP headers
func SecureHeaders(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Content Security Policy - prevents XSS and injection attacks
        w.Header().Set("Content-Security-Policy",
            "default-src 'self'; "+
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "+
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "+
            "font-src 'self' https://fonts.gstatic.com; "+
            "img-src 'self' data: https:; "+
            "connect-src 'self'; "+
            "frame-ancestors 'none'")

        // Referrer Policy - controls referrer information
        w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")

        // X-Content-Type-Options - prevent MIME type sniffing
        w.Header().Set("X-Content-Type-Options", "nosniff")

        // X-Frame-Options - prevent clickjacking
        w.Header().Set("X-Frame-Options", "DENY")

        // Disable XSS filter (modern browsers handle CSP better)
        w.Header().Set("X-XSS-Protection", "0")

        // Strict-Transport-Security - enforce HTTPS
        w.Header().Set("Strict-Transport-Security",
            "max-age=63072000; includeSubDomains; preload")

        // Permissions-Policy - control browser features
        w.Header().Set("Permissions-Policy",
            "geolocation=(), microphone=(), camera=()")

        next.ServeHTTP(w, r)
    })
}
```

### Junior → FAANG: Security Headers as a Minimum Viable Defense Layer

Security headers are the lowest-effort, most valuable security control in web application development. They require one middleware and provide browser-enforced defenses that would otherwise require significant application logic.

**Gap to close:** Many juniors know about `X-Frame-Options` and `X-Content-Type-Options` but have not configured `Strict-Transport-Security` or understand why `Content-Security-Policy` matters. HSTS prevents protocol downgrade attacks (a user who navigates to `http://` being redirected to `https://` is vulnerable to interception during the redirect, HSTS tells the browser to always use HTTPS without the redirect). CSP limits what scripts and resources the browser executes even if an attacker injects content. Know both.

**First-job habit:** Add a security headers middleware to every new Go HTTP service on day one. Use a library like `secure` (github.com/unrolled/secure) rather than setting headers manually. The library handles edge cases like correctly formatting HSTS max-age and CSP directives. Verify headers using `securityheaders.com` against a staging environment before shipping.

**Interview framing:** When asked about HTTPS security in Go, mention HSTS in addition to TLS configuration. Many candidates discuss TLS cipher suites but forget that HSTS is required to prevent the first-request downgrade window. Demonstrating knowledge of both shows end-to-end thinking.

### Senior @ FAANG: Security Header Policy and Governance

At senior level, security headers are an organization-wide policy decision, not a per-service configuration. The challenge is ensuring every service applies the correct headers without requiring every team to independently research the right values.

**Shared middleware library:** Build a single `securityheaders` package that encapsulates your organization's security header policy. It exports one function: `Middleware(next http.Handler) http.Handler`. The package is versioned. When the policy changes (for example, when you adopt a stricter CSP), you update the library version in your dependency management system and all services pick up the update. Services that pin older versions show up in a compliance dashboard as out of policy. This is paved-road security.

**CSP policy management:** Content Security Policy is the most complex header to configure and maintain. In a large organization, different products have different requirements (some need third-party analytics scripts, some need inline styles for legacy reasons). Establish a CSP policy review process: any addition to the org-wide allowlist requires a security review. Additions to product-specific CSPs require documenting the business justification. Periodically audit all CSP policies against the `report-uri` or `report-to` violation data to identify directives that are more permissive than necessary.

**Reporting infrastructure:** `Content-Security-Policy-Report-Only` combined with a `report-to` endpoint gives you visibility into what a strict CSP would block before you enforce it. Build or adopt a CSP report aggregation service. This infrastructure is necessary for safe CSP migrations on established applications. Without it, switching to enforce mode is a risky deploy.

**Header audit as a compliance control:** SOC 2 and PCI DSS auditors review security header configuration as part of their assessment. Maintain a runbook that describes your security header policy, documents the rationale for each header value, and includes instructions for verifying headers in a production environment. When auditors ask, point to the runbook and the automated test in CI that verifies header presence on every deploy.

---
