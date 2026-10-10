## 107.16 Application Security Quick Reference

This reference condenses the chapter into a single card: the OWASP Top 10 mapped to Go-specific mitigations, the secure coding checklist, header values, validation patterns, and the mistakes that show up most often in code review.
```
┌──────────────────────────────────────────────────────────────────────────────┐
│                  APPLICATION SECURITY QUICK REFERENCE                        │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  OWASP TOP 10 (2021) - QUICK FIX GUIDE                                       │
│  ─────────────────────────────────────────────────────────────────────────   │
│  Vulnerability               Go Prevention                                   │
│  A01 Broken Access Control   Middleware authz + resource-level checks        │
│  A02 Crypto Failures         crypto/rand, bcrypt, TLS 1.3                    │
│  A03 Injection               Parameterized queries, html/template            │
│  A04 Insecure Design         Threat modeling, security requirements          │
│  A05 Security Misconfig      Secure defaults, minimal permissions            │
│  A06 Vulnerable Components   go mod tidy, govulncheck                        │
│  A07 Auth Failures           bcrypt cost 12+, MFA, session mgmt              │
│  A08 Integrity Failures      Signed artifacts, SBOM                          │
│  A09 Logging Failures        Audit logging, SIEM integration                 │
│  A10 SSRF                    URL validation, IP allowlists                   │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  SECURE CODING CHECKLIST                                                     │
│  ─────────────────────────────────────────────────────────────────────────   │
│  □ Use parameterized queries (never string concat for SQL)                   │
│  □ Use html/template (never text/template for HTML)                          │
│  □ Use crypto/rand (never math/rand for security)                            │
│  □ Use subtle.ConstantTimeCompare for secrets                                │
│  □ Use bcrypt.CompareHashAndPassword for passwords                           │
│  □ Set all security headers (CSP, HSTS, X-Frame-Options)                     │
│  □ Validate all inputs on server side                                        │
│  □ Implement rate limiting on all endpoints                                  │
│  □ Check authorization on every request                                      │
│  □ Log security events for monitoring                                        │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  SECURITY HEADERS (MUST-HAVE)                                                │
│  ─────────────────────────────────────────────────────────────────────────   │
│  Content-Security-Policy     default-src 'self'; script-src 'self'           │
│  Strict-Transport-Security   max-age=31536000; includeSubDomains             │
│  X-Content-Type-Options      nosniff                                         │
│  X-Frame-Options             DENY                                            │
│  Referrer-Policy             strict-origin-when-cross-origin                 │
│  Permissions-Policy          geolocation=(), camera=()                       │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  PASSWORD/TOKEN SECURITY                                                     │
│  ─────────────────────────────────────────────────────────────────────────   │
│  Password Hash:   bcrypt.GenerateFromPassword(pwd, 12)                       │
│  Token Gen:       crypto/rand.Read(bytes) → base64.URLEncoding               │
│  Comparison:      bcrypt.CompareHashAndPassword() or subtle.ConstantTime     │
│  Session ID:      32 bytes minimum (256 bits entropy)                        │
│  API Key:         32-64 bytes, prefix with type (e.g., "sk_live_")           │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  INPUT VALIDATION PATTERNS                                                   │
│  ─────────────────────────────────────────────────────────────────────────   │
│  Email:     regexp.MustCompile(`^[a-zA-Z0-9._%+-]+@...`)                     │
│  Phone:     regexp.MustCompile(`^\+?[1-9]\d{1,14}$`)                         │
│  UUID:      regexp.MustCompile(`^[a-f0-9-]{36}$`)                            │
│  Slug:      regexp.MustCompile(`^[a-z0-9-]+$`)                               │
│  SQL Safe:  Always use $1, $2 placeholders                                   │
│  LIKE Safe: Escape %, _, \ before using in pattern                           │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  RATE LIMITING GUIDELINES                                                    │
│  ─────────────────────────────────────────────────────────────────────────   │
│  Login:             5 attempts/min per username, 10/min per IP               │
│  Password Reset:    3/hour per email                                         │
│  API (authenticated): 1000/min per user                                      │
│  API (anonymous):     60/min per IP                                          │
│  Export/Download:     5/hour per user                                        │
│  Search:              30/min per user                                        │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  COMMON MISTAKES                                                             │
│  ─────────────────────────────────────────────────────────────────────────   │
│  ✗ Trusting X-Forwarded-For without validation                               │
│  ✗ Using == to compare passwords/tokens (timing attack)                      │
│  ✗ Concatenating SQL strings (injection)                                     │
│  ✗ Using text/template for HTML (no escaping)                                │
│  ✗ Checking authorization only on GET (IDOR on POST)                         │
│  ✗ Different response timing for user exists vs wrong password               │
│  ✗ Logging sensitive data (passwords, tokens, PII)                           │
│  ✗ Relying on client-side validation only                                    │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  GO SECURITY TOOLS                                                           │
│  ─────────────────────────────────────────────────────────────────────────   │
│  govulncheck      Check for known vulnerabilities in dependencies            │
│  gosec            Static analysis for security issues                        │
│  go vet           Built-in static analysis                                   │
│  staticcheck      Extended static analysis                                   │
│  trivy            Container and filesystem vulnerability scanner             │
│  dependabot       Automated dependency updates                               │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Using Quick Reference in Code Review and Interviews

A quick reference is only useful if you can apply it under pressure. Practice until the controls in this reference are reflexive, not lookup-dependent.

**Gap to close:** For each entry in this reference, write one sentence explaining why the control exists (what attack it prevents) and one Go code snippet showing the correct implementation. When you can do this without consulting the reference, you own the knowledge.

**Interview use:** If you go blank on a security question in an interview, use this reference as a mental checklist: input validation, parameterized queries, output encoding, security headers, rate limiting, `crypto/rand`, constant-time comparison. Walking through this list systematically often triggers the specific detail the interviewer is looking for.

### Senior @ FAANG: Maintaining a Living Security Reference for Your Team

At senior level, the quick reference becomes a team document that evolves with your technology stack and threat landscape.

**Version control and ownership:** Store your team's security quick reference in version control alongside the codebase. Review it quarterly. Assign a section owner for each major category. When a new Go version introduces a security-relevant feature (for example, post-quantum TLS support), update the reference and notify the team. A stale reference is worse than no reference because it gives false confidence.

**Integration with onboarding:** New engineers should read the security quick reference in their first week. During the first code review, the reviewer should verify that the new engineer applied the relevant controls correctly. This creates a documented, reproducible security onboarding experience rather than an informal "you pick it up over time" approach.

---

In the next chapter, we'll explore **Cryptography in Go**, covering encryption, hashing, TLS, and building secure systems that protect data at rest and in transit.

Remember: Security vulnerabilities in production can cost millions and destroy user trust. The code you write today must be secure enough to withstand attacks tomorrow. In FAANG interviews and production systems, security isn't optional - it's fundamental.
