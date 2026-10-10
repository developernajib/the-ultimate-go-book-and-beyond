### CLAUDE.md Specification: Security Rules

Security rules are non-negotiable guardrails the assistant must never cross:

```markdown
## Security Rules
- NEVER log credit card numbers, CVVs, or full SSNs
- NEVER paste real cardholder data, credentials, or production dumps
  into a prompt. Use synthetic fixtures when asking for help.
- All user input must be validated in the handler layer
- SQL queries must use parameterized queries
- JWT tokens must be validated on every request
- Rate limiting is required on all public endpoints
```

Note the second rule, which is about the assistant rather than the code. A context file is read by a tool you are pasting code into, so it is the natural place to write down what must never be pasted. The rest of the rules constrain what the service does - that one constrains what you do.

### Junior → FAANG: Payment Service Security Rules as PCI DSS Context

The first security rule (NEVER log credit card numbers, CVVs, or full SSNs) is a PCI DSS requirement for any service that handles payment card data. PCI DSS (Payment Card Industry Data Security Standard) is the compliance framework that governs how payment data must be handled, stored, and transmitted. Engineers working on payment services at FAANG companies must understand PCI DSS requirements and their implementation: what data must be masked or tokenized, what encryption is required at rest and in transit, what access controls are required, and what audit logging must be maintained. FAANG interviews for payment engineering roles specifically test PCI DSS knowledge.

The JWT validation rule (validated on every request) is the authentication baseline for any API that serves authenticated users. "Every request" means the validation middleware runs before the request reaches any handler that requires authentication, not just some handlers. Missing JWT validation on a single endpoint creates an authentication bypass vulnerability that attackers can exploit. Knowing how to implement this correctly in Go (middleware that checks the Authorization header, validates the JWT signature and expiration, and propagates the user ID through the request context) is authentication implementation fluency.

### Senior @ FAANG: Payment Security Rules as Compliance Governance

At senior level, payment security rules are compliance governance artifacts that must be verified through automated testing and periodic audit. "NEVER log credit card numbers" is enforced by a log scanning tool that rejects log messages containing patterns matching credit card number formats. "JWT validated on every request" is enforced by a security test that calls every authenticated endpoint without a JWT and verifies a 401 response. These automated verification mechanisms transform security rules from advisory guidelines into enforceable policies.

The prompt-hygiene rule is the one that resists this treatment, and it is worth being honest about why. You cannot unit-test what an engineer pasted into a chat window. The controls that exist are organizational rather than technical: an enterprise agreement that governs retention and training on your data, tooling configured so that secrets are not in the files the assistant reads in the first place, and a culture where "I pasted a prod dump into a prompt to debug it" is something people report rather than hide. Treat a leak here exactly as you would any other disclosure to a third party, because that is what it is. The rule belongs in the context file anyway, because writing it down is what makes it a rule rather than an assumption. Building and maintaining these verification mechanisms is the security engineering contribution that keeps the payment service compliant as new endpoints are added by engineers who may not be security experts.
