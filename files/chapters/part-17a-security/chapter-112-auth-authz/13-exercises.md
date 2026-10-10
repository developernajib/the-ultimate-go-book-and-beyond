## Exercises

1. **OAuth 2.0 Authorization Code + PKCE Server**: Implement a complete OAuth 2.0 authorization server in Go that supports the authorization code flow with PKCE (S256 only). The server must issue opaque authorization codes (stored in Redis with a 60-second TTL), exchange them for access tokens (RS256 JWTs, 15-minute expiry) and refresh tokens (256-bit random, 30-day expiry with rotation), and expose RFC 7009 token revocation. Expected outcome: a spec-compliant server that passes a standard OAuth 2.0 conformance test suite.

2. **JWT Validation Middleware with JWKS Rotation**: Write an HTTP middleware that validates RS256 JWT access tokens by fetching the issuer's JWKS endpoint, caching keys by `kid` for 5 minutes, and automatically refetching when an unknown `kid` appears (key rotation). The middleware must validate `iss`, `aud`, `exp`, `nbf`, and `jti` claims and return structured RFC 6750 error responses. Expected outcome: middleware that handles key rotation transparently and rejects every category of invalid token with the correct HTTP status and `WWW-Authenticate` header.

3. **RBAC Enforcement Layer**: Design a role-based access control system with hierarchical roles (e.g., `viewer < editor < admin`) stored in PostgreSQL. Implement a `Can(userID, action, resource string) bool` function backed by a Redis cache with a 1-minute TTL. Wire it as middleware that checks permissions at both the HTTP handler layer and the service layer to prevent direct function call bypasses. Expected outcome: a dual-layer enforcement system where removing a role in the DB propagates to cache within one TTL interval and all subsequent requests are correctly denied.

4. **Multi-Tenant Token Isolation**: Extend a JWT-based API to support multiple tenants where each token encodes a `tenant_id` claim. Implement a repository layer that automatically scopes every database query to the tenant extracted from the request context, making it impossible to query across tenant boundaries without an explicit admin override. Write integration tests that attempt cross-tenant data access and assert they receive 403 responses. Expected outcome: provably isolated tenants with no shared data leakage, verified by a test suite that deliberately attempts boundary violations.

5. **Token Refresh with Reuse Detection**: Implement refresh token rotation with "family" invalidation: each refresh token belongs to a family. Reusing an already-rotated token from the same family immediately invalidates all tokens in that family and logs a security event. Store families in Redis with MULTI/EXEC transactions to prevent race conditions under concurrent refresh requests. Expected outcome: a refresh endpoint that is safe under concurrency, detects token theft within one reuse attempt, and emits a structured security alert.

6. **Zanzibar-Style Relationship Authorization**: Implement a simplified Zanzibar relationship-based authorization store in Go backed by PostgreSQL. Support tuple writes (`user:alice#member@group:eng`), relation expansion (transitive membership), and a `Check(user, relation, object string) bool` query with BFS traversal. Cache check results with a configurable staleness bound. Expected outcome: a working ReBAC engine that correctly resolves multi-hop permission chains (e.g., user → group → role → resource) within a single database round-trip for cached paths.

### Junior → FAANG: Exercise 1 as a Career-Defining Project

Exercise 1 (OAuth 2.0 Authorization Server) is the most complex and most valuable exercise in this chapter. A correct, tested OAuth 2.0 Authorization Code + PKCE server demonstrates mastery of the most important auth protocol in modern software.

**Gap to close:** The hardest part of Exercise 1 is the authorization code exchange: the code must be single-use, must be associated with the PKCE verifier, and must expire. Store authorization codes in Redis with the PKCE challenge hash as the value and a 60-second TTL. On exchange, verify the PKCE verifier against the stored challenge, delete the code immediately (preventing replay), and issue the access and refresh tokens. This exact sequence is what spec-compliant OAuth servers do.

**Portfolio value:** A working, tested OAuth 2.0 server in Go is a distinctive portfolio piece. Most engineers have used OAuth. Very few have built an OAuth server. If your implementation passes the conformance test suite mentioned in the exercise, that is a strong credential that demonstrates protocol-level security knowledge.

### Senior @ FAANG: Using Exercise 1 to Evaluate L5/L6 Candidates

Exercise 1 is appropriate as a take-home interview exercise for senior engineering candidates. It reveals protocol knowledge, security thinking, and code quality simultaneously.

**L5 evaluation criteria:** The OAuth server should: implement PKCE S256 correctly (hash the verifier, compare to challenge on exchange), use opaque authorization codes stored in Redis (never predictable, never reusable), issue RS256 JWTs with correct claims (`iss`, `sub`, `aud`, `exp`, `iat`, `jti`), implement refresh token rotation, and handle error responses correctly (wrong redirect URI returns an error to the client, not a redirect). Missing any of these is a finding.

**L6 escalation question:** After reviewing the basic implementation, ask: "Your OAuth server is now shared by 50 applications with different security requirements. Some applications need MFA, some allow social login, some require client certificate authentication. How would you extend your implementation to support tenant-level auth policy configuration?" This question tests extensibility design, multi-tenancy thinking, and protocol extension understanding at the L6 level.

---
