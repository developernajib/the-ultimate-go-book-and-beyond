## 112.1 Authentication vs Authorization

Authentication (AuthN) and authorization (AuthZ) are distinct security concerns that must both be enforced on every request. Authentication establishes *who* is making a request by verifying a credential such as a password, JWT, or client certificate, while authorization determines *what* that verified identity is permitted to do based on roles, policies, or attribute checks. Conflating the two, for example, granting access solely because a user is authenticated, is a leading cause of privilege-escalation vulnerabilities in Go services.

```
┌───────────────────────────────────────────────────────────────┐
│                    Security Flow                              │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  1. AUTHENTICATION (AuthN): "Who are you?"                    │
│     ┌──────────────────────────────────────┐                  │
│     │ User provides credentials            │                  │
│     │ System verifies identity             │                  │
│     │ Returns: Identity token/session      │                  │
│     └──────────────────────────────────────┘                  │
│                        ↓                                      │
│  2. AUTHORIZATION (AuthZ): "What can you do?"                 │
│     ┌──────────────────────────────────────┐                  │
│     │ User requests resource/action        │                  │
│     │ System checks permissions            │                  │
│     │ Returns: Allow or Deny               │                  │
│     └──────────────────────────────────────┘                  │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**Key Distinction**:
- **Authentication**: Proves identity (login with password, OAuth, biometrics)
- **Authorization**: Controls access (can this user edit this document?)

### Junior → FAANG: Making the AuthN/AuthZ Distinction Automatic

The authentication vs authorization distinction must be reflexive, not retrieved from memory. In an interview, hesitation on this fundamental distinction signals inexperience.

**Gap to close:** Practice explaining the distinction in one sentence each: "Authentication is proving your identity. Authorization is verifying your permissions for a specific action." Then give a concrete example: "Logging in with a password is authentication. Checking whether a logged-in user can delete an invoice is authorization." The example makes the abstract concrete.

**Common mistake:** Checking authentication but not authorization. A handler that validates the JWT (authentication) but then returns data for any resource ID without checking whether the authenticated user owns that resource (authorization) has an IDOR vulnerability. Authentication is necessary but not sufficient.

**Interview framing:** When presented with a code snippet that has authentication middleware, ask: "Where is authorization checked?" If there is no authorization check, describe IDOR as the resulting vulnerability and explain that resource-level authorization must be applied in every handler that accesses a specific resource.

### Senior @ FAANG: AuthN and AuthZ as Distinct Infrastructure Components

At senior level, authentication and authorization are distinct infrastructure components with different update cadences, different ownership models, and different failure modes.

**Separation of concerns in infrastructure:** Authentication (who is this user?) changes rarely: the identity provider, the token format, and the session management protocol are stable for years. Authorization (what can this user do?) changes frequently: new features add new permission checks, business rules change access models, regulatory requirements update data access policies. Building separate infrastructure for authentication and authorization (rather than baking both into each service) allows each to evolve at its own pace.

**Authorization plane latency:** Authorization checks are on the critical path for every API request. The authorization infrastructure must be fast (sub-millisecond for local evaluation, sub-10ms for remote OPA calls) and highly available (a down authorization service blocks all API requests). Design the authorization infrastructure with these constraints in mind: prefer local policy evaluation (OPA embedded in the service) over remote calls when latency is critical, and when remote calls are required, use circuit breakers that fail closed (deny all on circuit open). Failing open on an authorization outage converts a dependency failure into an authorization bypass.

---
