## 112B.1 The OAuth 2.0 and OIDC Landscape

OAuth 2.0 is an authorization framework that issues scoped access tokens, while OpenID Connect (OIDC) layers an identity protocol on top by adding a signed ID token (JWT) and a `UserInfo` endpoint. Choosing the wrong grant type is a common security mistake: the Authorization Code flow with PKCE is mandatory for any client that runs in an untrusted environment (browser, mobile, CLI), because it prevents authorization code interception without relying on a client secret. The deprecated Implicit and Resource Owner Password flows must never be used in new Go applications.

```
┌───────────────────────────────────────────────────────────────────────┐
│                     OAUTH 2.0 GRANT TYPES                             │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Authorization Code + PKCE    ← Web apps, SPAs, Mobile (RECOMMENDED)  │
│  ┌──────────┐   1. auth req   ┌─────────────┐                         │
│  │  Client  │────────────────>│ Auth Server │                         │
│  │  (App)   │<────────────────│             │                         │
│  └──────────┘   2. auth code  └─────────────┘                         │
│       │          3. code + verifier    ↑                              │
│       └──────────────────────────────>│                               │
│       <─────────────────────────────── 4. access + refresh token      │
│                                                                       │
│  Client Credentials           ← Service-to-service (M2M)              │
│  Device Flow                  ← Smart TVs, CLI tools                  │
│  Token Exchange (RFC 8693)    ← Impersonation, delegation             │
│                                                                       │
│  DEPRECATED (DO NOT USE):                                             │
│  Implicit Flow                ← Replaced by Auth Code + PKCE          │
│  Resource Owner Password      ← Security risk                         │
│                                                                       │
├───────────────────────────────────────────────────────────────────────┤
│                    OIDC LAYERS ON TOP OF OAUTH                        │
│                                                                       │
│  OAuth 2.0 → "can access"     (Authorization)                         │
│  OIDC       → "who you are"   (Authentication)                        │
│                                                                       │
│  OIDC adds: ID Token (JWT) + UserInfo endpoint + Discovery            │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

---
