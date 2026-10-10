## 112.5 Role-Based Access Control (RBAC)

RBAC assigns permissions to roles, and roles to users.

```go
package rbac

import (
    "errors"
    "net/http"
    "sync"
)

type Permission string

const (
    PermUserRead    Permission = "user:read"
    PermUserWrite   Permission = "user:write"
    PermUserDelete  Permission = "user:delete"
    PermAdminAccess Permission = "admin:access"
)

type Role struct {
    Name        string
    Permissions []Permission
}

type RBAC struct {
    mu               sync.RWMutex
    roles            map[string]*Role
    userRoles        map[string][]string // userID -> role names
    roleInheritance  map[string][]string // role -> parent roles
}

func NewRBAC() *RBAC {
    rbac := &RBAC{
        roles:           make(map[string]*Role),
        userRoles:       make(map[string][]string),
        roleInheritance: make(map[string][]string),
    }

    // Define standard roles
    rbac.AddRole(&Role{
        Name: "viewer",
        Permissions: []Permission{
            PermUserRead,
        },
    })

    rbac.AddRole(&Role{
        Name: "editor",
        Permissions: []Permission{
            PermUserRead,
            PermUserWrite,
        },
    })

    rbac.AddRole(&Role{
        Name: "admin",
        Permissions: []Permission{
            PermUserRead,
            PermUserWrite,
            PermUserDelete,
            PermAdminAccess,
        },
    })

    return rbac
}

func (r *RBAC) AddRole(role *Role) {
    r.mu.Lock()
    defer r.mu.Unlock()
    r.roles[role.Name] = role
}

func (r *RBAC) AssignRole(userID, roleName string) error {
    r.mu.Lock()
    defer r.mu.Unlock()

    if _, exists := r.roles[roleName]; !exists {
        return errors.New("role not found")
    }

    r.userRoles[userID] = append(r.userRoles[userID], roleName)
    return nil
}

func (r *RBAC) HasPermission(userID string, permission Permission) bool {
    r.mu.RLock()
    defer r.mu.RUnlock()

    roles := r.userRoles[userID]
    for _, roleName := range roles {
        if r.roleHasPermission(roleName, permission) {
            return true
        }
    }
    return false
}

func (r *RBAC) roleHasPermission(roleName string, permission Permission) bool {
    role, exists := r.roles[roleName]
    if !exists {
        return false
    }

    for _, p := range role.Permissions {
        if p == permission {
            return true
        }
    }

    // Check inherited roles
    for _, parentRole := range r.roleInheritance[roleName] {
        if r.roleHasPermission(parentRole, permission) {
            return true
        }
    }

    return false
}

// Middleware for HTTP handlers
func (r *RBAC) RequirePermission(permission Permission) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
            userID, ok := req.Context().Value("user_id").(string)
            if !ok {
                http.Error(w, "unauthorized", http.StatusUnauthorized)
                return
            }

            if !r.HasPermission(userID, permission) {
                http.Error(w, "forbidden", http.StatusForbidden)
                return
            }

            next.ServeHTTP(w, req)
        })
    }
}
```

### Junior → FAANG: RBAC Implementation in Go

RBAC (Role-Based Access Control) is the most widely used authorization model. Understanding how to implement it correctly in Go middleware is required for any backend engineering role.

**Gap to close:** Know the three components of RBAC: roles (named sets of permissions), permissions (specific allowed actions), and role assignments (which roles a user has). The RBAC check is: does the user have a role that includes the required permission for this resource? Simple hierarchical RBAC can be implemented as a map lookup. Complex RBAC with role hierarchies requires a recursive traversal.

**Common mistake:** Checking roles in the handler instead of in dedicated authorization middleware. Authorization checks belong in middleware or in a service layer function, not scattered across handlers. Centralizing authorization makes it auditable, testable, and consistent.

**Interview framing:** When asked "how do you implement RBAC in a Go HTTP service?", describe: roles stored in the JWT claims or fetched from a user store, an authorization middleware that extracts the user's roles, a permission map that specifies which roles have which permissions, and a `RequirePermission` middleware that checks the extracted roles against the required permission before allowing the request to proceed. This layered design is the correct answer.

### Senior @ FAANG: RBAC at Scale: Role Explosion and Policy Governance

At senior level, RBAC management becomes a governance problem. Role explosion (too many roles, each slightly different) and permission drift (roles accumulating permissions over time) are the most common RBAC failures at scale.

**Role proliferation prevention:** Define a naming convention and a maximum number of roles per resource type. Require review for new role creation. When engineers need a new permission configuration, first check whether an existing role can be extended or whether an ABAC (attribute-based) approach would be more flexible. RBAC with more than 50 roles per product area is a signal that ABAC or Zanzibar-style authorization would be more appropriate.

**Permission drift detection:** Use IAM Access Analyzer (for AWS) or build a similar tool for your RBAC system: identify permissions that are assigned to roles but never exercised (by analyzing authorization decision logs). Permissions that are never used are candidates for removal. Regularly removing unused permissions reduces the blast radius of a role compromise.

**Separation of duties:** For sensitive operations (financial transactions, PII access, security configuration changes), implement separation of duties: no single role can both initiate and approve an action. This requires RBAC to support multi-party authorization workflows, not just single-party permission checks. Design the authorization model for sensitive operations with separation of duties as a requirement from the start.

---
