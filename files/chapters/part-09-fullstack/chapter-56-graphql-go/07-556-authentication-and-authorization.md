## 56.6 Authentication and Authorization

### Context-Based Authentication

Passing the authenticated user through the request context is the standard Go pattern for making auth state available to resolvers without threading it through every function signature. The auth middleware extracts and validates the JWT, constructs a typed principal, and stores it in the context before the GraphQL execution engine dispatches to resolvers. The implementation below defines the context key, the middleware, and a helper function that resolvers call to retrieve the principal or return an unauthenticated error.

```go
// internal/auth/context.go
package auth

import (
    "context"
    "fmt"
    "net/http"
    "strings"

    "graphql-api/graph/model"
)

type contextKey string

const userContextKey contextKey = "user"

// UserFromContext extracts the authenticated user from context
func UserFromContext(ctx context.Context) (*model.User, error) {
    user, ok := ctx.Value(userContextKey).(*model.User)
    if !ok || user == nil {
        return nil, fmt.Errorf("unauthorized")
    }
    return user, nil
}

// WithUser adds a user to the context
func WithUser(ctx context.Context, user *model.User) context.Context {
    return context.WithValue(ctx, userContextKey, user)
}

// Middleware extracts JWT and adds user to context
func Middleware(authService Service) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            authHeader := r.Header.Get("Authorization")
            if authHeader == "" {
                // Continue without user (anonymous)
                next.ServeHTTP(w, r)
                return
            }

            // Extract bearer token
            parts := strings.SplitN(authHeader, " ", 2)
            if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
                next.ServeHTTP(w, r)
                return
            }

            // Validate token and get user
            user, err := authService.ValidateToken(r.Context(), parts[1])
            if err != nil {
                // Invalid token, continue as anonymous
                next.ServeHTTP(w, r)
                return
            }

            // Add user to context
            ctx := WithUser(r.Context(), user)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}
```

### Directive-Based Authorization

GraphQL schema directives like `@hasRole(role: ADMIN)` declaratively annotate which operations require which permissions, making the authorization model visible in the schema rather than buried in resolver code. Implementing directives as gqlgen middleware intercepts field resolution and checks the context-injected principal before delegating to the underlying resolver. The example below defines a `@hasRole` directive, registers it in the schema, and implements the enforcement logic in the directive handler.

First, declare the directives in the schema so clients can see which fields require authentication or specific roles:

```graphql
# Add directives to schema
directive @auth on FIELD_DEFINITION
directive @hasRole(role: UserRole!) on FIELD_DEFINITION

type Query {
  me: User @auth
  users(first: Int, after: String): UserConnection! @hasRole(role: ADMIN)
}

type Mutation {
  createUser(input: CreateUserInput!): User! @hasRole(role: ADMIN)
  updateUser(id: UUID!, input: UpdateUserInput!): User! @auth
  deleteUser(id: UUID!): Boolean! @hasRole(role: ADMIN)
}
```

Then implement the directive handlers in Go. Each directive function receives the resolver context, checks the auth state, and either proceeds to the next resolver or returns an access-denied error:

```go
// graph/directives.go
package graph

import (
    "context"
    "fmt"

    "github.com/99designs/gqlgen/graphql"
    "graphql-api/graph/model"
    "graphql-api/internal/auth"
)

// DirectiveRoot contains all directive implementations
type DirectiveRoot struct{}

func (d *DirectiveRoot) Auth(
    ctx context.Context,
    obj any,
    next graphql.Resolver,
) (any, error) {
    user, err := auth.UserFromContext(ctx)
    if err != nil {
        return nil, fmt.Errorf("access denied: authentication required")
    }
    if user == nil {
        return nil, fmt.Errorf("access denied: authentication required")
    }
    return next(ctx)
}

func (d *DirectiveRoot) HasRole(
    ctx context.Context,
    obj any,
    next graphql.Resolver,
    role model.UserRole,
) (any, error) {
    user, err := auth.UserFromContext(ctx)
    if err != nil {
        return nil, fmt.Errorf("access denied: authentication required")
    }

    if user.Role != role && user.Role != model.UserRoleAdmin {
        return nil, fmt.Errorf("access denied: requires %s role", role)
    }

    return next(ctx)
}
```

### Junior -> FAANG: Auth Fundamentals to Have Before Day One

Two concepts to understand before your first GraphQL auth code review:

First, the context pattern. The Go context is the standard mechanism for passing request-scoped values (the authenticated user, a request ID, a deadline) through the call stack without threading them through every function signature. `context.WithValue` stores a value, and `ctx.Value(key)` retrieves it. The context key must be an unexported type (not a string) to prevent key collisions between packages. The pattern in this file uses `type contextKey string` and a constant `userContextKey contextKey = "user"`. This is correct.

Second, the scope of directive-based authorization. A `@hasRole(role: ADMIN)` directive on a field enforces that only admins can resolve that field. It does not enforce that only admins can request the parent object. A non-admin can still query `me { email }` and get the `email` field because `email` has no directive. Authorization directives protect the field they annotate, not the entire object subtree below it. If you want to protect a field and all its children, annotate the field.

The most common authorization bug in junior GraphQL code: checking authorization at the root query level (in the `User(ctx, id)` resolver) but not at the field level (in `(r *userResolver) Email(ctx, obj)`). This allows a client to query `me { friends { email ssn } }` and bypass the root-level check, because `friends` is resolved on the user object, not by the root `User` resolver.

### Senior @ FAANG: Authorization Architecture for Multi-Team Graphs

At staff level, directive-based authorization (`@hasRole`, `@auth`) is a starting point, not the destination. Understanding its limitations and when to move beyond it is a bar-raiser signal.

**The limits of directive-based RBAC.** Schema directives can express role-based rules: "only admins can access this field." They cannot express attribute-based rules: "a user can access this order only if they are the order's owner, or an admin, or a support agent with an active case for this user." That requires comparing the authenticated principal against field values on the resolved object, which requires access to the resolver's return value. A directive that runs before the resolver cannot do this. A directive that wraps the resolver (using `next(ctx)` and then inspecting the returned value) can, but becomes complex quickly.

**External policy engines.** For systems where authorization rules are complex, data-driven, or need to be auditable separately from the application code, FAANG teams use external policy engines: OpenFGA (Fine-Grained Authorization from Auth0), Oso, or Cerbos. The resolver calls the policy engine with the principal, the action, and the resource, and the engine evaluates the authorization decision against a policy that is stored, versioned, and auditable independently of the Go code.

**WebSocket auth is architecturally distinct from HTTP auth.** For subscriptions, the authentication happens at connection initialization (`InitFunc` in the transport configuration), not per-message. The connection-level auth produces a context that is reused for the lifetime of the WebSocket connection. If a user's JWT expires while a subscription is active, the subscription continues to receive events because the connection was authenticated at start. The correct handling is to validate token expiry in the subscription resolver's goroutine and close the channel (which disconnects the subscription) when the token expires.

**Authorization audit logging.** At FAANG, every authorization decision on a sensitive field should be logged as a structured event: who accessed what field, on which object, with which role, at what time, from which request ID. This is an audit trail for compliance (SOC 2, GDPR data access logs) and for incident response (determining what data was accessed during a compromised session). The gqlgen field middleware is the correct interception point: it can record `{field: "User.ssn", principal: userID, result: "allowed|denied", requestID: ...}` before every field resolution.

**The `@auth` vs `@hasRole` split.** Keeping `@auth` (requires any authenticated user) separate from `@hasRole` (requires a specific role) is correct because they have different error semantics. An `@auth` failure means the client is unauthenticated and should re-authenticate (HTTP 401 equivalent). A `@hasRole` failure means the client is authenticated but lacks permission (HTTP 403 equivalent). Clients handle these differently: unauthenticated clients redirect to login, forbidden clients show an access-denied message. Conflating them into a single directive that always returns "access denied" makes this distinction invisible to clients.

---
