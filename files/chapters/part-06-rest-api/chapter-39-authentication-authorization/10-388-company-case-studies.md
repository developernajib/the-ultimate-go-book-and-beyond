## 39.8 Company Case Studies

### How Auth0 Handles Authentication

Auth0 processes billions of authentication requests monthly and has made several design choices worth studying, particularly around refresh token rotation and reuse detection.

```go
// Auth0's approach to token management

// 1. Short-lived Access Tokens + Long-lived Refresh Tokens
type Auth0TokenConfig struct {
    AccessTokenTTL  time.Duration // 24 hours default, configurable
    RefreshTokenTTL time.Duration // 30 days, with rotation

    // Refresh Token Rotation
    RotationEnabled     bool // Creates new refresh token on each use
    ReuseDetection      bool // Detects if old token is reused (potential theft)
    ReuseGracePeriod    time.Duration // 60 seconds for network issues

    // Absolute expiration for refresh tokens
    AbsoluteExpiration time.Duration // Maximum lifetime regardless of use
}

// 2. Token Binding to Prevent Theft
type BoundToken struct {
    Claims      *Claims
    Fingerprint string // Hash of client certificate or device ID
    IP          string // Optional IP binding
}

func (s *TokenService) ValidateBoundToken(token string, r *http.Request) (*Claims, error) {
    claims, err := s.ValidateToken(token)
    if err != nil {
        return nil, err
    }

    // Verify binding matches request context
    currentFingerprint := extractFingerprint(r)
    if claims.Fingerprint != "" && claims.Fingerprint != currentFingerprint {
        return nil, ErrTokenBindingMismatch
    }

    return claims, nil
}

// 3. Refresh Token Rotation with Reuse Detection
type RefreshTokenStore struct {
    redis *redis.Client
}

func (s *RefreshTokenStore) UseToken(ctx context.Context, tokenID string) error {
    // Mark token as used
    key := "refresh_token:" + tokenID

    // Check if already used
    used, err := s.redis.SetNX(ctx, key+":used", "1", 24*time.Hour).Result()
    if err != nil {
        return err
    }

    if !used {
        // Token was reused - potential theft!
        // Revoke entire refresh token family
        familyID := s.getTokenFamily(ctx, tokenID)
        s.revokeFamily(ctx, familyID)

        // Alert security team
        securityAlert("Refresh token reuse detected", map[string]string{
            "token_id":  tokenID,
            "family_id": familyID,
        })

        return ErrTokenReused
    }

    return nil
}
```

### How Stripe Handles API Keys

Stripe's API key system uses a prefixed format that encodes the key type and environment directly in the key string. This design enables both users and automated systems to quickly identify a key's purpose without querying a database.

```go
// Stripe's API Key Design Principles

// 1. Key Format: Clearly identifies key type and environment
// sk_live_xxx - Secret key, live environment
// sk_test_xxx - Secret key, test environment
// pk_live_xxx - Publishable key, live environment
// rk_live_xxx - Restricted key, live environment

type StripeAPIKey struct {
    Type        string // sk, pk, rk
    Environment string // live, test
    Identifier  string // Random identifier (visible to user)
    Secret      string // Full key (shown only once)
    Hash        string // Stored hash for validation

    // Restricted key permissions
    Permissions map[string]string // resource -> permission level
}

// 2. Key Display: Show prefix for identification, never full key
func (k *StripeAPIKey) DisplayFormat() string {
    // sk_live_4eC39H...xjdR
    return fmt.Sprintf("%s_%s_%s...%s",
        k.Type,
        k.Environment,
        k.Secret[:6],
        k.Secret[len(k.Secret)-4:],
    )
}

// 3. Restricted Keys with Granular Permissions
type RestrictedKey struct {
    ID          string
    Name        string
    Permissions []KeyPermission
    IPWhitelist []string
    CreatedAt   time.Time
    ExpiresAt   *time.Time
}

type KeyPermission struct {
    Resource   string // charges, customers, subscriptions
    Permission string // none, read, write
}

func (k *RestrictedKey) HasPermission(resource, action string) bool {
    for _, p := range k.Permissions {
        if p.Resource == resource || p.Resource == "*" {
            switch action {
            case "read":
                return p.Permission == "read" || p.Permission == "write"
            case "write":
                return p.Permission == "write"
            }
        }
    }
    return false
}

// 4. Key Rolling: Overlap period for zero-downtime rotation
type KeyRollingService struct {
    store KeyStore
}

func (s *KeyRollingService) RollKey(ctx context.Context, keyID string) (*StripeAPIKey, error) {
    oldKey, err := s.store.Get(ctx, keyID)
    if err != nil {
        return nil, err
    }

    // Create new key
    newKey, err := s.store.Create(ctx, oldKey.Type, oldKey.Environment)
    if err != nil {
        return nil, err
    }

    // Mark old key as rolling (still valid for 24 hours)
    oldKey.RollingExpiresAt = time.Now().Add(24 * time.Hour)
    s.store.Update(ctx, oldKey)

    return newKey, nil
}
```

### How Google Implements OAuth

Google's OAuth implementation introduces several patterns beyond the basic authorization code flow, including incremental authorization and service account authentication via signed JWTs.

```go
// Key Google OAuth Design Patterns

// 1. Incremental Authorization
// Instead of requesting all scopes upfront, request as needed
type IncrementalAuthHandler struct{}

func (h *IncrementalAuthHandler) NeedsScope(ctx context.Context, user *User, scope string) bool {
    // Check if user has already granted this scope
    grants, _ := h.grantStore.GetUserGrants(ctx, user.ID)
    for _, g := range grants {
        for _, s := range g.Scopes {
            if s == scope {
                return false
            }
        }
    }
    return true
}

func (h *IncrementalAuthHandler) RequestAdditionalScope(w http.ResponseWriter, r *http.Request, scope string) {
    // Build authorization URL with include_granted_scopes=true
    authURL := fmt.Sprintf(
        "%s/authorize?client_id=%s&redirect_uri=%s&scope=%s&include_granted_scopes=true",
        h.authServer,
        h.clientID,
        url.QueryEscape(h.redirectURI),
        url.QueryEscape(scope),
    )
    http.Redirect(w, r, authURL, http.StatusFound)
}

// 2. Service Account Authentication (for server-to-server)
type ServiceAccountAuth struct {
    Email      string
    PrivateKey *rsa.PrivateKey
    Scopes     []string
}

func (s *ServiceAccountAuth) GetToken(ctx context.Context) (*oauth2.Token, error) {
    now := time.Now()

    claims := jwt.MapClaims{
        "iss":   s.Email,
        "sub":   s.Email,
        "aud":   "https://oauth2.googleapis.com/token",
        "iat":   now.Unix(),
        "exp":   now.Add(time.Hour).Unix(),
        "scope": strings.Join(s.Scopes, " "),
    }

    token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
    signedJWT, err := token.SignedString(s.PrivateKey)
    if err != nil {
        return nil, err
    }

    // Exchange JWT for access token
    resp, err := http.PostForm("https://oauth2.googleapis.com/token", url.Values{
        "grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
        "assertion":  {signedJWT},
    })
    // ...
}

// 3. Token Introspection for Resource Servers
type TokenIntrospection struct {
    Active     bool      `json:"active"`
    Scope      string    `json:"scope"`
    ClientID   string    `json:"client_id"`
    Username   string    `json:"username"`
    TokenType  string    `json:"token_type"`
    Exp        int64     `json:"exp"`
    Iat        int64     `json:"iat"`
    Sub        string    `json:"sub"`
    Aud        []string  `json:"aud"`
}

func (s *ResourceServer) IntrospectToken(ctx context.Context, token string) (*TokenIntrospection, error) {
    resp, err := http.PostForm(s.introspectionEndpoint, url.Values{
        "token":           {token},
        "token_type_hint": {"access_token"},
    })
    // ...
}
```

### How GitHub Implements Fine-Grained Permissions

GitHub's fine-grained personal access tokens replaced classic tokens with repository-scoped, action-specific permissions. The system enforces permission dependencies (for example, `workflows:write` requires `contents:write`) to prevent escalation through inconsistent grants.

```go
// GitHub's Fine-Grained Token System

// 1. Repository-Level Permissions
type GitHubFineGrainedToken struct {
    ID          string
    Name        string
    Owner       string // User or organization

    // Resource access
    RepositorySelection string // all, subset
    SelectedRepos       []string

    // Granular permissions
    Permissions GitHubPermissions

    ExpiresAt *time.Time
}

type GitHubPermissions struct {
    // Repository permissions
    Actions           string // none, read, write
    Administration    string
    Contents          string
    Issues            string
    Metadata          string // Always at least "read"
    PullRequests      string
    Workflows         string

    // Account permissions
    EmailAddresses    string
    Followers         string
    GPGKeys           string
    Profile           string
}

// 2. Permission Inheritance and Escalation Prevention
func (p *GitHubPermissions) Validate() error {
    // Workflows require Contents:write (can't have more than Contents)
    if p.Workflows == "write" && p.Contents != "write" {
        return errors.New("workflows:write requires contents:write")
    }

    // Administration is highest - requires explicit grant
    if p.Administration != "none" && !p.AdminGranted {
        return errors.New("administration requires explicit grant")
    }

    return nil
}

// 3. Audit Log Integration
type TokenAuditLog struct {
    Timestamp   time.Time
    TokenID     string
    Action      string
    Resource    string
    IP          string
    UserAgent   string
    Success     bool
    FailReason  string
}

func (s *GitHubTokenService) LogAccess(ctx context.Context, token *GitHubFineGrainedToken, action, resource string, success bool) {
    log := TokenAuditLog{
        Timestamp:  time.Now(),
        TokenID:    token.ID,
        Action:     action,
        Resource:   resource,
        IP:         getIP(ctx),
        UserAgent:  getUserAgent(ctx),
        Success:    success,
    }
    s.auditStore.Store(ctx, log)
}
```

### Junior → FAANG: Reading Case Studies Without Cargo-Culting

When you first see Auth0's refresh token rotation or Stripe's prefixed keys, the temptation is to copy the surface pattern into your side project. That is exactly backwards. Each of these designs exists because of a specific scar. Auth0 rotates refresh tokens because a stolen long-lived token is indistinguishable from a legitimate one, so they need reuse detection to catch theft after the fact. Stripe prefixes `sk_live_` and `sk_test_` because engineers were leaking production keys into test environments and test keys into production logs, and grep-based secret scanners needed a stable signal. GitHub introduced fine-grained tokens in public beta in 2022 (GA in 2025) because classic PATs were over-scoped by default and showed up in every leaked dotfile repo.

Worked example for your first job. You are asked to add "API keys" to a B2B SaaS. The junior move is to generate a UUID, store it in the database, and return it. The FAANG-trained move is:

1. Prefix the key with a product code and environment (`acme_live_`), so leak scanners from GitHub, GitGuardian, and TruffleHog can detect it.
2. Store only a hash (`argon2id` or at least `sha256`), never the raw key.
3. Show the key exactly once at creation, then show only the last four characters.
4. Add scoping fields from day one, even if you only support `read` and `write`. Retrofitting scopes onto already-issued keys is painful.
5. Log every use with IP, user agent, and timestamp to an append-only audit table.

"Why did this fail?" reflex. If a key from your system appears in a public GitHub repo and the attacker drains an account, the postmortem question is not "why did the user leak it" but "why did our system not detect the leak, rotate the key, or scope it narrowly enough that the blast radius was bounded?" Every case study above is an answer to that question.

Interview entry point. Expect the question "how do API keys differ from JWTs, and when would you use each?" The L3/L4 answer is: API keys are opaque, server-validated, revocable in real time, and belong to machines. JWTs are self-contained, signature-validated, and hard to revoke before expiration. You use API keys for long-lived machine-to-machine with granular permission lookups. You use JWTs for short-lived user sessions where you want to avoid a DB hit on every request. Mention that production systems often combine both: a JWT for the user session plus an opaque API key for programmatic access.

### Senior @ FAANG: Platformization, Governance, and the 2023-2026 Incident Record

At staff and principal level, case studies are not "how does Stripe format keys" but "what does the industry teach us about auth as a platform." The decisions below are the ones a principal engineer at a FAANG-tier company is expected to defend in an ADR.

Google Zanzibar as the reference architecture for authorization. Zanzibar is the system that powers Drive, YouTube, Calendar, and Cloud IAM checks, handling more than 10 million authorization checks per second globally with 95th percentile latency around 10 milliseconds, per the 2019 paper. The key ideas: relationships expressed as tuples (`doc:readme#viewer@user:alice`), a global consistency model using zookies (opaque consistency tokens passed with reads), and an evaluation engine that resolves group memberships through configurable userset rewrites. The industry response has been OpenFGA (CNCF sandbox), SpiceDB (AuthZed), Permify, and Warrant. At L6+ you are expected to know when ReBAC beats RBAC (sharing semantics, hierarchical resources, many-to-many subject-resource relationships) and when it is overkill (fewer than 10 roles, no sharing, static permissions). The ADR decision is rarely "build Zanzibar" and almost always "adopt OpenFGA, run it as a sidecar, define a `.fga` model, and commit to the tuple-write discipline."

Stripe restricted keys and Connect. Restricted keys gave tenants of Stripe Connect the ability to scope a key to specific resources and permissions. The principal lesson is that authorization scoping must be per-key, not per-account, because a single account in a platform business has many agents (integrations, internal tools, third-party analytics) with asymmetric trust. Connect adds account-on-behalf-of semantics, where the platform acts as a tenant of Stripe and merchants are tenants of the platform. This is the multi-tenant identity hierarchy every B2B2C company eventually builds.

GitHub fine-grained tokens (public beta 2022, GA 2025). The migration teaches three things. First, permission dependencies matter: `workflows:write` implies `contents:write`, and the validator rejects inconsistent grants. Second, default expiration on tokens (GitHub caps at one year) reduces the long tail of forgotten credentials. Third, org policy controls matter more than per-user knobs, because individual developers will always pick the most permissive scope that makes their script work.

Auth0 incident response. Auth0 has had multiple availability incidents since 2023, and the pattern that emerges is that identity is a single point of failure for the entire downstream fleet. The staff-level response is to treat your IdP as a tier-0 dependency: cache JWKS aggressively, tolerate short IdP outages by continuing to validate already-issued tokens, design a break-glass local admin path, and do not put your own login page behind the same IdP you are trying to recover.

Cloudflare Access and Zero Trust. Cloudflare's model replaces VPNs with per-request identity checks at the edge. The principal insight: network location is not identity. Every request to an internal app is authenticated against the IdP, authorized against a policy, and logged. For a FAANG-scale platform, the analog is BeyondCorp (Google's original Zero Trust implementation, 2014), Azure Entra Private Access, and AWS Verified Access.

Okta breach 2023 lessons. A support-case management system (not the core product) was compromised, attackers downloaded HAR files containing session tokens from customer tenants, and those tokens were replayed to take over downstream accounts including 1Password, BeyondTrust, and Cloudflare. The lessons are: session tokens in HAR files are bearer credentials, never upload HARs without scrubbing (Okta added automatic scrubbing in 2024), bind sessions to device identity (DPoP, token binding, mTLS) so replay from a new device fails, and assume any customer-support tooling is an attack path to production tenants.

Meta account takeover mitigations. Meta's public engineering writeups describe multi-signal risk scoring at login: device fingerprint, IP history, behavioral biometrics, and friend-graph anomalies. Staff engineers should recognize that password plus MFA is necessary but not sufficient at consumer scale. Risk-based authentication is now the baseline.

AWS IAM as a platform. IAM's scale (hundreds of millions of authorization decisions per second, policy evaluation in under a millisecond) is achieved through eventual consistency with bounded staleness, aggressive caching of policy documents, and a deny-by-default evaluation model. The staff lesson: authorization latency budgets are sub-millisecond at scale, which means the authorization service must be co-located with the resource service, not a cross-region round trip.

Azure Entra ID (formerly Azure AD). Entra's conditional access policies are the reference implementation of policy-as-data for enterprise SSO: "if user is in group X and device is compliant and location is corporate and application is Y, then allow with MFA." Staff engineers should map this to OPA/Rego or Cedar policies when building internal auth.

Okta vs Auth0 vs Google Workspace vs Clerk vs WorkOS trade-offs. As of 2026:

- Okta Workforce Identity: enterprise SSO, SCIM provisioning, strong governance (Identity Governance module), weak developer experience, high cost per seat. Choose for regulated enterprise.
- Auth0 (Okta Customer Identity): developer-friendly CIAM, good B2C flows, rules/actions for customization, acquired by Okta in 2021 but still a distinct product. Choose for consumer or prosumer SaaS.
- Google Workspace (Cloud Identity): strong if you are already a Google shop, native Workspace integration, weaker for non-Google SaaS without additional SSO configuration.
- Clerk: newest entrant, excellent React/Next.js DX, opinionated UI components, pre-built user management, weak for enterprise SSO and compliance. Choose for early-stage B2C startups.
- WorkOS: "enterprise-ready in an afternoon" narrative, SSO/SCIM/Directory Sync as a drop-in, admin portal for IT buyers. Choose for B2B SaaS selling into enterprise.
- Build in-house: only if identity is a core differentiator (Stripe, Shopify, GitHub) or compliance demands exclude all vendors. The total cost of ownership for a production IdP exceeds two senior engineers full-time, indefinitely.

ADR template for "which IdP." Decision, status, context (company stage, buyer profile, compliance), options (the five above plus build), consequences (lock-in, migration cost, control plane dependency), review date. Every FAANG-tier auth team has this document and revisits it every 18 months.

Maturity model for case-study absorption. L1 teams copy code from a blog post. L2 teams adopt a vendor and follow the tutorial. L3 teams read the RFC (OAuth 2.1, OIDC, SAML 2.0) and the vendor postmortems. L4 teams instrument their own system with the same telemetry the case studies describe. L5 teams contribute patches or published postmortems back to the community. Move up one level per year.

---
