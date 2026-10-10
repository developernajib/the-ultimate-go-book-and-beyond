## 39.7 Security Best Practices

### Password Hashing

Argon2id is the current winner of the Password Hashing Competition (PHC) and is preferred over bcrypt or scrypt for new systems because it resists both GPU/ASIC and side-channel attacks through its configurable memory and time parameters. bcrypt remains acceptable if you already have it deployed: it is far better than PBKDF2 and ocean-distances better than raw SHA-2. **Never** hash passwords with MD5, SHA-1, SHA-256, or any unsalted/unstretched primitive. Those are for fingerprints, not credentials. The Argon2id encoded output embeds the algorithm version, memory cost, and salt in a single self-describing PHC string, making future parameter upgrades transparent without a separate migration column. When you bump `m` or `t`, rehash on next successful login.

OWASP's 2026 minimums for Argon2id are `m=19 MiB, t=2, p=1` at the low end and `m=64 MiB, t=3, p=2` (used below) for interactive web logins on modern server hardware. Measure on your actual boxes and target ~250-500ms per hash. If you can afford more, spend it on `m` (memory) before `t` (iterations) because memory is what hurts GPU attackers.

```go
// ... imports omitted for brevity (crypto/rand, crypto/subtle, encoding/base64, errors, fmt, strings, golang.org/x/crypto/argon2)

// Argon2Config holds password hashing configuration
type Argon2Config struct {
    Memory      uint32
    Iterations  uint32
    Parallelism uint8
    SaltLength  uint32
    KeyLength   uint32
}

// DefaultArgon2Config returns recommended settings
func DefaultArgon2Config() *Argon2Config {
    return &Argon2Config{
        Memory:      64 * 1024, // 64 MB
        Iterations:  3,
        Parallelism: 2,
        SaltLength:  16,
        KeyLength:   32,
    }
}

// HashPassword creates an Argon2id hash
func HashPassword(password string, config *Argon2Config) (string, error) {
    salt := make([]byte, config.SaltLength)
    if _, err := rand.Read(salt); err != nil {
        return "", err
    }

    hash := argon2.IDKey(
        []byte(password),
        salt,
        config.Iterations,
        config.Memory,
        config.Parallelism,
        config.KeyLength,
    )

    // Encode as: $argon2id$v=19$m=65536,t=3,p=2$<salt>$<hash>
    b64Salt := base64.RawStdEncoding.EncodeToString(salt)
    b64Hash := base64.RawStdEncoding.EncodeToString(hash)

    return fmt.Sprintf(
        "$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
        argon2.Version,
        config.Memory,
        config.Iterations,
        config.Parallelism,
        b64Salt,
        b64Hash,
    ), nil
}

// VerifyPassword checks a password against a hash
func VerifyPassword(password, encodedHash string) (bool, error) {
    config, salt, hash, err := decodeHash(encodedHash)
    if err != nil {
        return false, err
    }

    otherHash := argon2.IDKey(
        []byte(password),
        salt,
        config.Iterations,
        config.Memory,
        config.Parallelism,
        config.KeyLength,
    )

    return subtle.ConstantTimeCompare(hash, otherHash) == 1, nil
}

func decodeHash(encodedHash string) (*Argon2Config, []byte, []byte, error) {
    parts := strings.Split(encodedHash, "$")
    if len(parts) != 6 {
        return nil, nil, nil, errors.New("invalid hash format")
    }

    var version int
    if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
        return nil, nil, nil, err
    }

    config := &Argon2Config{}
    if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d",
        &config.Memory, &config.Iterations, &config.Parallelism); err != nil {
        return nil, nil, nil, err
    }

    salt, err := base64.RawStdEncoding.DecodeString(parts[4])
    if err != nil {
        return nil, nil, nil, err
    }
    config.SaltLength = uint32(len(salt))

    hash, err := base64.RawStdEncoding.DecodeString(parts[5])
    if err != nil {
        return nil, nil, nil, err
    }
    config.KeyLength = uint32(len(hash))

    return config, salt, hash, nil
}
```

### Token Blacklisting

Token blacklisting stores revoked JWT IDs in Redis with a TTL equal to the token's remaining lifetime, so the set never grows unboundedly. Using Redis SETEX means expiry is handled atomically by the datastore rather than a background cleanup job, and `IsBlacklisted` can execute in sub-millisecond time suitable for inline middleware checks.

```go
// ... imports omitted for brevity (context, time, github.com/redis/go-redis/v9)

// TokenBlacklist manages revoked tokens
type TokenBlacklist interface {
    Add(ctx context.Context, tokenID string, expiresAt time.Time) error
    IsBlacklisted(ctx context.Context, tokenID string) (bool, error)
}

// RedisTokenBlacklist implements token blacklist with Redis
type RedisTokenBlacklist struct {
    client *redis.Client
    prefix string
}

func NewRedisTokenBlacklist(client *redis.Client) *RedisTokenBlacklist {
    return &RedisTokenBlacklist{
        client: client,
        prefix: "token:blacklist:",
    }
}

func (b *RedisTokenBlacklist) Add(ctx context.Context, tokenID string, expiresAt time.Time) error {
    ttl := time.Until(expiresAt)
    if ttl <= 0 {
        return nil // Already expired
    }

    return b.client.Set(ctx, b.prefix+tokenID, "1", ttl).Err()
}

func (b *RedisTokenBlacklist) IsBlacklisted(ctx context.Context, tokenID string) (bool, error) {
    exists, err := b.client.Exists(ctx, b.prefix+tokenID).Result()
    if err != nil {
        return false, err
    }
    return exists > 0, nil
}

// Logout handler with token blacklisting
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
    claims := GetClaims(r.Context())
    if claims == nil {
        http.Error(w, "Not authenticated", http.StatusUnauthorized)
        return
    }

    // Add token to blacklist
    err := h.blacklist.Add(r.Context(), claims.ID, claims.ExpiresAt.Time)
    if err != nil {
        http.Error(w, "Logout failed", http.StatusInternalServerError)
        return
    }

    w.WriteHeader(http.StatusNoContent)
}
```

### Passkeys and WebAuthn as Phishing-Resistant MFA

By 2026, passkeys (WebAuthn/FIDO2 credentials synced across a user's devices via iCloud Keychain, Google Password Manager, or 1Password) have crossed into mainstream consumer adoption. Major platforms (Apple, Google, Microsoft, GitHub, Shopify, PayPal) now offer passkey-first sign-in. For a Go service, the reference library is `github.com/go-webauthn/webauthn`. Never roll the cryptographic verification yourself.

Two deployment modes are worth knowing:

1. **Passkey as second factor** (lowest-risk rollout). TOTP and SMS are weak against phishing and SIM swapping, passkeys are not (the relying-party origin is bound into the signed assertion, so a phishing site in a lookalike domain gets no valid signature). Keep password login, add passkey enrollment after first login, require it for sensitive operations.
2. **Passkey as primary factor** (passwordless). User signs up with email → magic link → passkey enrollment. No password stored, no phishable credential. Fall back to a recovery code or secondary device credential if the user loses their authenticator.

Implementation skeleton:

```go
// ... imports omitted for brevity (github.com/go-webauthn/webauthn/webauthn)

// On registration: /passkey/begin-register
options, session, err := webAuthn.BeginRegistration(user)
// Store `session` in short-lived server-side cache keyed by user + challenge.
// Return `options` to the browser, which calls navigator.credentials.create().

// On registration completion: /passkey/finish-register
credential, err := webAuthn.FinishRegistration(user, session, r)
// Persist credential.ID, PublicKey, SignCount, Transports for this user.

// On login: /passkey/begin-login
options, session, err := webAuthn.BeginLogin(user)
// Challenge round-trip - browser calls navigator.credentials.get().

// On login completion: /passkey/finish-login
credential, err := webAuthn.FinishLogin(user, session, r)
// MUST verify credential.Authenticator.SignCount has increased (cloned authenticator detection).
```

The critical security invariant: **always verify the relying-party ID matches your domain exactly**. Misconfiguring RP ID to a parent domain you don't fully control is the only common way to compromise a passkey deployment.

### When to Use an External Identity Platform

Rolling your own auth is correct when: you're building core authentication infrastructure, you have strict data-residency requirements a vendor cannot meet, or your team has dedicated security engineers. For everyone else, managed platforms are often the pragmatic choice in 2026:

- **Keycloak** (self-hosted, open source): full OIDC/OAuth 2.1/SAML. Operational burden is real: plan for HA Postgres, theme customization, and upgrade testing.
- **Ory** (Kratos/Hydra/Keto, self-hosted or cloud): Go-native, composable, passwordless-first, and permissions are modeled with Zanzibar-style fine-grained authorization in Keto.
- **Auth0 / Okta Customer Identity**: fastest to integrate, strong compliance story, can get expensive at MAU scale.
- **WorkOS**: designed for B2B SaaS. SSO, SCIM, and directory sync with one integration, good when your customers are enterprises demanding SAML.
- **Clerk / Stytch / Supabase Auth**: developer-experience-first, great for new products, passkey support is first-class.

Regardless of choice, the chapter's patterns (RBAC, multi-tenant scoping, audit logging, mTLS between services) still live in your code. The identity platform just issues the tokens you validate.

### Junior → FAANG: Security Fundamentals and First-Job Entry Points

Security is not a feature you ship, it is a property the system retains under adversarial conditions. For a first job the most valuable thing you can do is internalize a short list of primitives and reach for them automatically.

**Password hashing.** Argon2id with the OWASP 2026 parameters shown above. Never SHA-256, never MD5, never "our own scheme." The interview question is always "why not just salt and SHA-256." The answer: SHA-256 runs in nanoseconds on commodity GPUs, so a 12-character password is crackable in hours against a leaked database. Argon2id burns memory and time so each guess costs 100 to 500 milliseconds and tens of megabytes of RAM, making the same attack take millennia.

**Constant-time comparison.** `subtle.ConstantTimeCompare` from `crypto/subtle`. Use it for any secret comparison: tokens, HMACs, password hashes. The `==` operator on byte slices short-circuits on the first mismatch, leaking the length of the matching prefix through timing. A famous real-world exploit used this to extract HMAC keys byte-by-byte from a sloppy comparison. In Go the rule is: if the comparison is on a secret, use `subtle`.

**HTTPS everywhere.** TLS 1.3 minimum in 2026. TLS 1.2 should only be enabled with strict cipher suites if you have measured legacy clients that need it. HTTP should redirect to HTTPS with HSTS headers set. The `Strict-Transport-Security: max-age=31536000; includeSubDomains` header tells compliant browsers to never downgrade. Set the HSTS preload flag and submit to hstspreload.org only once you are sure every subdomain is HTTPS-ready.

**Cookies.** Every session cookie must carry `HttpOnly` (no JavaScript access), `Secure` (HTTPS only), and `SameSite=Lax` or `SameSite=Strict` (CSRF defense). `SameSite=None; Secure` is required for legitimate cross-site flows like embedded payment widgets. Junior mistake: setting `SameSite=None` without `Secure` because a local dev setup rejected it. The fix is to run dev over HTTPS, not to drop the flag.

**CSRF.** Same-site cookies close most CSRF holes. For sensitive state-changing operations, add a double-submit token: a CSRF token in a non-HttpOnly cookie that the page's JS copies into a request header, checked on the server. CSRF protection is not needed for pure-JSON APIs using `Authorization: Bearer` tokens, because the browser does not attach bearer tokens automatically. It is required for cookie-authenticated endpoints.

**XSS.** Never concatenate user input into HTML. Use `html/template` which escapes by default. Set a Content Security Policy header that restricts script sources. Start with report-only mode, tune the policy against real traffic, then enforce. CSP bypasses usually come from wildcarded `script-src` or from `unsafe-inline` in a production config that was meant for staging.

**SQL injection.** Always parameterized queries with `database/sql` or a query builder. String concatenation into a query is the oldest bug in the book. Code review should auto-fail any PR that builds a query with `fmt.Sprintf` plus a user input.

**Secrets management.** Environment variables work for small teams. At scale, use HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, or Azure Key Vault with a workload identity binding so the app never holds long-lived credentials. Never commit secrets. Pair with pre-commit hooks running gitleaks or trufflehog.

Worked first-job example. You are asked to implement "forgot password." The correct shape: generate a 32-byte random token, store its SHA-256 hash with a 15-minute expiry, email the raw token in a single-use link, invalidate the hash on first use, never reveal whether the email exists (always return the same response so the endpoint is not a user enumeration oracle). Junior mistakes are returning "user not found," storing the raw token, not expiring it, and allowing multiple uses.

Interview entry-points you must handle:

1. Why HttpOnly cookies? Because XSS cannot exfiltrate them.
2. Why HMAC webhooks? Because integrity of the payload is as important as origin. Signatures let the receiver verify both.
3. What is a timing attack? A side channel where the attacker learns secret bits from response latency. Fix with constant-time operations.
4. What is a password spraying attack? Attacker tries one common password across many accounts, avoiding account lockouts. Fix with rate limits keyed on source IP and device fingerprint, not just account.

### Senior @ FAANG: TLS 1.3, Webhook HMAC, Timing-Safe Everything, and a Threat-Modeled Security Posture

At staff level, security best practices is a threat-modeled posture, not a checklist. The sections below are the hot spots a principal engineer will interrogate in design review.

**TLS 1.3 as a baseline, and why not TLS 1.2.** TLS 1.3 removes every known-broken primitive (RSA key exchange, CBC modes, SHA-1, static DH, RC4, 3DES), reduces the handshake from two round trips to one, supports 0-RTT for idempotent requests, and mandates forward secrecy. In 2026 every major CDN, browser, and Go release defaults to TLS 1.3. You should disable TLS 1.2 unless you have quantified client requirements. When TLS 1.2 remains, restrict to `TLS_ECDHE_*_GCM_SHA384` and `TLS_ECDHE_*_CHACHA20_POLY1305` suites. In Go use `tls.Config` with `MinVersion: tls.VersionTLS13` by default.

**Certificate pinning: a rejection with nuance.** HPKP (HTTP Public Key Pinning) was deprecated by browsers in 2020 because a misconfigured pin could brick a site for its max-age window. Certificate transparency (CT) logs (with the `Expect-CT` header itself since retired, as CT became mandatory in browsers) plus CAA records is the modern replacement. For mobile clients, pinning remains reasonable because you control app updates. For web, do not pin. For service-to-service mTLS, pin through SPIFFE SVIDs rotated by SPIRE, which gives you pinning semantics with automatic rotation.

**HSTS and HSTS preload.** Set `max-age` to at least one year and `includeSubDomains`. Submit to the HSTS preload list only after verifying every subdomain is HTTPS-capable, because unenrollment is slow and irreversible at practical timescales. HSTS is the single cheapest defense against SSL-strip attacks and should be non-negotiable.

**Content Security Policy at scale.** A strong CSP uses nonces or hashes for inline scripts, disallows `unsafe-eval`, restricts `connect-src` to your API origins, and uses `frame-ancestors 'none'` (which supersedes `X-Frame-Options`). Deploy in `Content-Security-Policy-Report-Only` mode first, wire the report endpoint to your SIEM, iterate until the violation rate is near zero, then flip to enforce. Trusted Types (CSP directive `require-trusted-types-for 'script'`) mitigates DOM XSS by forcing all dangerous sinks to go through a policy function. As of 2026, Trusted Types has stable Chromium support and Firefox support has shipped as well. Ship it for your web properties where possible.

**HMAC-signed webhooks.** Every outbound webhook your platform emits must be signed and every inbound webhook you accept from partners must be verified. The pattern: `signature = HMAC_SHA256(secret, timestamp + "." + body)`. Send `X-Signature-Timestamp` and `X-Signature` headers. The receiver reconstructs the signed string, computes the HMAC, compares with `subtle.ConstantTimeCompare`, and rejects requests older than a short window (five minutes is a common tolerance). The timestamp stops replay attacks. Use separate secrets per tenant or per webhook endpoint so a single leaked secret does not compromise all deliveries. Include the API version and webhook event type in the signed payload so a downgrade attack cannot reinterpret a signed body. Stripe's webhook scheme is the canonical reference.

**Constant-time hashing and comparison in Go.**

```go
import "crypto/subtle"

func VerifyHMAC(expectedMAC, computedMAC []byte) bool {
    return subtle.ConstantTimeCompare(expectedMAC, computedMAC) == 1
}
```

`subtle.ConstantTimeCompare` returns zero for unequal-length inputs without examining them, so it is safe to call with attacker-controlled lengths. Argon2's `argon2.IDKey` is already constant-time on the password input. SHA-256 itself is constant-time on fixed-size inputs. The pitfalls are usually elsewhere: string comparison on a normalized email address (use lowercase before compare, then constant-time), path comparison on URL segments, and tenant-ID compares after parsing.

**Token binding and sender-constrained tokens.** OAuth 2.1 deprecates bearer tokens for sensitive contexts in favor of sender-constrained tokens via DPoP (Demonstration of Proof of Possession) or mTLS-bound tokens. DPoP has shipped in most modern IdPs by 2026. In a DPoP flow, the client holds a key pair, signs a JWT with the HTTP method and target URI, and sends it in a `DPoP` header alongside the access token that has a `cnf` claim containing the public key thumbprint. Stolen access tokens are useless without the private key. For B2B APIs serving high-value transactions, DPoP should be the default.

**Key management and KMS-backed signing.** Long-lived JWT signing keys on disk are a design smell. Use an HSM-backed KMS (AWS KMS, GCP Cloud KMS, HashiCorp Vault Transit) with an asymmetric key that the service calls to sign tokens. Rotation becomes a KMS policy change, compromise becomes a key-scheduled disable, and audit logging is free. The latency cost is 2 to 10 ms per sign, acceptable for login flows but too slow for per-request signing. For that use case, sign short-lived keys with the KMS root and keep the derived signer in memory for a bounded window.

**CSRF in depth.** The three defenses: SameSite cookies (first line, covers most cases), double-submit tokens with an HMAC to prevent forgery, and synchronizer tokens stored server-side. Combine layers. Note that CORS is not CSRF protection. CORS governs what JavaScript may read, not what the browser may send. A CSRF attack can submit a cross-site form regardless of CORS policy.

**CORS configured correctly.** Never `Access-Control-Allow-Origin: *` combined with `Access-Control-Allow-Credentials: true`. Echo an explicitly allowed origin after validating it against a whitelist. Reject wildcard subdomains unless you control them. Preflight responses must not leak allowed origins an attacker can probe.

**Rate limiting and abuse prevention.** Token bucket per identity plus sliding window per IP plus device fingerprint for anonymous flows. The auth endpoints need special treatment: login, password reset, MFA verification, passkey ceremony. Too-strict limits are a DoS vector against legitimate users. Use progressive delays (exponential backoff on failures) plus CAPTCHA escalation only after N failures, not on every request. Google's reCAPTCHA v3 and hCaptcha Enterprise produce risk scores you can use to gate on without interrupting legitimate users.

**Audit logging as a first-class feature.** Every security-relevant event gets a structured log line: authentication success and failure, authorization denials, token issuance and revocation, password changes, MFA enrollment, privilege elevation, admin bypass invocations, policy changes. Ship to an immutable sink (S3 with object lock, Azure Immutable Storage, or an append-only ledger) so a compromised admin cannot rewrite history. The log format should align with OCSF (Open Cybersecurity Schema Framework) so it feeds commercial SIEMs and Chronicle/Sentinel without a transform layer.

**Key leak response runbook.** When a credential leaks, the speed of detection-to-revocation is the metric that matters. Target detection-to-revocation of under 60 seconds for registered-prefix keys via GitHub partner revocation, under 5 minutes for canary-triggered events, under 1 hour for internal SIEM alerts. Document the runbook, rehearse it in tabletop exercises quarterly, and measure MTTR. This is a staff-level expectation, not an optional nicety.

**Cryptographic agility.** Algorithms you ship today will be broken in 10 years. Design for agility: JWT `alg` explicitly rejected if not on an allowlist (no `none`, no `HS256` confusion with `RS256`), hash outputs stored with their algorithm prefix (argon2id PHC string is a good example), webhook signatures versioned (`v1=...`). Post-quantum readiness is a 2026 topic: ML-KEM (FIPS 203, from CRYSTALS-Kyber) and ML-DSA (FIPS 204, from CRYSTALS-Dilithium) are NIST-standardized, and the X25519MLKEM768 hybrid ships by default in Go's TLS stack since Go 1.24. You do not need to migrate today, but your JWT library choice and signing abstraction should accommodate a future algorithm swap without touching handlers.

**Threat modeling as a shipping artifact.** Every service gets a threat model using STRIDE (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege) or a simplified attack-tree. The artifact is a markdown doc in the service repo, reviewed by a security engineer on major changes, and referenced in the RFC process. Without it, a staff design review will not approve a service touching customer data.

**Compliance mapping.** SOC2, ISO 27001, HIPAA, PCI DSS, GDPR, and 2026 additions like the EU Cyber Resilience Act (CRA) all map onto the primitives in this chapter. Build a single matrix that links each control (password hashing, audit log, access review, encryption at rest, encryption in transit, key rotation, breach notification) to the code or config that enforces it. When an auditor asks "show me your password hashing control" the answer is a git link, not a slide.

---
