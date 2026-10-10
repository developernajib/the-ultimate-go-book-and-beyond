# Chapter 112: Authentication & Authorization Deep Dive

> *"Authentication asks 'who are you?' Authorization asks 'what are you allowed to do?' Confusing them is how breaches happen."*

Authentication and authorization are the two gatekeepers of every production system, yet they are among the most frequently misimplemented security controls in real-world software. Authentication (AuthN), verifying identity, is often implemented correctly at the surface level (users log in with a password) but fails in edge cases: password reset flows that leak tokens via HTTP referrer headers, session fixation vulnerabilities that let attackers hijack sessions before authentication, or OAuth implementations that skip PKCE and become vulnerable to authorization code interception. Authorization (AuthZ), determining what an authenticated identity is permitted to do, is where complexity truly explodes in multi-service architectures where a single user action may require permission checks across a dozen services.

OAuth 2.0 and OpenID Connect (OIDC) have become the industry standard for delegated authentication and federated identity. OAuth 2.0 defines the authorization framework: the flows by which applications obtain access tokens on behalf of users or themselves. OIDC layers identity on top, providing the ID token that carries user claims in a standardized format. In Go, implementing these flows correctly means understanding the Authorization Code flow with PKCE (the modern standard for all public clients), the Client Credentials flow for service-to-service authentication, token introspection for validating opaque tokens, and JWKS-based JWT validation for verifying signed tokens without roundtrips to the identity provider. JWTs are simultaneously the most widely used and most frequently misconfigured token format, from accepting `alg: none` to using symmetric keys in multi-tenant systems where tenants could forge each other's tokens.

Role-Based Access Control (RBAC) handles the majority of authorization requirements elegantly: assigning permissions to roles and roles to users. But modern SaaS products quickly outgrow simple RBAC. A document should be editable by its owner, viewable by organization members, and hidden from everyone else, a policy that requires relationship-aware authorization. Google's Zanzibar paper (2019) described the globally consistent authorization system behind Google Drive, Calendar, and YouTube, introducing the relationship tuple model that has since been implemented in open-source projects like SpiceDB, Ory Keto, and OpenFGA. This chapter implements the complete authentication and authorization stack for a multi-tenant Go application, from OAuth2/OIDC integration to fine-grained Zanzibar-style permissions with OPA for policy evaluation.

**What you'll learn in this chapter:**
- OAuth 2.0 flows in Go: Authorization Code with PKCE, Client Credentials, Token Introspection, and Token Exchange
- OIDC integration: ID token validation, JWKS key rotation handling, userinfo endpoint, and claims extraction
- JWT security: signing with RS256/ES256, validating claims (iss, aud, exp, nbf), and avoiding common JWT vulnerabilities
- RBAC implementation: role hierarchy, permission inheritance, middleware enforcement, and database-backed policy storage
- ABAC and OPA (Open Policy Agent): writing Rego policies, integrating the OPA Go SDK, and testing policy logic
- Zanzibar-style authorization with SpiceDB: defining relationship schemas, writing check and expand queries in Go
- Multi-tenant authorization: tenant isolation patterns, cross-tenant permission boundaries, and data scoping at the ORM layer
- Secure token refresh with rotation: refresh token families, reuse detection, and invalidation on suspicious activity

**Why this matters at scale:**
Google's Zanzibar system, per its published paper, stores trillions of access control list entries and serves millions of authorization checks per second with 95th percentile latency under 10ms, a scale that necessitated an entirely new approach to authorization modeling. Slack's permission system must enforce channel membership, workspace boundaries, and enterprise grid organization policies simultaneously across every API call, making a simple RBAC model insufficient. Auth0 (now part of Okta) processes billions of authentication transactions per month for its customers, and even a subtle JWT validation bug in their SDK could expose millions of applications. For any Go service handling user data or sensitive operations, getting authentication and authorization right is not optional. It is the foundation of every compliance framework from SOC 2 to ISO 27001.

**Prerequisites:** Chapter 107 (Application Security), Chapter 108 (Cryptography & TLS), Chapter 109 (Secrets Management), Chapter 110 (Supply Chain Security), Chapter 111 (Zero Trust Architecture); Go 1.27.1 baseline.

### Junior → FAANG: Authentication and Authorization as Foundational Skills

Authentication and authorization appear in every backend interview at FAANG companies. Engineers who cannot describe the difference clearly or who conflate the two are screened out early. This chapter covers the conceptual and implementation foundations that every backend engineer must have.

**Gap to close:** Know the difference between authentication (proving who you are) and authorization (determining what you are allowed to do). Confusing them is a red flag in interviews. Authentication happens first: you cannot authorize a request without knowing who is making it. Authorization happens second: knowing who the user is does not automatically mean knowing what they can do.

**First-job checklist:** For every new API endpoint you build, explicitly answer: (1) who can access this endpoint? (authentication requirement), (2) what actions are allowed and for which users or roles? (authorization requirement). Writing these answers in the PR description forces you to think about both concerns before the code is reviewed.

**Interview framing:** When asked to design an authentication system, describe the layers: identity provider (OAuth 2.0 / OIDC), token format (JWT), validation middleware (verify signature, expiry, audience), and session management (refresh token rotation). This structured answer covers the full authentication lifecycle and demonstrates production-level thinking.

### Senior @ FAANG: Auth as a Platform, Not a Per-Service Concern

At senior level, authentication and authorization are platform concerns. Every service in the organization should use the same auth infrastructure, policies, and patterns. Building auth per-service is not just inefficient: it is inconsistent, and inconsistency creates security gaps.

**Auth platform design:** Define the org-wide auth platform: the identity provider (Keycloak, Auth0, Okta), the token format and claims schema, the middleware library that every Go service imports for token validation, the authorization policy engine (OPA, SpiceDB), and the session management service. Every new service uses the platform, not a custom implementation. New capabilities (a new authorization model, a new token type) are added to the platform and all services benefit.

**ADR for authentication architecture:** When choosing or changing the identity provider, token format, or authorization model for your organization, write an ADR. The ADR covers: what is being decided, what options were considered, what the decision is and why, and what the consequences are (including migration plan for existing services). Auth architecture ADRs are high-impact: they affect every service and every user. They require careful reasoning and broad review.

**Security incident response for auth failures:** Auth failures are security incidents. Abnormal authentication failure rates (brute force, credential stuffing), anomalous authorization patterns (a user accessing resources they have never accessed before), or unexpected token claims (a token with elevated privileges that was not legitimately issued) all require incident response procedures. Staff engineers define these procedures and ensure they are tested.

---
