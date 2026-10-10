## Summary

- **OAuth 2.0 flows**: Use Authorization Code + PKCE for user-facing apps and Client Credentials for service-to-service. Never use the Implicit flow in new systems.
- **OpenID Connect (OIDC)**: Builds on OAuth 2.0 to add identity: the ID token carries user claims. Validate `iss`, `aud`, `exp`, and `nonce` on every token.
- **JWT best practices**: Sign with RS256 or ES256 (asymmetric) in distributed systems. Keep access tokens short-lived (15 minutes) and validate algorithm, issuer, audience, and expiry on every request.
- **Token refresh and rotation**: Issue refresh tokens with rotation: invalidate the old token on use and detect reuse as a compromise signal. Store refresh tokens securely (HttpOnly cookie or encrypted DB).
- **RBAC**: Map users to roles and roles to permissions. Check permissions at both the HTTP handler and the service layer to prevent bypasses through internal API calls.
- **ABAC and policy engines**: Use attribute-based policies (OPA, Cedar) when permissions depend on resource attributes or environmental context that static role assignments cannot express.
- **Zanzibar / ReBAC at scale**: For relationship-based access (Google Docs-style sharing), model permissions as relationship tuples and evaluate them with a distributed checker for single-digit-millisecond latency at scale.
- **Multi-tenancy isolation**: Always filter every query by `tenant_id`. Propagate tenant context through middleware so it is never accidentally omitted in service calls or background jobs.
- **Session security**: Use HttpOnly, Secure, and SameSite=Strict cookies. Set session timeouts. Invalidate server-side session records on logout, not just the client cookie.
- **Auth observability**: Log all authentication failures, permission denials, and token issuances with user ID and IP. Alert on anomalous failure rates to detect credential stuffing and privilege escalation attempts.

### Junior → FAANG: Auth Summary as Your Interview Quick Reference

The summary above is the distillation of this chapter's most important points. Before any FAANG interview that involves auth, review this summary and ensure you can elaborate on every bullet.

**Gap to close:** The session security bullet is commonly underweighted by juniors who focus on JWT. Session security matters even when using JWTs: the refresh token is effectively a session credential, and it must be stored in an HttpOnly, Secure, SameSite=Strict cookie (not localStorage). Engineers who store refresh tokens in localStorage are creating an XSS vulnerability that exposes session persistence.

**Interview habit:** For any auth-related interview question, mentally scan the summary before answering. Does your answer address the relevant bullet? Is there a bullet you should mention that the question did not explicitly ask about? Proactively addressing adjacent concerns (for example, mentioning refresh token rotation when asked about JWT access tokens) signals depth.

### Senior @ FAANG: Auth Summary as an Org-Wide Standard

At senior level, the auth summary is not a personal reference: it is the foundation of your organization's authentication and authorization engineering standard.

**Standard development:** Convert the summary into a formal engineering standard document. Each bullet becomes a section with: the required implementation pattern, the rationale, a code example, the forbidden alternatives, the enforcement mechanism, and the review cadence. The document has a version number and a history. Changes go through a review process involving at least one security engineer.

**Auth observability as a security signal:** The last bullet (auth observability) is the most strategic. Authentication and authorization logs are your primary signal for detecting account compromise, privilege escalation, and unauthorized data access. At staff level, define the auth log schema, the SIEM detection rules, the alert thresholds, and the incident response procedures for each alert type. Auth observability is not an afterthought: it is an incident response capability that determines how quickly you detect and respond to auth-related security incidents.

---

## Navigation

- **Previous**: [Chapter 111: Zero-Trust Architecture](../chapter-111-zero-trust/14-summary.md)
- **Part Intro**: [Part XVII-A: Security](../00-part-intro.md)
- **Next**: [Chapter 112B: OAuth 2.0 & OIDC Complete Implementation Guide](../chapter-112b-oauth-oidc-complete/00-introduction.md)
