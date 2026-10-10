## Learning Objectives

After completing this chapter, you will be able to:

- **Implement secure JWT authentication** with proper token generation, validation, rotation, and blacklisting strategies used by production systems
- **Build OAuth 2.0 authorization servers** supporting authorization code flow with PKCE for secure third-party integrations
- **Design API key systems** with secure generation, hashing, scoping, and lifecycle management
- **Implement role-based access control (RBAC)** with hierarchical permissions and resource-level authorization
- **Secure multi-tenant applications** with proper tenant isolation and cross-tenant access prevention
- **Apply security best practices** including Argon2 password hashing, constant-time comparisons, and audit logging
- **Handle authentication edge cases** like token refresh, session management, and graceful credential rotation

### Junior → FAANG: what to master before your first on-call

Before you own an auth-adjacent service at a senior company, you need five things cold. First, the OWASP authn versus authz split, stated crisply enough that you can explain it to a product manager in one sentence. Second, the three authentication factors (know, have, are) and why MFA requires at least two distinct categories. Third, the shape of a JWT as three base64url segments separated by dots, what goes in the header, what goes in the payload, and how the signature is computed. Fourth, the authorization code flow with PKCE as a sequence diagram you can draw on a whiteboard without notes. Fifth, the difference between a bearer token and a session cookie, and why `HttpOnly` matters.

For a first worked exercise, stand up a Go service with three endpoints. `POST /register` hashes a password with Argon2id. `POST /login` verifies the hash in constant time and returns a 15 minute JWT signed with RS256. `GET /me` validates the JWT and returns the caller's user ID. Then break it deliberately. Remove the `exp` check and see that expired tokens are still accepted. Swap the verification algorithm to accept `none` and see that unsigned tokens are accepted. Shrink the HMAC secret to eight bytes and crack a token with hashcat on your laptop. Interviewers ask about these failures because they appear in real CVEs every year.

Bookmark three references. RFC 7519 (JWT). RFC 6749 plus the OAuth 2.1 draft consolidation. The OWASP Authentication Cheat Sheet and Authorization Cheat Sheet. These are the primary sources your staff engineers will cite in design review, and reading them once beats ten tutorials.

### Senior @ FAANG: principal-track competencies for owning identity

At staff and principal you are not passing an interview. You are defining what "identity" means for a platform that thousands of services depend on, and your decisions have to survive ten years of regulatory change, breach disclosures, and acquired companies with incompatible IdPs. The competencies below are what separate an engineer who writes auth middleware from one who owns the auth substrate.

You can articulate the revocation problem and defend a chosen trade-off. Stateless JWTs cannot be revoked before `exp`. Opaque tokens can be revoked instantly but cost an introspection round-trip per request. Short-lived JWTs plus refresh rotation plus a Redis denylist is a middle ground. DPoP and mTLS-bound tokens make stolen bearers useless even before revocation. You know the latency and cost profile of each option at 100k RPS and can pick one for a specific service. This is a senior design interview question at every FAANG.

You can design a passkey rollout. The migration from password plus TOTP to passkeys touches account recovery, device loss, enterprise policy, legacy clients, and user education. You know that `go-webauthn` handles registration and assertion ceremonies, that the relying party ID must be your origin's domain or a registrable suffix of it, that attestation statements are optional and usually ignored for consumer deployments, and that Apple iCloud Keychain, Google Password Manager, and 1Password sync passkeys across devices which changes your "lost device" threat model. You can write the RFC for this migration and shepherd it through security review.

You can reason about workload identity at the mesh level. You can explain SPIFFE IDs, SVIDs (X.509 and JWT variants), SPIRE agent and server topology, and how workload attestation binds a certificate to a Kubernetes pod without a bootstrap secret. You know why Google BeyondCorp moved internal auth from network perimeter to per-request identity verification, and you can replicate the pattern at your company. You understand that service-to-service authz is usually richer than user authz because services have stable identities and predictable call graphs, which makes allow-lists feasible where they would be impossible for users.

You can choose between OIDC federation and SAML for enterprise deals. OIDC is cleaner, JSON-native, and what modern IdPs prefer. SAML 2.0 is mandatory for large enterprise buyers (banks, insurance, government) whose identity teams have invested a decade in ADFS or Ping. SCIM 2.0 handles just-in-time provisioning and deprovisioning, which enterprise security teams require to prevent orphaned accounts after an employee leaves. A staff engineer at a B2B platform owns the SAML plus SCIM integration personally or loses the deal.

You can price build versus buy honestly. You can produce a one-page memo comparing rolling your own in Go against Auth0, WorkOS, Clerk, and Stytch, with line items for engineering cost, compliance cost (SOC 2 Type II, ISO 27001, FedRAMP Moderate), ongoing CVE response, and the cost of being wrong. You know that most startups under 10 million MAU should buy, and you know the specific signals (enterprise SSO demand, custom IdP federation, extreme latency budgets, data residency requirements) that flip the answer to build.

You can run an auth incident. When a signing key leaks or a BOLA bug is disclosed, you know the rotation playbook. Rotate the active signing key, keep the old key in the JWKS for the token TTL window, revoke all outstanding refresh tokens, force re-authentication, audit access logs for the exposure window, file the disclosure with regulators if PII was touched, and write the post-mortem. You have practiced this in a game day. If you have not, schedule one this quarter.

---
