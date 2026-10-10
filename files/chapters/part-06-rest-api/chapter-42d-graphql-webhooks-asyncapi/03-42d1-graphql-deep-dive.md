## 42D.1 GraphQL in Go with gqlgen

### What GraphQL Solves

GraphQL was created at Facebook in 2012 to solve a specific problem: mobile clients needed different data than desktop clients, and the REST API was either over-fetching (too much data) or under-fetching (requiring multiple round trips).

### Picking a Go GraphQL Library in 2026

Two libraries matter in Go. `github.com/99designs/gqlgen` is the dominant choice: schema-first with `go generate` codegen, strict type safety between SDL and Go, per-field resolvers, built-in complexity/depth extensions, and first-class Apollo Federation v2 support. `github.com/graph-gophers/graphql-go` is the alternative: reflection-based binding with no codegen step, smaller surface, used mostly on services that predate gqlgen's maturation.

Pick gqlgen unless you have a specific reason not to, and pick it for the codegen rather than for throughput. Public comparisons exist (`appleboy/golang-graphql-benchmark` is the usual reference) but treat any published numbers as a starting point to re-measure on your own workload, since in a real service the resolver's database call dominates the executor by orders of magnitude. The argument that actually holds is correctness: with codegen, a schema field with no matching resolver is a compile error, whereas a reflection-based binding discovers the same drift when a production query touches the field.

```
Over-fetching (REST):  GET /users/123  → returns 50 fields, client uses 3
Under-fetching (REST): GET /users/123  → then GET /posts/456 → then GET /comments/789
GraphQL:               Single query returns exactly the 3 fields + nested data
```

### Schema Definition Language (SDL)

The SDL defines the entire API surface (types, queries, mutations, and subscriptions) as a strongly typed schema that both client and server agree on before any Go code is written. Relay-style `Connection` and `Edge` types for pagination and a `Payload` wrapper for mutations are conventions that keep the schema consistent and enable client-side caching libraries like Apollo to work automatically.

```graphql
# schema.graphql: the contract between client and server

type Query {
  user(id: ID!): User
  users(filter: UserFilter, pagination: PaginationInput): UserConnection!
  post(id: ID!): Post
}

type Mutation {
  createUser(input: CreateUserInput!): CreateUserPayload!
  updateUser(id: ID!, input: UpdateUserInput!): UpdateUserPayload!
  deleteUser(id: ID!): DeleteUserPayload!
}

type Subscription {
  userCreated: User!
  postPublished(authorId: ID): Post!
}

type User {
  id: ID!
  email: String!
  username: String!
  createdAt: Time!
  posts(first: Int, after: String): PostConnection!
  followerCount: Int!
}

type Post {
  id: ID!
  title: String!
  content: String!
  author: User!
  tags: [String!]!
  publishedAt: Time
  commentCount: Int!
}

# Relay-style pagination
type UserConnection {
  edges: [UserEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

type UserEdge {
  node: User!
  cursor: String!
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

input UserFilter {
  email: String
  username: String
  createdAfter: Time
}

input PaginationInput {
  first: Int
  after: String
  last: Int
  before: String
}

input CreateUserInput {
  email: String!
  username: String!
  password: String!
}

type CreateUserPayload {
  user: User
  errors: [UserError!]!
}

type UserError {
  field: String
  message: String!
  code: String!
}

scalar Time
```

### Setting Up gqlgen

gqlgen reads the SDL and generates a Go interface with one method per resolver field, then produces type-safe model structs that match the schema types. The `gqlgen.yml` binds custom scalar types like `Time` to Go implementations and controls which types are generated versus which are supplied manually, keeping generated code separate from business logic.

```bash
go get github.com/99designs/gqlgen@latest
go run github.com/99designs/gqlgen init
```

This generates:
- `graph/schema.graphqls` - your SDL schema
- `graph/resolver.go` - resolver struct
- `graph/generated/` - generated code (do not edit)
- `graph/model/` - generated Go types

**`gqlgen.yml` configuration:**

```yaml
# gqlgen.yml
schema:
  - graph/*.graphqls

exec:
  filename: graph/generated/generated.go
  package: generated

model:
  filename: graph/model/models_gen.go
  package: model

resolver:
  layout: follow-schema
  dir: graph
  package: graph
  filename_template: "{name}.resolvers.go"

# Bind custom scalars
models:
  Time:
    model: github.com/yourapp/graph/scalar.Time
  ID:
    model:
      - github.com/99designs/gqlgen/graphql/introspection.ID
      - github.com/yourapp/graph/scalar.ID
```

### Implementing Resolvers

Each resolver method receives a `context.Context` carrying the authenticated user, so authorization checks happen inside the resolver rather than at a separate middleware layer that cannot see field-level access control. Returning a `*model.User` rather than the raw database struct lets the schema control which fields are exposed, preventing accidental data leaks when new columns are added to the database model.

```go
// graph/query.resolvers.go
package graph

import (
	"context"
	"fmt"

	"github.com/yourapp/graph/generated"
	"github.com/yourapp/graph/model"
)

// User returns the resolver for user queries
func (r *queryResolver) User(ctx context.Context, id string) (*model.User, error) {
	// Auth check: always validate permissions
	viewer, err := auth.ViewerFromContext(ctx)
	if err != nil {
		return nil, err
	}

	user, err := r.userRepo.GetByID(ctx, id)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			return nil, nil // GraphQL convention: return nil, nil for not found
		}
		return nil, fmt.Errorf("fetching user: %w", err)
	}

	// Authorization: only admin or self can see full profile
	if viewer.ID != user.ID && !viewer.IsAdmin {
		return user.PublicProfile(), nil
	}

	return user, nil
}

func (r *queryResolver) Users(
	ctx context.Context,
	filter *model.UserFilter,
	pagination *model.PaginationInput,
) (*model.UserConnection, error) {
	opts := repo.ListUsersOptions{}
	if filter != nil {
		opts.Email = filter.Email
		opts.Username = filter.Username
		opts.CreatedAfter = filter.CreatedAfter
	}
	if pagination != nil {
		opts.First = pagination.First
		opts.After = pagination.After
	}

	users, pageInfo, total, err := r.userRepo.List(ctx, opts)
	if err != nil {
		return nil, fmt.Errorf("listing users: %w", err)
	}

	edges := make([]*model.UserEdge, len(users))
	for i, u := range users {
		edges[i] = &model.UserEdge{
			Node:   u,
			Cursor: encodeCursor(u.ID),
		}
	}

	return &model.UserConnection{
		Edges:      edges,
		PageInfo:   pageInfo,
		TotalCount: total,
	}, nil
}

// graph/mutation.resolvers.go
func (r *mutationResolver) CreateUser(
	ctx context.Context,
	input model.CreateUserInput,
) (*model.CreateUserPayload, error) {
	var userErrors []*model.UserError

	if !isValidEmail(input.Email) {
		userErrors = append(userErrors, &model.UserError{
			Field:   ptr("email"),
			Message: "Invalid email address",
			Code:    "INVALID_EMAIL",
		})
	}
	if len(input.Password) < 8 {
		userErrors = append(userErrors, &model.UserError{
			Field:   ptr("password"),
			Message: "Password must be at least 8 characters",
			Code:    "PASSWORD_TOO_SHORT",
		})
	}
	if len(userErrors) > 0 {
		return &model.CreateUserPayload{Errors: userErrors}, nil
	}

	existing, _ := r.userRepo.GetByEmail(ctx, input.Email)
	if existing != nil {
		return &model.CreateUserPayload{
			Errors: []*model.UserError{{
				Field:   ptr("email"),
				Message: "Email already taken",
				Code:    "EMAIL_TAKEN",
			}},
		}, nil
	}

	hashedPw, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hashing password: %w", err)
	}

	user := &model.User{
		Email:    input.Email,
		Username: input.Username,
	}

	if err := r.userRepo.Create(ctx, user, string(hashedPw)); err != nil {
		return nil, fmt.Errorf("creating user: %w", err)
	}

	return &model.CreateUserPayload{
		User:   user,
		Errors: []*model.UserError{},
	}, nil
}
```

### 42D.1.1 The N+1 Problem and DataLoaders

The N+1 problem is the most important performance concern in GraphQL:

```graphql
# This query causes N+1:
query {
  posts(first: 10) {
    edges {
      node {
        title
        author {      # calls User resolver for EACH post = 10 DB queries!
          username
        }
      }
    }
  }
}
```

**Without DataLoader:** 10 posts → 10 separate `SELECT * FROM users WHERE id = ?` queries.
**With DataLoader:** 10 posts → 1 `SELECT * FROM users WHERE id IN (?, ?, ...)` query.

The mechanism is worth stating precisely, because "DataLoader batches queries" hides the interesting part. `Load` does not execute anything. It returns a *thunk*, a function you call later to get the result, and registers the key with the loader. gqlgen resolves sibling fields concurrently, so all ten `author` resolvers call `Load` at roughly the same moment. The loader waits a short window (`WithWait`, 2ms below) or until the batch is full (`WithBatchCapacity`), then issues one call with every key it collected. The batching therefore depends on the resolvers running concurrently and on the wait window being long enough to collect them. It also means a loader is a **per-request** object with a **per-request** cache, which is the point of the middleware below.

```go
// graph/dataloader/dataloader.go
package dataloader

import (
	"context"
	"time"

	"github.com/graph-gophers/dataloader/v7"
	"github.com/yourapp/graph/model"
	"github.com/yourapp/repo"
)

type Loaders struct {
	UserByID        *dataloader.Loader[string, *model.User]
	PostsByAuthorID *dataloader.Loader[string, []*model.Post]
}

func NewLoaders(userRepo repo.UserRepository, postRepo repo.PostRepository) *Loaders {
	return &Loaders{
		UserByID: dataloader.NewBatchedLoader(
			newUserByIDLoader(userRepo),
			dataloader.WithWait[string, *model.User](2*time.Millisecond),
			dataloader.WithBatchCapacity[string, *model.User](100),
		),
		PostsByAuthorID: dataloader.NewBatchedLoader(
			newPostsByAuthorIDLoader(postRepo),
			dataloader.WithWait[string, []*model.Post](2*time.Millisecond),
		),
	}
}

func newUserByIDLoader(repo repo.UserRepository) dataloader.BatchFunc[string, *model.User] {
	return func(ctx context.Context, keys []string) []*dataloader.Result[*model.User] {
		users, err := repo.GetByIDs(ctx, keys)

		results := make([]*dataloader.Result[*model.User], len(keys))

		if err != nil {
			for i := range keys {
				results[i] = &dataloader.Result[*model.User]{Error: err}
			}
			return results
		}

		userMap := make(map[string]*model.User, len(users))
		for _, u := range users {
			userMap[u.ID] = u
		}

		for i, key := range keys {
			if user, ok := userMap[key]; ok {
				results[i] = &dataloader.Result[*model.User]{Data: user}
			} else {
				results[i] = &dataloader.Result[*model.User]{Data: nil}
			}
		}
		return results
	}
}

// Middleware injects a FRESH set of loaders into every request.
//
// This is the single most important line in the file, and it is the one
// most often written wrong. The tempting version takes a *Loaders built
// once at startup and injects that same pointer on every request:
//
//	func Middleware(loaders *Loaders) ...   // WRONG
//
// It compiles, it batches correctly, and every test passes. It is also
// broken in two ways, because a DataLoader is a cache with a lifetime, and
// that version gives it the lifetime of your process:
//
//  1. Stale reads forever. A loader caches per key with no expiry. Load
//     user u1 at 09:00, and every request for the rest of the deployment
//     serves that snapshot. The user updates their name and the API keeps
//     returning the old one until you redeploy. Demonstrated: with a shared
//     loader, a second request after a database write still reads the
//     original value and never issues a query.
//
//  2. Cross-request data leakage. If your batch function applies per-viewer
//     authorization, the first viewer's authorized result is cached under
//     that key and handed to the NEXT viewer who asks for it. That is a
//     tenant isolation failure, and it will not appear in any test that
//     uses one user.
//
// The loader's cache is meant to deduplicate within ONE request. Scope it
// to one request. Construct per request, discard at the end.
func Middleware(userRepo repo.UserRepository, postRepo repo.PostRepository) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Cheap: a loader is a struct plus a map. Allocating one per
			// request is nothing next to the database call it saves.
			loaders := NewLoaders(userRepo, postRepo)
			ctx := context.WithValue(r.Context(), loadersKey, loaders)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func For(ctx context.Context) *Loaders {
	return ctx.Value(loadersKey).(*Loaders)
}

type contextKey string

const loadersKey contextKey = "dataloaders"

// Usage in resolver - DataLoader batches all concurrent post.author resolutions
func (r *postResolver) Author(ctx context.Context, post *model.Post) (*model.User, error) {
	return dataloader.For(ctx).UserByID.Load(ctx, post.AuthorID)()
}
```

### 42D.1.2 GraphQL Subscriptions over WebSocket

Subscriptions allow the server to push data to connected clients over a persistent WebSocket connection. In gqlgen, a subscription resolver returns a channel that the server reads from and forwards to the client. The goroutine listens on an event bus and exits cleanly when the client disconnects or the context is canceled.

```go
// graph/subscription.resolvers.go
func (r *subscriptionResolver) UserCreated(ctx context.Context) (<-chan *model.User, error) {
	viewer, err := auth.ViewerFromContext(ctx)
	if err != nil || !viewer.IsAdmin {
		return nil, errors.New("unauthorized")
	}

	ch := make(chan *model.User, 10)
	sub := r.eventBus.Subscribe("user.created")

	go func() {
		defer close(ch)
		defer r.eventBus.Unsubscribe(sub)

		for {
			select {
			case <-ctx.Done():
				return
			case event, ok := <-sub.Events():
				if !ok {
					return
				}
				user, ok := event.Data.(*model.User)
				if !ok {
					continue
				}
				select {
				case ch <- user:
				case <-ctx.Done():
					return
				}
			}
		}
	}()

	return ch, nil
}

// WebSocket transport setup in main.go
//
// Use handler.New, NOT handler.NewDefaultServer.
//
// This is not a style preference. gqlgen marks NewDefaultServer as
// Deprecated with the note that it "is not suitable for production use...
// only suitable for use in examples", and there is a specific trap here.
// NewDefaultServer ALREADY calls AddTransport(transport.Websocket{...})
// internally, with no InitFunc and no Upgrader. gqlgen's getTransport picks
// the FIRST registered transport whose Supports(r) returns true, so if you
// call NewDefaultServer and then AddTransport a second, authenticated
// Websocket, the built-in unauthenticated one is still first in the slice
// and still wins. Your InitFunc is dead code. It compiles, it reads
// correctly in review, and anonymous clients open subscriptions freely.
//
// Build the server explicitly so that every transport is one you chose.
srv := handler.New(generated.NewExecutableSchema(generated.Config{
	Resolvers: &graph.Resolver{},
}))

srv.AddTransport(transport.Options{})
srv.AddTransport(transport.GET{})
srv.AddTransport(transport.POST{})

srv.AddTransport(transport.Websocket{
	KeepAlivePingInterval: 10 * time.Second,

	// Bound the handshake. Without this, a client that opens a socket and
	// never sends connection_init holds a goroutine and a connection open
	// indefinitely, which is a free slow-loris against your subscription
	// fleet.
	InitTimeout: 10 * time.Second,

	InitFunc: func(ctx context.Context, initPayload transport.InitPayload) (context.Context, *transport.InitPayload, error) {
		// A browser cannot set an Authorization header on a WebSocket, so
		// auth arrives in the connection_init payload instead. This is the
		// ONLY place to authenticate a subscription: there is no per-message
		// auth hook, and the connection outlives the handshake by hours.
		token, _ := initPayload["authToken"].(string)
		if token == "" {
			return ctx, nil, errors.New("missing auth token")
		}
		viewer, err := auth.ValidateToken(token)
		if err != nil {
			// Return a bare error. Do not wrap err: token validation
			// failures routinely quote the offending token, and this string
			// goes straight to the client.
			return ctx, nil, errors.New("invalid token")
		}
		return auth.WithViewer(ctx, viewer), &initPayload, nil
	},

	// Origin checking. Current gqlgen builds on coder/websocket rather than
	// gorilla, so there is no Upgrader field with a CheckOrigin callback:
	// you configure Implementation with AcceptOptions. Older tutorials show
	// `Upgrader: websocket.Upgrader{...}`, which no longer compiles.
	//
	// This is mandatory, not optional. WebSockets are NOT subject to the
	// same-origin policy and no CORS preflight guards them, so a
	// cookie-authenticated socket with unchecked origins is Cross-Site
	// WebSocket Hijacking: any page on the internet opens a socket as your
	// logged-in user. coder/websocket defaults to same-origin-only, which
	// is a safe default. Never reach for InsecureSkipVerify to "fix" a
	// local development problem, because it ships.
	Implementation: transport.CoderWebsocketImplementation{
		AcceptOptions: coderws.AcceptOptions{
			OriginPatterns: []string{"app.example.com"},
		},
	},
})

// Caches and extensions NewDefaultServer would have configured for you.
// Doing it explicitly is the point: each one becomes a decision you made.
srv.SetQueryCache(lru.New[*ast.QueryDocument](1000))
srv.Use(extension.Introspection{}) // consider disabling in production
```

**Which WebSocket subprotocol?** There are two, they are incompatible, and the naming is actively confusing:

- `graphql-ws` is the **subprotocol name of the old, deprecated** `subscriptions-transport-ws` library, which has been unmaintained for years.
- `graphql-transport-ws` is the subprotocol of the **modern, maintained** library, which is confusingly *named* `graphql-ws`.

So the library called `graphql-ws` speaks `graphql-transport-ws`, and the subprotocol called `graphql-ws` belongs to the library that is *not* called that. gqlgen supports both and negotiates on the handshake. The detail that matters: when a client sends **no** subprotocol, gqlgen falls back to the **deprecated** `graphql-ws` behaviour for backward compatibility. New clients should explicitly request `graphql-transport-ws`, which has real heartbeats (`ping`/`pong`) rather than the old protocol's keep-alive, and defined close codes you can actually act on.

### 42D.1.3 Query Complexity Analysis and Depth Limiting

Without limits, a single GraphQL query can bring down your server:

```graphql
# Malicious deeply nested query
query {
  users {
    friends {
      friends {
        friends {   # Could return millions of users
          email
        }
      }
    }
  }
}
```

Note what the attack costs the attacker: one small request. Depth and complexity limits are the only thing standing between "clients compose their own queries" and "any client can compose a query that joins your database to itself four times."

```go
// Complexity and depth limiting
srv := handler.New(generated.NewExecutableSchema(cfg))

// Simplest case: one limit for everyone.
srv.Use(extension.FixedComplexityLimit(100))

// Context-aware limit. Note the shape: ComplexityLimit is a STRUCT with a
// Func field, used as &extension.ComplexityLimit{Func: ...}. It is not a
// function you call, and Func receives a *graphql.OperationContext, not a
// complexity.Limits. (Use either this or FixedComplexityLimit, not both:
// FixedComplexityLimit is just this struct with a constant Func, and
// registering two extensions with the same name will fail validation.)
srv.Use(&extension.ComplexityLimit{
	Func: func(ctx context.Context, opCtx *graphql.OperationContext) int {
		if viewer, _ := auth.ViewerFromContext(ctx); viewer != nil && viewer.IsAdmin {
			return 1000
		}
		return 100
	},
})

// Complexity calculator: lists multiply by the number of rows they can
// return. This is the part people skip, and skipping it makes the limit
// meaningless, because without it every field costs 1 and a query that
// returns 10,000 nested rows scores the same as one returning 1.
cfg.Complexity.Query.Users = func(childComplexity int, filter *model.UserFilter, pagination *model.PaginationInput) int {
	// Default to the maximum you would ever serve, NOT to a small number.
	// If a client omits `first`, an optimistic default of 10 lets them
	// have the page-size cap for free while being scored as if they asked
	// for ten rows.
	limit := maxPageSize
	if pagination != nil && pagination.First != nil {
		limit = *pagination.First
	}
	return childComplexity * limit
}

// Introspection: extension.Introspection is an EMPTY struct. There is no
// Enabled field and no per-request toggle. You enable it by registering the
// extension and disable it by not registering it, so the decision is made
// once at startup.
if os.Getenv("ENV") == "development" {
	srv.Use(extension.Introspection{})
}
```

Two warnings about introspection, because "disable introspection in production" is repeated everywhere as though it were a security control. It is not one. Turning it off is defence in depth: it slows down casual scanning and it breaks your own tooling (GraphiQL, schema diffing in CI, client codegen). It does **not** hide your schema. Field names are guessable, error messages leak them through "did you mean" suggestions, and any published client bundle contains the queries. If a field is unsafe to expose, remove it from the schema or authorize it properly. Do not rely on nobody being able to list it.

### 42D.1.4 GraphQL Security: Persisted Queries

Two different things share the name "persisted queries" and only one of them is a security control. Confusing them is the single most consequential mistake in this section, because it leads teams to believe they have an allowlist when they have a cache.

**Automatic Persisted Queries (APQ)** is a *bandwidth* optimization. The client sends a SHA-256 hash instead of the full query text. On a cache miss the server replies `PersistedQueryNotFound`, the client resends the full query along with the hash, and **the server stores whatever the client sent**. gqlgen implements this as `extension.AutomaticPersistedQuery`, and its internals are exactly that: `a.Cache.Add(ctx, extension.Sha256, rawParams.Query)`. The only validation is that the hash matches the text, which stops cache poisoning but stops nothing else. An attacker simply registers their expensive query and executes it. **APQ provides no protection against malicious queries whatsoever.**

Note that `handler.NewDefaultServer` enables APQ by default. So a team that reads "we use persisted queries" off their own server setup, and concludes that arbitrary queries are rejected, is precisely wrong.

**Trusted documents** (also called a persisted query allowlist, or safelisting) *is* the security control. The allowlist is populated **only** by the deployment pipeline, extracted from your client bundles at build time. The server rejects any hash it does not recognise and never learns new ones at runtime. The set of executable queries becomes a build artifact, reviewed and versioned alongside the schema.

The structural difference is one method:

```go
// TrustedDocuments is an allowlist, NOT a cache.
//
// It satisfies graphql.Cache[string], so it plugs into gqlgen's APQ
// extension. That is exactly the trap: the interface is identical, and the
// security property lives entirely in whether Add() accepts runtime input.
type TrustedDocuments struct {
	allowed map[string]string // hash -> query text, loaded at startup
}

// LoadTrustedDocuments reads the manifest your build pipeline produced by
// extracting every query from the client bundles. No mutex: the map is
// written once before serving and is read-only thereafter, which is both
// faster and a structural guarantee that nothing can add to it later.
func LoadTrustedDocuments(manifest map[string]string) *TrustedDocuments {
	return &TrustedDocuments{allowed: manifest}
}

func (c *TrustedDocuments) Get(ctx context.Context, hash string) (string, bool) {
	q, ok := c.allowed[hash]
	return q, ok
}

// Add is deliberately a NO-OP. This is the entire security control.
//
// gqlgen's APQ calls Add with the client's own query text on a cache miss.
// Honouring that call turns the allowlist into a self-service registration
// endpoint for attackers. By dropping the write, an unknown hash stays
// unknown, Get keeps returning false, and the client receives
// PersistedQueryNotFound instead of executing whatever it liked.
func (c *TrustedDocuments) Add(ctx context.Context, hash string, query string) {
	// Intentionally empty. Log-and-drop if you want visibility into clients
	// sending unregistered queries, which usually means a stale deploy.
}

// Rate limiting by operation type.
//
// WARNING: read the comment below before copying this. The string-prefix
// check is shown because it is what teams reach for first, and it is
// trivially bypassable.
func rateLimitMiddleware(mutationLimiter, queryLimiter *rate.Limiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(bytes.NewBuffer(body))

			var req struct {
				Query string `json:"query"`
			}
			json.Unmarshal(body, &req)

			// Deciding "is this a mutation?" by string prefix does not work.
			// Every one of these is a mutation that this check misses:
			//
			//   "# comment\nmutation { ... }"     leading comment
			//   "fragment F on T {...} mutation"  fragment defined first
			//   "\ufeffmutation { ... }"          byte-order mark
			//   "query Q {...} mutation M {...}"  with operationName=M
			//
			// The last one is the killer: TrimSpace sees "query", so the
			// document takes the generous query limit while gqlgen executes
			// the mutation named by operationName. You cannot answer a
			// question about a parsed language by pattern-matching its text.
			// Parse it, or hook gqlgen's OperationContext where the
			// operation type is already known:
			//
			//   graphql.GetOperationContext(ctx).Operation.Operation == ast.Mutation
			//
			// which is the same information, correct by construction, and
			// available to a HandlerExtension after parsing.
			limiter := queryLimiter
			if strings.HasPrefix(strings.TrimSpace(req.Query), "mutation") {
				limiter = mutationLimiter
			}

			if !limiter.Allow() {
				http.Error(w, `{"errors":[{"message":"rate limit exceeded"}]}`, http.StatusTooManyRequests)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
```

### Junior -> FAANG: GraphQL Fundamentals That Interviewers Test

Before your first job touching GraphQL, there are four concepts you must be able to explain without consulting documentation.

**Schema-first design vs code-first design.** gqlgen is schema-first: you write the SDL file, run `go generate`, and the tool produces Go interfaces. Code-first tools (like graphql-go with reflection binding) let you define the schema in Go structs and derive the SDL from them. Schema-first wins for team collaboration because the SDL is the contract that frontend, mobile, and backend engineers all read. When you generate the schema from Go code, non-Go engineers must read Go to understand the API surface.

**Why the N+1 problem exists in GraphQL.** The GraphQL execution engine resolves fields independently. When you query 10 posts and each post has an author field, the engine calls the author resolver 10 times, once per post. Each call issues a database query. Without DataLoader, you get 10 individual `SELECT * FROM users WHERE id = ?` queries instead of one `SELECT * FROM users WHERE id IN (...)`. DataLoader solves this by batching all resolver calls that arrive within a short time window (typically 1-2 milliseconds) into a single batch function call. The key insight is that the batch window exists because all 10 resolver calls happen concurrently within a single request's execution.

**Why subscriptions need careful authentication.** HTTP request authentication happens in middleware via the Authorization header. WebSocket connections upgrade from HTTP but then become a persistent TCP connection. Once the upgrade completes, there is no HTTP header mechanism for re-authenticating. The `InitFunc` in the WebSocket transport setup receives the initial connection payload (a JSON object the client sends immediately after connecting) where the auth token must be included. If you skip this, any unauthenticated WebSocket client can subscribe to events.

**Complexity analysis is not optional in production.** The deeply nested query example in this section is not hypothetical. GraphQL's query flexibility is also its primary denial-of-service surface. A query that traverses `users -> friends -> friends -> friends` can return O(n^3) rows from the database for a single HTTP request. Every production GraphQL endpoint must have depth limits and complexity scoring configured before it is exposed to external traffic.

**Interview entry point:** "Explain the N+1 problem and how DataLoader solves it" is a standard mid-level GraphQL interview question. The full answer includes: why the problem occurs (independent field resolution), what DataLoader does (batches keys within a tick), the timing mechanism (batch window of 1-2ms), and the trade-off (adds per-request latency equal to the batch window, which is acceptable in exchange for eliminating O(n) database queries).

### Senior @ FAANG: GraphQL at Scale: Federation, Persisted Queries, and Schema Governance

**Apollo Federation v2 as a distributed schema contract.** The federation architecture separates schema ownership from schema aggregation. Each service declares its owned types with `@key` directives and publishes a subgraph schema to a schema registry (Apollo Studio, Cosmo, or self-hosted). The gateway composition process runs on every schema change and validates that the merged supergraph is coherent: no conflicting field definitions, no missing `@external` references, no unresolvable entity keys. This composition check is the equivalent of a type-safe build step for your distributed API surface. A schema change that breaks composition fails before it reaches any environment.

**Persisted queries as a security and performance primitive.** The persisted query allowlist described in this section has two distinct values that are often conflated. The security value: arbitrary query injection is impossible if the server only executes pre-registered hashes. An attacker cannot send a malicious deeply nested query because the server will reject any hash it does not recognize. The performance value: clients send a 32-byte SHA-256 hash instead of a multi-kilobyte query string, reducing request payload size and enabling CDN caching of GET-method persisted query requests (since the hash is deterministic and cacheable). At FAANG scale, the allowlist is populated by the CI/CD pipeline from the client's compiled query registry, making it a build artifact with the same review process as code changes.

**DataLoader cache invalidation and per-request scoping.** A DataLoader instance must be scoped to a single HTTP request, not to the process lifetime. If DataLoaders are singletons, user A's cached data is served to user B's request, which is both a correctness bug and a security vulnerability. The middleware pattern in this section (injecting new Loaders instances into each request's context) is the correct approach. At FAANG scale, the DataLoader cache is an optimization for the single-request execution graph, not a cross-request cache. For cross-request caching of expensive lookups, use a dedicated cache layer (Redis, Memcached) with explicit TTLs and cache invalidation hooks tied to write operations.

**Subscription connection management at scale.** WebSocket subscriptions create long-lived goroutines. A server handling 10,000 concurrent subscribers has 10,000 goroutines listening on event bus channels. The failure modes are: goroutine leak when the event bus does not close the channel on client disconnect, memory pressure from buffered channels accumulating events for slow consumers, and thundering herd when a high-fanout event triggers 10,000 simultaneous channel writes. Production subscription infrastructure uses a pub/sub broker (Redis Pub/Sub, NATS, or a message queue) as the event bus rather than in-process channels, so the goroutine per subscription only bridges the broker subscription to the WebSocket write, keeping memory usage predictable and enabling horizontal scaling of subscription servers.

**Complexity scoring as a rate limiting primitive.** Fixed complexity limits (e.g., 100 points per query) do not account for the difference between a simple query and a query that returns a large list. The complexity calculator in this section multiplies list field complexity by the requested page size, which is correct but incomplete. A comprehensive complexity model accounts for: field weight (some fields are computed, not stored, and are more expensive to resolve), nesting depth multipliers (each level of nesting multiplies the rows returned by parent levels), and real-time complexity (subscriptions have ongoing cost, not just per-query cost). At FAANG scale, complexity scoring is combined with per-user rate limiting (a verified user gets a higher limit than an anonymous user) and per-operation-type limits (mutations are limited more aggressively than queries because they have side effects that cannot be trivially retried).

**Bar-raiser interview signal.** A candidate explaining GraphQL security who only mentions depth limits and complexity analysis is giving a correct but incomplete answer. A complete senior answer also addresses: persisted query allowlisting (prevents arbitrary query injection), field-level authorization (per-resolver auth checks prevent horizontal privilege escalation where a low-privilege user queries a high-privilege user's data through a shared object), and introspection disablement in production (introspection reveals the full schema to attackers and should be disabled or restricted to authenticated internal users). The candidate who can articulate all four layers and explain why each is necessary for a different threat category is demonstrating L6-level security thinking.

---
