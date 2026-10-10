## Summary

- **OWASP Top 10 as a baseline**: Address injection, broken authentication, insecure deserialization, and the other top risks systematically - not as a one-time audit but as continuous engineering practice.
- **Parameterised queries**: Never concatenate user input into SQL. Use `$1`/`?` placeholders in every database driver and ORM call to eliminate SQL injection at the source.
- **Input validation and sanitization**: Validate type, format, length, and whitelist-acceptable characters on every input at the service boundary - server-side, regardless of client-side checks.
- **Output encoding**: Use `html/template` (not `text/template`) for HTML rendering. Encode output in the correct context (HTML, JS, URL, SQL) to prevent XSS and injection.
- **Timing-safe comparisons**: Use `crypto/subtle.ConstantTimeCompare` for password and token comparisons to prevent timing side-channel attacks.
- **CSRF protection**: Require CSRF tokens on all state-changing HTTP methods (POST, PUT, PATCH, DELETE). Validate the token server-side on every request.
- **Rate limiting**: Apply sliding-window or token-bucket rate limits on authentication endpoints (5 attempts/min per username) and APIs to mitigate brute-force and DoS attacks.
- **Security headers**: Set `Strict-Transport-Security`, `Content-Security-Policy`, `X-Frame-Options`, and `X-Content-Type-Options` on all HTTP responses.
- **Least-privilege error messages**: Return generic error messages to clients (never expose stack traces, SQL errors, or internal paths) while logging full detail server-side with a correlation ID.
- **Static analysis in CI**: Run `govulncheck`, `gosec`, and `go vet` on every pull request to catch known CVEs and security anti-patterns before code reaches production.

### Junior → FAANG: Carrying These Principles Into Your First Job

The summary above is the distillation of everything in this chapter. If you can apply every principle in this list consistently on your first job, you will be a stronger security practitioner than the majority of engineers at most companies.

**Gap to close:** The hardest principle to internalize is "least-privilege error messages." Under deadline pressure, it is tempting to return detailed error messages that help you debug. Train yourself to separate the client-facing message (generic, safe) from the server-side log entry (detailed, with correlation ID). This separation is a professional habit that takes conscious effort to build.

**First-job habit:** On your first week at a new job, run `govulncheck` and `gosec` on the codebase. Document your findings. Share them with your team lead, framing them as "I ran the standard Go security scanner and found some items worth addressing." This demonstrates initiative and security awareness without being confrontational.

### Senior @ FAANG: Owning the Security Posture of a Product Area

At senior level, the principles in this summary are not personal practices: they are organizational commitments. Your job is to ensure that every principle is applied consistently across every service in your product area.

**Security posture as a metric:** Define a security posture score for your product area. The score is the percentage of services that pass every automated gate (govulncheck zero findings, gosec zero critical findings, security headers present, SAST passing). Track the score quarterly. Present it in your team's engineering health review. A score below 90% triggers an improvement plan. A score above 90% does not mean you are done: it means you raise the bar.

**Cross-functional security responsibility:** At L6+, security is not just an engineering concern. Data breaches have legal, regulatory, financial, and reputational consequences. Staff engineers participate in security incident response plans, data protection impact assessments (DPIAs), and compliance reviews. Understanding the business impact of the principles in this summary, beyond their technical rationale, is what separates a senior security practitioner from a senior Go developer who knows security.

**Continuous improvement:** The threat landscape evolves. The principles in this summary are correct today and will remain largely correct tomorrow, but specific implementation details change: new algorithm recommendations, new Go standard library features, new vulnerability classes. A staff engineer maintains a reading cadence (OWASP updates, Go security advisories, NIST publications) and updates team practices accordingly. Security is a process, and that process requires an owner.

---

## Navigation

- **Previous Chapter:** [Chapter 105E: Distributed Tracing Deep Dive](../../part-16b-observability-extended/chapter-105e-distributed-tracing-deep-dive/11-summary.md)
- **Part Overview:** [Part XVII-A: Security](../00-part-intro.md)
- **Next Chapter:** [Chapter 108: Cryptography in Go](../chapter-108-cryptography/00-introduction.md)
