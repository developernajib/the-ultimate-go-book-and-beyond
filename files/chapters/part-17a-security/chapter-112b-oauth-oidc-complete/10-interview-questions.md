## 112B.9 Interview Questions

**Q: What is the difference between OAuth 2.0 and OpenID Connect?**

**What FAANG expects:** OAuth 2.0 = delegated authorization. OIDC = authentication on top of OAuth 2.0. OIDC adds the `id_token` (JWT), UserInfo endpoint, and discovery document (`/.well-known/openid-configuration`). Know that OAuth 2.1 (still an IETF draft consolidating a decade of best practices) removes the implicit and ROPC grants and mandates PKCE everywhere. Bonus for naming the canonical Go libs: `golang-jwt/jwt/v5`, `coreos/go-oidc/v3`, `ory/fosite` (for building an OAuth server).

A: OAuth 2.0 is an authorization framework: it allows third-party applications to access resources on behalf of a user. It doesn't define who the user is. OpenID Connect (OIDC) is an identity layer on top of OAuth 2.0 that adds authentication. OIDC introduces the ID token (a JWT containing user identity claims), the UserInfo endpoint, and a discovery document. Use OAuth for "can this app access my data?" and OIDC for "who is this user?"

**Q: Why is PKCE required and how does it work?**

**What FAANG expects:** Prevents authorization-code interception attacks on public clients (SPAs, mobile, desktop) that cannot safely store a client secret. `code_verifier` + `code_challenge` (SHA-256 of verifier, S256 method). OAuth 2.1 mandates PKCE even for confidential clients. Bonus for knowing that a plain-text challenge method (`plain`) exists in the spec but must never be used in production.

A: PKCE (Proof Key for Code Exchange) prevents authorization code interception attacks, especially for public clients (SPAs, mobile apps) that cannot safely store a client secret. The client generates a `code_verifier` (random string), hashes it with SHA-256 to create a `code_challenge`, and sends the challenge with the authorization request. When exchanging the code for tokens, the client sends the original verifier. The server hashes it and compares, so only the legitimate client (that generated the verifier) can complete the exchange.

**Q: What is refresh token rotation and why is it important?**

A: Refresh token rotation means issuing a new refresh token on every use and invalidating the old one. This provides detection of token theft: if an attacker steals and uses a refresh token, the legitimate client's next refresh will fail (old token no longer valid), alerting the system. More importantly, if an old token is replayed, the "family" of tokens is invalidated, protecting the session even if the legitimate client hasn't rotated yet.

**Q: How do you validate a JWT access token at a resource server?**

**What FAANG expects:** Six steps: pull `kid`, fetch JWKS, verify signature (RS256 / ES256 / EdDSA), validate `iss`/`aud`/`exp`/`nbf`, check scopes, optionally introspect for revocation. Cache JWKS with short TTL. Bonus for citing `jwt.ParseWithClaims` from `golang-jwt/jwt/v5` with an explicit key function, and for calling out that allowing `alg: none` or `alg: HS256` when you expect RS256 is the canonical JWT misconfiguration (CVE-worthy).

A: (1) Extract the `kid` from the JWT header. (2) Fetch the JWKS endpoint to get the public key matching that kid. (3) Verify the JWT signature using RS256/ES256 with the public key. (4) Validate claims: `iss` matches expected issuer, `aud` contains your service's identifier, `exp` is in the future. (5) Check `scope` contains required scopes. (6) Optionally call introspection endpoint for real-time validity (adds latency).

---
