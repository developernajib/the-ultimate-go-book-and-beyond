## Summary

Authentication and authorization essentials:

1. **JWT (`golang-jwt/jwt/v5`)**: Stateless tokens with short-lived access tokens (5-15 min), asymmetric signing (RS256/ES256) verified via JWKS, blacklisting for revocation, and strict algorithm pinning to defeat `alg: none` and RS256→HS256 confusion attacks.
2. **OAuth 2.1**: Authorization code flow with PKCE mandatory for every client. No implicit flow, no ROPC, exact-match redirect URIs, refresh-token rotation with reuse detection.
3. **API Keys**: Secure generation, peppered SHA-256 hashing (never bcrypt for high-entropy keys), prefix-based routing, scoping, and lifecycle management.
4. **RBAC vs ABAC**: RBAC with hierarchical permissions for most apps. Reach for ABAC/OPA/Cedar when policy depends on attributes (time, IP, resource ownership, department).
5. **Multi-Tenant**: Tenant ID from verified JWT claim only, enforced at middleware + repository + Postgres row-level security (defense in depth).
6. **Security Best Practices**: Argon2id (OWASP 2026 defaults), constant-time comparisons, audit logging of security events, never log raw tokens or credentials.
7. **MFA & Passkeys**: TOTP with recovery codes as a baseline. Passkeys/WebAuthn (`go-webauthn`) as phishing-resistant second factor or passwordless primary factor.
8. **Token Rotation**: Refresh token rotation with reuse detection: a single reuse event invalidates the entire token family.
9. **Session vs JWT**: Sessions scale with centralized Redis and give instant revocation. JWTs scale horizontally but revocation is hard, so use short TTL + rotating refresh for the best of both.
10. **Service-to-Service**: mTLS with SPIFFE/SPIRE workload identities or short-lived workload JWTs. Never share human user tokens between services.

### Junior → FAANG: What the Summary Does Not Tell You

The list above is a checklist. The skill is knowing which item to reach for when.

Decision tree for your first auth design. (1) Who are the users. Consumers, employees, or machines. Consumer means CIAM (Auth0, Clerk, Cognito). Employee means workforce SSO (Okta, Entra, Workspace). Machine means API keys plus mTLS. (2) How do they authenticate. Password plus MFA for CIAM, SSO for workforce, static secret for machines transitioning to mTLS. (3) How long are sessions. Short-lived access token plus refresh for CIAM, SSO session with IdP-driven timeout for workforce, no session for machines. (4) How is authorization checked. RBAC for less than 10 roles and simple hierarchy, ReBAC for sharing semantics, ABAC with OPA when policy depends on attributes. (5) Where does revocation live. Per-user token version counter, global counter for emergencies, denylist for individual tokens.

Prerequisite gaps. Review these before you design anything. Know the difference between `HttpOnly` and `Secure` cookies. Know what JWKS is and why it exists. Know PKCE's threat model. Know what argon2id parameters are appropriate in 2026. Know what `SameSite=Lax` does and does not protect against.

Worked example for the first-job auth ticket. "Add SSO for our enterprise customers." Do not build SAML yourself. Use WorkOS or Okta. Expose a setup flow that collects the customer's IdP metadata (IDP URL, certificate, ACS URL). Issue JIT-provisioned accounts on first login. Log every SSO attempt with success or failure. Enforce domain-based routing so `@acmecorp.com` users are forced through Acme Corp's IdP. This ticket, done well, is a senior-level signal in your first year.

"Why did this fail" reflex for the summary. If any of the ten items above is implemented but not tested in production, you have a latent bug. Write a test for each: token family revocation on reuse, PKCE rejection with wrong verifier, RBAC check at service layer, tenant isolation under RLS, constant-time compare for tokens, WebAuthn registration and authentication, session revocation on logout.

Interview entry point. "Walk me through the life of a login request." Start at the HTML form, end at the first authorized API call. Mention every decision point: password hashing, MFA challenge, session issuance, cookie attributes, CSRF token generation, redirect, JWT issuance, refresh token storage, service-to-service call with propagated identity.

### Senior @ FAANG: Summary as the Basis for an Auth Platform ADR

At staff and principal level, the summary is not a checklist, it is the outline of an Architecture Decision Record for the company's auth platform.

ADR title. "Authentication and authorization platform, v2."

Context. Company is at Series C, 500 engineers, 100 services, 10 million users, 1000 enterprise tenants. Current auth is a mix of home-grown JWT verifiers, ad-hoc session stores, and per-service RBAC. Incidents in the past year: one IDOR, two refresh-token reuse detections, one algorithm confusion near-miss, one credential-stuffing event that exceeded rate limits. Cost of status quo: two engineers full-time maintaining auth, no consistent audit log, enterprise customers blocked on SSO compliance.

Decision. Adopt WorkOS for enterprise SSO, keep Auth0 for consumer identity, build an internal authorization service based on OpenFGA, migrate all services to verify JWTs via JWKS from a single issuer, ship a standard Go library that wraps all of the above.

Alternatives considered.

- Build in-house IdP. Rejected because it costs more than WorkOS for the next three years and delays SOC 2.
- Okta for everything. Rejected because Auth0 (now Okta Customer Identity) has better consumer flows.
- Stay with per-service auth. Rejected because the incident rate is rising and there is no shared audit log.
- OpenFGA vs SpiceDB vs Cedar. Chose OpenFGA because of CNCF status, Go SDK quality, and the tuple-model matches our resource hierarchy. Cedar is attractive for its policy language but AWS-centric. SpiceDB is closest to Zanzibar but the operational burden is higher.

Consequences. Two-engineer team owns the auth platform for 12 months. Migration from per-service verifiers takes six months with one service per week. Cost of WorkOS and Auth0 is approximately $500K per year at current scale. SOC 2 Type II is attainable in nine months after adoption. Enterprise deals unlock roughly $5M in ARR in year one.

Observability. Every auth event (login, MFA, SSO, authz check, token issuance, token rotation, token revocation) emits a structured log with a correlation ID. Metrics dashboard shows login success rate, MFA challenge rate, authz check p99, token reuse rate, session count by tenant. Alerts on token reuse, authz latency breach, and failed-login spikes.

Governance. Every new OAuth client registered through a self-service portal with mandatory fields: owner, scopes, review date. Quarterly review of all clients, unused clients deprovisioned. Every external IdP integration has an ADR. Every auth-related PR requires a security review. Every auth-related incident triggers a postmortem with systemic action items.

Rollback. If WorkOS fails, fall back to per-tenant SSO via Auth0 (Auth0 supports generic SAML). If OpenFGA fails, fall back to RBAC with tenant scoping. Do not build a custom authz service because the rollback becomes "rewrite the rollback."

Review date. 18 months from adoption. Revisit vendor choices, measure against KPIs (login success, authz latency, incident rate, compliance status).

Maturity model for auth platforms. L1: per-service auth, shared secrets, no audit log. L2: shared library, JWT standardization, manual secret rotation. L3: centralized IdP, automated rotation, audit log pipeline. L4: fine-grained authorization service, self-service client registration, governance reviews. L5: zero-trust end-to-end with device identity, behavioral risk scoring, and real-time revocation broadcast.

The summary items above are not a to-do list, they are the scaffolding of this ADR. Every item maps to a component, a vendor choice, a rollout plan, and a success metric. That is what it looks like to own auth at FAANG scale.

---
