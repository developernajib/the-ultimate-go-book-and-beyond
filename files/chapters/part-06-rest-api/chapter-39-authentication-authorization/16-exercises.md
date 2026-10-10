## Exercises

1. **JWT Middleware with RS256**: Implement an HTTP middleware that validates JWTs signed with RS256. Load the public key from a PEM file at startup. Reject tokens with expired `exp`, missing `sub`, or an algorithm other than `RS256`. Attach the parsed claims to the request context. Write table-driven tests covering a valid token, an expired token, a tampered signature, and an `alg: none` attack.

2. **Refresh Token Rotation**: Build a `/auth/refresh` endpoint that accepts a refresh token, invalidates it in a database table, and issues a new access token plus a new refresh token. If the same refresh token is submitted twice (reuse detection), immediately invalidate the entire token family. Write an integration test that exercises the double-submission scenario and asserts the second request returns `401`.

3. **RBAC Permission Middleware**: Design a role-based access control system with three roles (`viewer`, `editor`, `admin`) and a set of permissions (e.g., `articles:read`, `articles:write`, `articles:delete`). Implement a `RequirePermission(perm string)` middleware factory. Write unit tests that confirm each role can and cannot access the expected endpoints without a real HTTP server using `httptest`.

4. **API Key Lifecycle Management**: Implement API key creation, listing, and revocation endpoints. Keys must be stored as bcrypt hashes, never in plaintext. On creation, return the raw key exactly once. On each request, look up the key by its SHA-256 prefix, then bcrypt-compare the full key. Write a test that asserts the raw key is never stored and that a revoked key returns `401`.

5. **TOTP Two-Factor Authentication**: Add TOTP-based MFA to a login flow. After password verification, if MFA is enabled, return a short-lived `mfa_token` (not a full session) and require a subsequent `POST /auth/mfa/verify` call with the 6-digit code. Only issue the final access token after TOTP verification. Use the `pquerna/otp` library and write a test that generates a valid TOTP code and asserts the full flow succeeds.

6. **Multi-Tenant Row Isolation**: Create a `TenantMiddleware` that extracts the tenant ID from the JWT `tenant_id` claim and stores it in the request context. Wrap every repository method so it automatically appends `WHERE tenant_id = $1` to all queries. Write an integration test that inserts rows for two tenants and asserts tenant A can never read tenant B's data.

7. **Audit Logging Interceptor**: Build a middleware that records every mutating request (`POST`, `PUT`, `PATCH`, `DELETE`) to an `audit_logs` table with columns: `id`, `user_id`, `tenant_id`, `method`, `path`, `status_code`, `ip_address`, `request_body_hash`, `created_at`. Ensure request body is read once using `io.TeeReader` so the handler still receives the body. Write a test asserting that a `DELETE /users/42` call inserts exactly one audit row.

### Junior → FAANG: How to Turn These Exercises Into Portfolio Work

These seven exercises are deliberately small enough to complete in a weekend each. To move from "I finished the exercise" to "I would ship this at FAANG," layer these practices on every one.

Structure every solution as a repository with: a `README.md` describing the problem and the threat model, a `cmd/` directory with a runnable example, a `pkg/` directory with the library code, a `docs/adr/` directory with one ADR per design decision, a `Makefile` with `test`, `lint`, `coverage`, and `bench` targets, and a GitHub Actions workflow that runs them on every push.

Prerequisite gaps. Before starting, confirm you can write a table-driven Go test, use `httptest.NewRecorder`, spin up a Postgres container with `testcontainers-go`, and run `staticcheck` and `gosec`. If any of these is unfamiliar, fix that first or the exercises will take twice as long.

"Why did this fail" reflex. After each exercise, write a one-page "red team notes" file. List every way you would try to break your own system. For exercise 1, list algorithm confusion, key-ID injection, expired-token replay, clock skew. For exercise 4, list plaintext storage, SHA-256 collision (there is none, but argue why), timing attack on lookup, revocation race. The red team file is what distinguishes a portfolio project from a tutorial follow-along.

Worked example: exercise 3 (RBAC middleware). The minimum solution has three roles hardcoded and a permission list. The portfolio solution loads roles from a database, supports role inheritance (`admin` inherits `editor` inherits `viewer`), caches role lookups with TTL, invalidates the cache on role change, and ships with a benchmark showing p99 under 100 microseconds. Add a denial log that records every failed authorization with the principal, the resource, the permission, and the timestamp. Write a fuzz test that generates random role-permission combinations and asserts inheritance is transitive.

Interview entry point. Bring one of these projects to your next interview. When asked "tell me about a project you are proud of," walk through the threat model, the ADR, and one bug you found in your own red team notes and fixed. That is a senior-level signal at L4 and a strong positive at L5.

First-job context. On day one at a real company, your first auth ticket will be a variation of one of these exercises. Exercise 2 (refresh token rotation) is the single most common intermediate auth task across the industry in 2026. Ship it once in a portfolio project, and shipping it at work becomes code review instead of design.

### Senior @ FAANG: Staff Extensions for Each Exercise

At staff and principal level, each exercise expands into a platform component. Each extension below is a multi-week project with an ADR and production-grade observability.

Staff Extension 1: JWT middleware as a shared library.

Scope. A Go library that is the single way any service in the company verifies a JWT. Loads keys from JWKS, caches for one hour with ETag-based refresh, pins algorithms, enforces required claims (`iss`, `aud`, `exp`, `nbf`, `sub`), emits metrics on every verification, and exposes a pluggable blacklist checker.

Failure modes. JWKS endpoint outage (serve from cache past TTL up to a hard cap, alert on fallback), clock skew between verifier and issuer (allow 60 seconds of skew), key rotation race (accept any currently-published key), algorithm downgrade (reject).

Staff bar. Library is adopted by every service within six months, measured by a quarterly audit. Incident rate for JWT-related bugs drops to zero in the quarter following full adoption.

Staff Extension 2: refresh token platform with reuse detection at scale.

Scope. A service that issues and rotates refresh tokens, stores them in a partitioned Redis cluster, detects reuse, broadcasts family revocation via pub/sub, and integrates with the incident response runbook.

Failure modes. Redis partition unavailable (fail closed for writes, serve reads for a bounded window), pub/sub delivery loss (periodic reconciliation against the database of record), network retry storm that looks like reuse (grace window of 60 seconds configurable per client).

Staff bar. p99 refresh latency under 20 ms at 10K RPS. Reuse detection fires within 100 ms of the second request. Zero false-positive family revocations in the first quarter.

Staff Extension 3: ReBAC authorization service (see exercise 13 Extension A). Scope is a production OpenFGA-compatible service with schema versioning, consistency tokens, and bounded staleness.

Staff Extension 4: API key platform with leaked-key detection.

Scope. An internal platform that every team uses to issue API keys. Registers the key prefix with GitHub secret scanning, integrates with TruffleHog and GitGuardian feeds, auto-revokes on detection, notifies the owning team, and logs the blast radius.

Failure modes. False positive from scanner (require two-of-three scanner consensus before auto-revoke), prefix collision across products (registry of prefixes, enforce uniqueness), revocation race with in-flight requests (grace period of 10 seconds with deprecation header).

Staff bar. Time from leak to revocation under five minutes, measured by injecting a test key into a canary public repo each quarter.

Staff Extension 5: passkey platform for the entire user base.

Scope. A phased migration from password-plus-TOTP to passkey-first authentication. Includes registration, authentication, recovery, account merging, and attestation policy.

Failure modes. User loses all passkeys (recovery via verified email plus existing TOTP plus 72-hour delay), platform authenticator versus roaming authenticator user confusion (clear UX, explicit choice), attestation policy too strict and excludes legitimate devices (allowlist major platform authenticators, track registration failures).

Staff bar. 50% of active users enrolled within 12 months. Phishing-resistant MFA coverage above 80% of admin accounts within six months. Credential-stuffing effectiveness drops by 90% measured against baseline.

Staff Extension 6: multi-tenant isolation at platform scale.

Scope. A library and runtime that guarantees tenant isolation across every service, every query, every log line. Combines JWT tenant claim, repository-level tenant enforcement, Postgres RLS, per-tenant encryption keys for regulated data, and per-tenant rate limits for noisy-neighbor control.

Failure modes. Cross-tenant query through a missing scope (block at CI with static analysis, defense in depth via RLS), tenant ID injection via request body (always read from verified JWT, never from request), per-tenant key compromise (isolated blast radius, rekey only the affected tenant).

Staff bar. Zero cross-tenant data incidents in the audit window. Passes penetration testing against IDOR and tenant-hopping attacks.

Staff Extension 7: audit log pipeline.

Scope. An audit logging service that receives events from every service, stores them in an append-only log (Kafka plus S3 plus ClickHouse for query), integrates with SIEM, supports compliance queries (who accessed what in the past 90 days), and retains data per regulatory policy (7 years for financial data, 2 years for general access logs).

Failure modes. Log backpressure (buffer up to disk, never drop), PII in log bodies (hash or redact at the producer, scan at the receiver), tampering (append-only storage, periodic hash verification, off-site backup).

Staff bar. Every mutating action across every service produces exactly one audit event. p99 write latency under 50 ms. Query latency for "user X's activity in the past 24 hours" under one second. SOC 2 audit evidence generation is self-service.

ADR template for each extension. Context, decision, alternatives (at least three), consequences, observability, rollback plan, review date.

Maturity model for exercise-driven engineering. L1 finishes the exercise. L2 adds tests and benchmarks. L3 writes the ADR. L4 extends to a production-grade platform component. L5 adopts the component across the company and measures the outcome.

Governance hook. Every staff extension above should have an owning team, an on-call rotation, an SLO, and an error budget. That is the difference between a library and a platform.
