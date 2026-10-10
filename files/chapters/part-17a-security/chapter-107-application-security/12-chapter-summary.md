## 107.11 Mid-Chapter Synthesis: Core Security Concepts Recap

### Security Implementation Checklist

Shipping a Go web application to production requires systematically verifying every layer of defense, from input handling at the HTTP boundary down to the cryptographic primitives used for password storage and token comparison. The checklist below maps each security control to the specific Go package or technique that implements it, making it actionable rather than aspirational. Use it as a gate before every deployment: any unchecked item is a known vulnerability waiting to be exploited.

```
┌──────────────────────────────────────────────────────────────┐
│                  Security Checklist                          │
├──────────────────────────────────────────────────────────────┤
│ ☑ Input Validation                                           │
│   ├─ Validate all user inputs                                │
│   ├─ Enforce length limits                                   │
│   ├─ Use allowlists over denylists                           │
│   └─ Validate data types and formats                         │
│                                                              │
│ ☑ SQL Injection Prevention                                   │
│   ├─ Always use parameterized queries                        │
│   ├─ Never concatenate SQL strings                           │
│   └─ Escape LIKE patterns properly                           │
│                                                              │
│ ☑ XSS Prevention                                             │
│   ├─ Use html/template (not text/template)                   │
│   ├─ Set Content-Type headers correctly                      │
│   └─ Implement Content Security Policy                       │
│                                                              │
│ ☑ CSRF Protection                                            │
│   ├─ Implement CSRF tokens                                   │
│   ├─ Validate on state-changing requests                     │
│   └─ Use SameSite cookie attribute                           │
│                                                              │
│ ☑ Authentication & Authorization                             │
│   ├─ Use bcrypt/argon2 for passwords                         │
│   ├─ Implement proper session management                     │
│   ├─ Check authorization on every request                    │
│   └─ Use middleware for permission checks                    │
│                                                              │
│ ☑ Rate Limiting                                              │
│   ├─ Implement per-IP rate limiting                          │
│   ├─ Use token bucket algorithm                              │
│   └─ Return proper HTTP 429 responses                        │
│                                                              │
│ ☑ Secure Headers                                             │
│   ├─ Content-Security-Policy                                 │
│   ├─ X-Content-Type-Options: nosniff                         │
│   ├─ Strict-Transport-Security (HSTS)                        │
│   └─ X-Frame-Options: DENY                                   │
│                                                              │
│ ☑ Go-Specific                                                │
│   ├─ Use crypto/rand (not math/rand)                         │
│   ├─ Use subtle.ConstantTimeCompare                          │
│   ├─ Keep dependencies updated                               │
│   └─ Run 'go vet' and security scanners                      │
└──────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: Using the Checklist as a PR Gate

A security checklist is only useful if it is consulted before code ships, not after. Juniors who discover the checklist during a security review have used it too late.

**Gap to close:** Print this checklist and keep it open during development. Before submitting any PR that touches an HTTP handler, data access layer, or authentication flow, run through each item. If you cannot check a box, either implement the control or leave a comment explaining why the control does not apply and get a second opinion.

**First-job habit:** Embed the checklist directly into your team's PR template as a set of markdown checkboxes. Requiring submitters to check each box creates a forcing function for security awareness without requiring a dedicated security review on every PR.

### Senior @ FAANG: From Checklist to Automated Enforcement

At senior level, a checklist is a starting point for automation, not the end state. Every item on this checklist should map to either an automated test, a SAST rule, or a CI pipeline gate.

**Automation mapping:** `crypto/rand` usage maps to a gosec G404 rule. Parameterized queries map to gosec G201/G202. `html/template` usage is verifiable via AST analysis. Security headers map to an integration test that inspects response headers on every deploy. Dependency currency maps to `govulncheck` in CI. When automation covers every checklist item, the checklist becomes a documentation artifact rather than a manual gate, and coverage is 100% rather than "whatever the submitter remembered."

**Checklist maintenance:** Treat the security checklist as a living document with an owner and a review cadence. When a new vulnerability class emerges (a new OWASP category, a Go-specific finding from a major CVE), update the checklist and the corresponding automation. Without ownership and a review schedule, checklists become stale and misleading.

---
