# Chapter 112B: OAuth 2.0 & OIDC Complete Implementation Guide

> *"Delegated authorization is not a convenience feature. It is the architectural boundary between who you are and what you can do."*

OAuth 2.0 and OpenID Connect (OIDC) are the twin pillars of modern identity on the web. OAuth 2.0 defines how a user or service can delegate access to a resource without sharing credentials, while OIDC layers a standardized identity assertion on top, answering the question "who is this user?" in a cryptographically verifiable way. Together, they power everything from "Sign in with Google" buttons to machine-to-machine API authorization in enterprise microservice meshes. Understanding them deeply is not optional for any Go engineer building services that touch user data or third-party integrations.

The protocol landscape, however, is littered with subtlety. The authorization code flow, the client credentials flow, the device authorization flow, PKCE, token introspection, token revocation, refresh token rotation, DPoP proof-of-possession, and JWKS key rotation each solve a distinct threat model. Choosing the wrong grant type, or implementing the right one incorrectly, has caused high-profile security breaches at companies of every size. In Go, you have the tools to implement every layer of this stack correctly: the `crypto` package for PKCE verifiers, `net/http` for server endpoints, and ecosystem libraries like `golang.org/x/oauth2` for client-side flows.

This chapter walks you through every major OAuth 2.0 grant type and its corresponding OIDC extensions with full, production-quality Go implementations. You will build an authorization server from scratch, implement a resource server that validates JWTs against a rotating JWKS endpoint, harden public clients with PKCE, and integrate with real social identity providers. Security is woven into every example: CSRF state parameters, strict redirect URI validation, opaque token storage, and binding tokens to client TLS certificates.

**What you'll learn in this chapter:**

- How the OAuth 2.0 authorization code flow works end-to-end and why PKCE is mandatory for public clients
- Implementing the client credentials flow for secure machine-to-machine service authorization
- The device authorization flow for CLI tools, smart TVs, and headless environments
- Token introspection and revocation endpoints: protecting resource servers from stale or stolen tokens
- Refresh token rotation strategies that prevent replay attacks without degrading user experience
- JWKS key rotation: serving and consuming JSON Web Key Sets with zero-downtime key rollover
- Social login integration with Google, GitHub, and Microsoft using Go's `oauth2` package
- Security hardening: DPoP proof-of-possession tokens, token binding, and CSRF protection

**Why this matters at scale:**

Payment platforms like Stripe authenticate millions of API calls daily via OAuth-style credentials, and a single misconfigured scope check in any such integration can become a privilege escalation. GitHub's OAuth implementation powers tens of thousands of developer tools, and the industry-wide push toward mandatory PKCE closed a token-interception vector that had existed for years. Okta, Auth0, and Keycloak, the identity platforms used by Fortune 500 companies, are all OAuth 2.0 / OIDC authorization servers at their core. Building this knowledge means you can evaluate, audit, and extend any of them.

**Prerequisites:** [Chapter 112: Authentication & Authorization Deep Dive](../chapter-112-auth-authz/00-introduction.md), working knowledge of Go's `net/http` package, familiarity with public-key cryptography concepts (RSA/ECDSA signing, [Chapter 108](../chapter-108-cryptography/00-introduction.md)), and a local Go 1.27.1+ toolchain.

---
