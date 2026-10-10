## 112.11 Mid-Chapter Synthesis: Core Auth Concepts Recap

### Authentication & Authorization Checklist

**OAuth 2.0 & OIDC**:
- [ ] Implement authorization code flow with PKCE for mobile/SPA apps
- [ ] Use client credentials flow for service-to-service auth
- [ ] Implement refresh token rotation for security
- [ ] Add OIDC ID tokens for user information
- [ ] Validate redirect URIs against whitelist
- [ ] Set appropriate token expiration times

**JWT Best Practices**:
- [ ] Use RS256/ES256 for signing (not HS256 in distributed systems)
- [ ] Validate algorithm, issuer, audience, expiration
- [ ] Keep access tokens short-lived (15 minutes)
- [ ] Include JTI for revocation tracking
- [ ] Never store secrets in JWT payload
- [ ] Implement token blacklist for logout

**Authorization Models**:
- [ ] Use RBAC for simple permission hierarchies
- [ ] Use ABAC for complex, context-aware policies
- [ ] Consider Zanzibar/SpiceDB for relationship-based authz at scale
- [ ] Implement proper tenant isolation in multi-tenant systems
- [ ] Cache authorization decisions with short TTL

**Security**:
- [ ] Always use HTTPS in production
- [ ] Implement rate limiting on auth endpoints
- [ ] Log authentication failures for monitoring
- [ ] Use secure session storage (Redis with encryption)
- [ ] Implement account lockout after failed attempts
- [ ] Add MFA for sensitive operations

### Junior → FAANG: Auth Checklist as a Code Review Standard

The authentication and authorization checklist is a code review standard for any PR that touches auth code. Apply it to every PR that includes new auth logic, new endpoints, or changes to existing authorization checks.

**Gap to close:** The most commonly missed checklist item for juniors is "Add MFA for sensitive operations." Many engineers implement MFA for login but forget to step up authentication for high-value operations (changing email, deleting account, approving a large transaction). Step-up authentication requires re-verification at the point of the sensitive action, not just at login.

**First-job contribution:** If your team's auth code review has no checklist, propose one based on this section. Frame it as improving consistency and reducing cognitive load for reviewers, not as adding bureaucracy. A good checklist makes reviews faster by reducing the things reviewers need to remember to check manually.

### Senior @ FAANG: Auth Checklist as an Automated Gate

At senior level, the auth checklist is the specification for automated CI gates. Each item maps to a test, a linter rule, or a pipeline check.

**Automation mapping for auth checklist:** "Verify algorithm specification" maps to a test that constructs a JWT with `alg: none` and verifies the service rejects it. "Validate all JWT claims" maps to tests with missing or invalid `exp`, `aud`, and `iss` claims. "Implement account lockout" maps to a rate limiting test that verifies lockout after N failed attempts. "Add MFA for sensitive operations" maps to integration tests that verify step-up auth is required before sensitive operations. When all items are tested automatically, the checklist verifies test completeness, not individual engineer memory.

---
