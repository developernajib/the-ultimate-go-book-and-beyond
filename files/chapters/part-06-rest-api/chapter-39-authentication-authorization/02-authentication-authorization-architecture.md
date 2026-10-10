## Authentication & Authorization Architecture

The architecture shows how authentication (proving identity) and authorization (verifying permissions) are separated into distinct middleware layers. Authentication runs first to establish the caller's identity, and authorization checks run per-resource to enforce access policies.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    AUTHENTICATION & AUTHORIZATION FLOW                       │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                        AUTHENTICATION METHODS                          │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │  │
│  │  │ Basic Auth  │  │    JWT      │  │  OAuth 2.0  │  │  API Keys   │    │  │
│  │  │             │  │             │  │             │  │             │    │  │
│  │  │ user:pass   │  │ Bearer xxx  │  │ code+PKCE   │  │ X-API-Key   │    │  │
│  │  │ (internal)  │  │ (stateless) │  │ (3rd party) │  │ (services)  │    │  │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘    │  │
│  │         │                │                │                │           │  │
│  │         └────────────────┴────────────────┴────────────────┘           │  │
│  │                                    │                                   │  │
│  │                                    ▼                                   │  │
│  │                         ┌──────────────────┐                           │  │
│  │                         │  Auth Middleware │                           │  │
│  │                         │                  │                           │  │
│  │                         │ • Validate creds │                           │  │
│  │                         │ • Extract claims │                           │  │
│  │                         │ • Load user ctx  │                           │  │
│  │                         └────────┬─────────┘                           │  │
│  │                                  │                                     │  │
│  └──────────────────────────────────│─────────────────────────────────────┘  │
│                                     │                                        │
│                                     ▼                                        │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                        AUTHORIZATION LAYER                             │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │   ┌───────────────┐    ┌───────────────┐    ┌───────────────┐          │  │
│  │   │    RBAC       │    │    ABAC       │    │  Resource     │          │  │
│  │   │               │    │               │    │  Ownership    │          │  │
│  │   │ admin         │    │ if user.dept  │    │               │          │  │
│  │   │ ├── editor    │    │ == "eng" &&   │    │ user.id ==    │          │  │
│  │   │ │   └── viewer│    │ action == r   │    │ resource.     │          │  │
│  │   │ └── moderator │    │ then allow    │    │ owner_id      │          │  │
│  │   └───────────────┘    └───────────────┘    └───────────────┘          │  │
│  │                                                                        │  │
│  │   Permission Check: HasPermission(user, resource, action)              │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                        JWT TOKEN STRUCTURE                             │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │                           HEADER                                │   │  │
│  │  │  { "alg": "RS256", "typ": "JWT", "kid": "key-2024-01" }         │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  │                                .                                       │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │                           PAYLOAD                               │   │  │
│  │  │  {                                                              │   │  │
│  │  │    "sub": "user_123",          // Subject (user ID)             │   │  │
│  │  │    "iss": "api.example.com",   // Issuer                        │   │  │
│  │  │    "aud": ["api", "web"],      // Audience                      │   │  │
│  │  │    "exp": 1704067200,          // Expiration                    │   │  │
│  │  │    "iat": 1704063600,          // Issued at                     │   │  │
│  │  │    "jti": "unique-token-id",   // JWT ID                        │   │  │
│  │  │    "roles": ["admin"],         // Custom claim                  │   │  │
│  │  │    "tenant_id": "tenant_abc"   // Custom claim                  │   │  │
│  │  │  }                                                              │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  │                                .                                       │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │                          SIGNATURE                              │   │  │
│  │  │  RSASHA256(base64(header) + "." + base64(payload), privateKey)  │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                     OAUTH 2.0 AUTHORIZATION CODE FLOW                  │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  User ──────────► Client App ──────────► Auth Server ──────────►       │  │
│  │         click              redirect        /authorize                  │  │
│  │        "login"            + PKCE           + login UI                  │  │
│  │                                                                        │  │
│  │         ◄──────────────────────────────────────────────────────        │  │
│  │                     redirect with ?code=xxx&state=yyy                  │  │
│  │                                                                        │  │
│  │  Client App ──────────────────────────────────► Auth Server            │  │
│  │              POST /token                         /token                │  │
│  │              code + code_verifier                                      │  │
│  │                                                                        │  │
│  │         ◄──────────────────────────────────────────────────────        │  │
│  │                    { access_token, refresh_token }                     │  │
│  │                                                                        │  │
│  │  Client App ──────────────────────────────────► Resource API           │  │
│  │              Authorization: Bearer <token>       /api/resource         │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │                      MULTI-TENANT ISOLATION                            │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │                                                                        │  │
│  │  Request → Tenant Resolver → Tenant Context → Data Filter              │  │
│  │                                                                        │  │
│  │  ┌──────────────┐   ┌──────────────┐   ┌──────────────────────────┐    │  │
│  │  │ Subdomain    │   │ Header       │   │ Token Claim              │    │  │
│  │  │              │   │              │   │                          │    │  │
│  │  │ acme.api.com │   │ X-Tenant-ID  │   │ { "tenant": "acme_123" } │    │  │
│  │  └──────────────┘   └──────────────┘   └──────────────────────────┘    │  │
│  │                                                                        │  │
│  │  Every query automatically filtered:                                   │  │
│  │  SELECT * FROM orders WHERE tenant_id = $1 AND ...                     │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Junior → FAANG: reading the diagram as a sequence

The ASCII art above is a system diagram, not a sequence diagram, so a junior reader can miss which box runs when. Read it top to bottom in this order. An HTTP request lands on your Go server. The auth middleware at the top of the chain inspects the request for a credential in one of four shapes. Basic auth (rare outside internal tools), a Bearer JWT in the `Authorization` header (the common case), an OAuth 2.1 access token also presented as a Bearer (same header, different issuer), or an API key in `X-API-Key` for machine-to-machine calls. The middleware validates the credential, extracts claims (user ID, roles, tenant), and attaches them to `context.Context`. If validation fails, the request is rejected with HTTP 401. That is authentication done.

Authorization runs next, per handler. The RBAC path checks whether the caller's role set contains a role that grants the required permission. The ABAC path evaluates a policy expression over attributes of the caller, the resource, and the environment. The ownership path checks `resource.OwnerID == caller.UserID`. In most real systems all three run: RBAC gates the route, ownership or ABAC gates the specific record. If authorization fails, the response is HTTP 403, not 401. 401 means "I do not know who you are". 403 means "I know who you are and you cannot do this". Mixing these up leaks information and breaks client retry logic.

As a worked example, trace `GET /invoices/42` for a user with role `viewer` and `tenant_id=acme`. Middleware decodes the JWT, validates signature and `exp`, extracts `sub=user_7`, `roles=[viewer]`, `tenant_id=acme`. The handler is gated by `RequirePermission("invoice:read")` which the `viewer` role grants. Inside the handler, the query is `SELECT * FROM invoices WHERE id=$1 AND tenant_id=$2` with `$2` bound from the token. Even if the user guesses an invoice ID from another tenant, the query returns zero rows. This is defense in depth. The middleware could be wrong, the RBAC table could be misconfigured, but the tenant predicate in the query closes the gap.

### Senior @ FAANG: architecture decisions that this diagram hides

The diagram is a useful teaching artifact and a dangerous simplification. A staff engineer reading it should immediately note five design decisions that are compressed into single boxes and each of which is a months-long project at scale.

The "Auth Middleware" box hides the choice between stateless validation (verify JWT signature locally using a cached JWKS) and stateful validation (introspect the token against the issuer per request). Stateless validation scales to infinite RPS at sub-millisecond cost but cannot revoke a token before `exp`. Stateful introspection adds a network hop and a dependency on the issuer's availability but gives instant revocation and richer real-time claims. Google Cloud's published guidance leans on short-lived tokens validated statelessly, while payment platforms tend toward opaque tokens with introspection because their revocation SLA is seconds, not minutes (Stripe's API keys, notably, are opaque and revocable instantly from the dashboard). The right answer depends on your threat model and your latency budget, and the diagram pretends it is a single box.

The "JWT Token Structure" box shows `roles: [admin]` and `tenant_id: tenant_abc` as custom claims. This is where token bloat begins. If you put the full role tree plus every permission plus a user profile into the token, you hit 8 KB and break HTTP headers on some proxies. The discipline is to put only stable identifiers in the token (user ID, tenant ID, a coarse role label) and resolve the full permission set from a fast cache (Redis, an in-process LRU fed by a change stream) at request time. This keeps tokens small, keeps revocation latency low (change a role in the database, invalidate the cache entry, every subsequent request sees the new permissions), and avoids the "I need to re-issue every active token when permissions change" trap.

The "OAuth 2.0 Authorization Code Flow" box is actually OAuth 2.1 in 2026. PKCE is mandatory for every client, not optional for public clients. The `state` parameter is mandatory to prevent CSRF on the redirect. The redirect URI must match exactly. The authorization code is single-use and must be bound to the `code_challenge` from the `/authorize` call. Refresh tokens rotate on every use with reuse detection. DPoP binds the access token to a client-held EC key pair so that a stolen token presented without the matching DPoP proof is rejected. A senior engineer reviewing an OAuth implementation checks every one of these. The box in the diagram shows none of them.

The "Multi-Tenant Isolation" box shows three ways to resolve tenant identity. In a real FAANG system the tenant claim comes from the token, full stop. Subdomain and header-based resolution are attacker-controllable at the edge and must be validated against the token claim before they are trusted. If the token says `tenant=acme` and the subdomain says `globex.api.com`, reject the request. Additionally, tenant isolation is enforced at three layers: the middleware sets a row-level security context on the database connection (PostgreSQL RLS policies), every query uses a parameterised `tenant_id` predicate as belt and braces, and schema-per-tenant or database-per-tenant is used for the largest or most regulated customers. A single layer is insufficient because a single bug in any one of them leaks cross-tenant data, and BOLA is the single most common class of breach in B2B SaaS.

The diagram treats authentication and authorization as sequential middleware. In a mature architecture they are often separated into distinct services. A central identity service issues and validates tokens. A policy decision point (PDP) such as Open Policy Agent, Cedar (AWS), or Zanzibar (Google SpiceDB as an open-source analog) evaluates authorization policies. The application service is a policy enforcement point (PEP) that calls the PDP per request. This separation lets you change policy without redeploying applications, audit every decision centrally, and run the same policy at the API gateway, in the service, and in the database. It also adds latency and operational complexity that is only justified above a certain scale, and knowing when to introduce it is a principal-track judgment call.

---
