## 39.5 Role-Based Access Control (RBAC)

### RBAC Implementation

Permissions are modeled as resource-action pairs with wildcard support, so a single `{Resource: "*", Action: "*"}` entry grants admin-level access without enumerating every endpoint. The checker evaluates role membership and permission overlap at the service layer, not just the router, enforcing authorization even on internal method calls.

```go
// ... imports omitted for brevity (context, errors)

// Role represents a role with permissions
type Role struct {
    Name        string       `json:"name"`
    Description string       `json:"description"`
    Permissions []Permission `json:"permissions"`
}

// Permission represents a specific permission
type Permission struct {
    Resource string `json:"resource"` // e.g., "posts", "users", "*"
    Action   string `json:"action"`   // e.g., "read", "write", "delete", "*"
}

// Predefined roles
var (
    RoleAdmin = Role{
        Name:        "admin",
        Description: "Full system access",
        Permissions: []Permission{
            {Resource: "*", Action: "*"},
        },
    }

    RoleEditor = Role{
        Name:        "editor",
        Description: "Can manage content",
        Permissions: []Permission{
            {Resource: "posts", Action: "*"},
            {Resource: "comments", Action: "*"},
            {Resource: "users", Action: "read"},
        },
    }

    RoleViewer = Role{
        Name:        "viewer",
        Description: "Read-only access",
        Permissions: []Permission{
            {Resource: "*", Action: "read"},
        },
    }
)

// RBACService manages role-based access control
type RBACService struct {
    roles map[string]Role
}

func NewRBACService() *RBACService {
    service := &RBACService{
        roles: make(map[string]Role),
    }

    // Register default roles
    service.RegisterRole(RoleAdmin)
    service.RegisterRole(RoleEditor)
    service.RegisterRole(RoleViewer)

    return service
}

func (s *RBACService) RegisterRole(role Role) {
    s.roles[role.Name] = role
}

// HasPermission checks if user has permission for resource/action
func (s *RBACService) HasPermission(userRoles []string, resource, action string) bool {
    for _, roleName := range userRoles {
        role, ok := s.roles[roleName]
        if !ok {
            continue
        }

        for _, perm := range role.Permissions {
            if s.matchPermission(perm, resource, action) {
                return true
            }
        }
    }
    return false
}

func (s *RBACService) matchPermission(perm Permission, resource, action string) bool {
    resourceMatch := perm.Resource == "*" || perm.Resource == resource
    actionMatch := perm.Action == "*" || perm.Action == action
    return resourceMatch && actionMatch
}

// GetUserPermissions returns all permissions for a user's roles
func (s *RBACService) GetUserPermissions(userRoles []string) []Permission {
    seen := make(map[string]bool)
    var permissions []Permission

    for _, roleName := range userRoles {
        role, ok := s.roles[roleName]
        if !ok {
            continue
        }

        for _, perm := range role.Permissions {
            key := perm.Resource + ":" + perm.Action
            if !seen[key] {
                seen[key] = true
                permissions = append(permissions, perm)
            }
        }
    }

    return permissions
}
```

### RBAC Middleware

Two middleware variants cover different access control granularities. `RequirePermission` checks a specific resource-action pair against the user's role permissions, suitable for route-level enforcement. `RequireRole` checks for role membership directly, useful for admin-only sections where enumerating individual permissions is unnecessary.

```go
// ... imports omitted for brevity (net/http)

// RequirePermission middleware checks for specific permission
func RequirePermission(rbac *RBACService, resource, action string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            user := GetUser(r.Context())
            if user == nil {
                http.Error(w, "Unauthorized", http.StatusUnauthorized)
                return
            }

            if !rbac.HasPermission(user.Roles, resource, action) {
                http.Error(w, "Forbidden", http.StatusForbidden)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// RequireRole middleware checks for specific role
func RequireRole(roles ...string) func(http.Handler) http.Handler {
    roleSet := make(map[string]bool)
    for _, r := range roles {
        roleSet[r] = true
    }

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            user := GetUser(r.Context())
            if user == nil {
                http.Error(w, "Unauthorized", http.StatusUnauthorized)
                return
            }

            hasRole := false
            for _, userRole := range user.Roles {
                if roleSet[userRole] {
                    hasRole = true
                    break
                }
            }

            if !hasRole {
                http.Error(w, "Forbidden", http.StatusForbidden)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// Example route setup
func setupRoutes(r chi.Router, rbac *RBACService) {
    r.Route("/api/admin", func(r chi.Router) {
        r.Use(JWTAuth(tokenService))
        r.Use(RequireRole("admin"))

        r.Get("/users", listAllUsers)
        r.Delete("/users/{id}", deleteUser)
    })

    r.Route("/api/posts", func(r chi.Router) {
        r.Use(JWTAuth(tokenService))

        r.With(RequirePermission(rbac, "posts", "read")).Get("/", listPosts)
        r.With(RequirePermission(rbac, "posts", "write")).Post("/", createPost)
        r.With(RequirePermission(rbac, "posts", "delete")).Delete("/{id}", deletePost)
    })
}
```

### Junior → FAANG: RBAC Foundations and First-Job Context

RBAC answers one question: given this user, can they perform this action on this resource? The code above gives you the mental model. Read it once, then internalize these three rules before any interview.

First, separate authentication from authorization. Authentication asks "who are you" and produces a user identity. Authorization asks "what can you do" and produces an allow/deny decision. The JWT middleware from earlier chapters does authentication. The `RBACService` here does authorization. Junior candidates routinely conflate them in system design rounds. They are different subsystems with different failure modes. A JWT that cannot be verified is a 401. A verified JWT without the right role is a 403. Returning the wrong code leaks information about account existence.

Second, enforce at the service layer, not just the router. The middleware check is a fast-fail gate. Every service method that touches a resource should re-check authorization using the same `HasPermission` call. The reason is defense in depth. If a future developer adds an internal RPC path that bypasses HTTP middleware, the service check still holds. The discipline big shops converge on: every function that reads or mutates user data takes an authorization context argument. Adopt the same habit in your first job and it will pay off forever.

Third, wildcard permissions are convenient and dangerous. A `{Resource: "*", Action: "*"}` admin permission is fine for an internal admin role, but shipping it to a customer-facing role is how breaches happen. In code review, flag any wildcard that is not attached to a clearly named internal role, and write a test that asserts the set of wildcard-holding roles is exactly the set you expect. A drift test like that catches the "someone added `*` to the support role" bug before it reaches production.

Worked example for a first-job task. Your tech lead asks you to add a "moderator" role that can delete comments but not posts. With the code above you add:

```go
RoleModerator = Role{
    Name: "moderator",
    Permissions: []Permission{
        {Resource: "comments", Action: "delete"},
        {Resource: "comments", Action: "read"},
        {Resource: "posts", Action: "read"},
    },
}
```

The interview follow-up will be: "what if a moderator should only delete comments on posts they are assigned to moderate?" Now you are past RBAC. You need a resource-instance predicate, and that is where ABAC or ReBAC enters. The answer a junior gets credit for is: "RBAC cannot express instance-level rules without role explosion, so I would extend the permission check with an attribute predicate or move to a relationship model." Memorize that sentence.

Interview entry-points:

1. What is role explosion? When you encode instance permissions as roles (`editor_of_team_42`), the role table grows linearly with resources. At 10k teams you have 10k roles per permission class.
2. How do you handle role inheritance? Either flatten at role registration time (compute transitive permissions once) or walk the hierarchy at check time with memoization. Flattening is simpler and faster but forces a full recompute on role edits.
3. How do you audit "who can do X"? Reverse-index permissions to roles to users. Required for SOC2 access reviews.

Common junior mistake: encoding authorization in the JWT claims and trusting them forever. Roles change. Tokens live for an hour. Re-fetch roles from the source of truth on every check, or accept a short staleness window you can defend in writing.

### Senior @ FAANG: RBAC vs ABAC vs ReBAC, Role Explosion, and the Zanzibar Model

At staff level, the question is not "how do I implement RBAC" but "which authorization model fits this domain, and when do I migrate off RBAC." The code above is fine for an admin console with ten roles. It is the wrong primitive for Google Drive, GitHub, Dropbox, Figma, or any product where users share specific resources with specific other users. Understanding why drives the rest of this section.

**The three models.** RBAC assigns permissions to roles and roles to users. ABAC (Attribute-Based Access Control) evaluates policy expressions over attributes of the subject, resource, action, and environment. ReBAC (Relationship-Based Access Control) models the system as a graph of relationships and answers authorization by checking for a path in that graph. Each model expresses different shapes of rule cleanly and others only with pain.

RBAC shines when permissions are organizational (employees, contractors, admins) and the resource set is small or uniform. ABAC shines when decisions depend on runtime context (time of day, geography, resource sensitivity label, data classification). ReBAC shines when the product is fundamentally about sharing: "users who are editors of the folder containing this document can edit the document." Trying to express that in RBAC produces role explosion. Trying to express it in ABAC produces attribute explosion and N+1 attribute fetches.

**Role explosion in detail.** Consider GitHub. A user can be an admin of org A, a maintainer of repo A/x, a triager of repo A/y, and a read-only collaborator on a private gist. If you encode each of those as a role (`admin_org_A`, `maintainer_A_x`, `triager_A_y`, `reader_gist_Z`), the role table grows with O(users * resources) and every permission check becomes a linear scan of the user's role set. GitHub does not do this. GitHub uses a graph: user → team → repo with edge types. Zanzibar is the same pattern generalized.

**Zanzibar and its 2026 landscape.** Google's 2019 USENIX paper "Zanzibar: Google's Consistent, Global Authorization System" described the system that backs Drive, Calendar, Cloud, YouTube, and Photos. Core ideas: relation tuples of the form `object#relation@user`, a rewrite language (`userset rewrite rules`) that defines how relations compose, external consistency via a token called a "zookie" that lets clients pin reads to a causally-after-write snapshot, and horizontal sharding with a leaderless caching tier. The open-source implementations as of 2026 are Authzed SpiceDB (most feature-complete, SQL-backed), OpenFGA (originally Auth0, now a CNCF Sandbox project, strong TypeScript and Go ecosystems), and Permify. Choose SpiceDB for complex schemas with caveats and hot-path latency sensitivity. Choose OpenFGA for simpler schemas and tighter integration with Auth0/Okta deployments.

**Go-specific libraries.** Casbin is the established Go RBAC/ABAC library with a policy-as-code model based on the PERM (Policy, Effect, Request, Matchers) metamodel. It supports RBAC with inheritance, ABAC with expressions, and a handful of storage adapters. Casbin is a good fit for internal tools and mid-sized SaaS. It is not a Zanzibar system. If you need ReBAC, pair Casbin for org-roles with SpiceDB or OpenFGA for relationship decisions. Open Policy Agent (OPA) with Rego is the dominant policy engine for Kubernetes admission and API gateway decisions. Rego expresses complex ABAC cleanly and has mature tooling (conftest, Styra DAS, regorus for embedding). AWS Cedar (open-sourced in 2023, maturing in 2026) is the policy language for Amazon Verified Permissions and is now also available as a standalone library with a verified formal semantics, which matters for compliance reviews.

**Decision architecture.** A staff-grade authorization system separates four concerns: the Policy Decision Point (PDP) that answers "allow or deny", the Policy Enforcement Point (PEP) that calls the PDP and enforces the result, the Policy Information Point (PIP) that supplies attributes and relationships, and the Policy Administration Point (PAP) that manages policy lifecycle. The middleware in the code above conflates PEP and PDP, which is fine at small scale. At FAANG scale the PDP runs as a sidecar or library with in-memory caches, the PAP is a separate service with a git-backed policy repo and CI-driven deployment, and the PIP is a federated fetcher with circuit breakers per upstream. Decouple these from day one even if they start co-located. The refactor later is expensive.

**Consistency and the stale-authz problem.** If you revoke a user's access to a document at time T, when must that revocation take effect? Strict linearizability everywhere is prohibitively expensive. Zanzibar's zookie model gives you bounded staleness: the client that performed the write gets a zookie, passes it to subsequent reads, and Zanzibar guarantees reads observe the write. Other readers may see stale state for up to a configured window. For most products a ten-second bound is the right trade-off. For regulated domains (healthcare, finance) you need strong consistency on the revoke path, which typically means synchronous cache invalidation plus a version-number fence. Document this in your threat model because auditors will ask.

**Caveats and conditional relations.** SpiceDB caveats (added 2023, matured through 2025) let relations carry predicates that evaluate at check time against a context object, giving you ReBAC+ABAC hybrids without leaving the tuple model. Example: "X is an editor of document Y, but only during business hours in the document's tenant timezone." This collapses into a single tuple with a caveat expression instead of a relation plus a separate ABAC policy. Use caveats for environmental and temporal constraints. Keep pure relationship edges for sharing.

**Authorization testing at scale.** Unit tests on `HasPermission` are insufficient. You need three additional layers. First, policy unit tests that assert decisions on canonical (subject, resource, action) triples, living with the policy repo and failing CI on regression. Second, integration tests that exercise the PEP-PDP-PIP chain with realistic fixtures. Third, shadow evaluation in production: dual-write every real decision to a shadow PDP, diff the results, alert on divergence. This shadow-diff pattern is how large platforms de-risk authorization migrations (Airbnb's public writeup of its Himeji system is one example), and it is the correct way to land a Zanzibar migration. Cedar's formal verification story (decidable fragment, proofs of properties like "no action with PII resource can be allowed without the pii-access role") is uniquely strong here and is appearing in FAANG compliance packages.

**OWASP API Top 10 framing.** In the 2023 edition, the current one, BOLA (Broken Object-Level Authorization) is ranked number one. BOLA is the instance-level failure mode RBAC cannot prevent: a user is authorized for the action class ("read invoice") but not for this specific invoice instance. Every API that exposes resource IDs must have an object-level check, and that check must be wired to a ReBAC or ABAC decision, not a role match. The common implementation bug is trusting a client-supplied tenant ID or owner ID rather than the one bound to the authenticated identity. Pin the owner at the session layer, never trust the request body.

**What a staff design review demands.** A written model choice (RBAC, ABAC, ReBAC, or hybrid) with a rationale, a policy-as-code repo with CI, a decision-log contract, a staleness budget, a BOLA test plan, and an explicit scale target (tuples per second, check latency P99, policy update propagation time). Without these, the design will get bounced.

---
