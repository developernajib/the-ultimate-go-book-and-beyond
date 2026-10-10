## 56.4 Resolver Implementation

### Resolver Structure

gqlgen maps each GraphQL type's fields to methods on a resolver struct, giving the developer control over which fields are computed lazily versus eagerly and where N+1 query risk lies. The resolver struct holds service-layer dependencies injected at startup, keeping resolvers thin adapters that delegate to the domain service rather than embedding data access logic. The structure below shows how to organize resolver files per type and inject shared dependencies via a root resolver factory.

```go
// graph/resolver.go
package graph

import (
    "graphql-api/internal/auth"
    "graphql-api/internal/dataloader"
    "graphql-api/internal/service"
)

// Resolver is the root resolver
type Resolver struct {
    UserService    service.UserService
    ProductService service.ProductService
    OrderService   service.OrderService
    ReviewService  service.ReviewService
    AuthService    auth.Service
    Loaders        *dataloader.Loaders
}

// NewResolver creates a new resolver with all dependencies
func NewResolver(
    userSvc service.UserService,
    productSvc service.ProductService,
    orderSvc service.OrderService,
    reviewSvc service.ReviewService,
    authSvc auth.Service,
) *Resolver {
    return &Resolver{
        UserService:    userSvc,
        ProductService: productSvc,
        OrderService:   orderSvc,
        ReviewService:  reviewSvc,
        AuthService:    authSvc,
    }
}
```

### Query Resolvers

Query resolvers handle read-only operations, where the primary concerns are efficient data fetching, authorization checks, and translating domain types into GraphQL response types. Returning errors as GraphQL errors (using `gqlerror.Errorf`) rather than Go errors ensures they are serialized in the GraphQL error envelope rather than as a 500 response. The resolvers below demonstrate pagination with cursor encoding, dataloader invocation for related types, and permission checks using the context-injected auth principal.

```go
// graph/schema.resolvers.go
package graph

import (
    "context"
    "encoding/base64"
    "fmt"

    "graphql-api/graph/model"
    "graphql-api/internal/auth"
)

// Query resolvers

func (r *queryResolver) Me(ctx context.Context) (*model.User, error) {
    user, err := auth.UserFromContext(ctx)
    if err != nil {
        return nil, nil // Return nil, not error, for unauthenticated
    }
    return user, nil
}

func (r *queryResolver) User(ctx context.Context, id string) (*model.User, error) {
    return r.UserService.GetByID(ctx, id)
}

func (r *queryResolver) Users(
    ctx context.Context,
    first *int,
    after *string,
    filter *model.UserFilter,
) (*model.UserConnection, error) {
    limit := 20
    if first != nil && *first > 0 && *first <= 100 {
        limit = *first
    }

    var cursor string
    if after != nil {
        cursor = *after
    }

    users, hasMore, err := r.UserService.List(ctx, limit+1, cursor, filter)
    if err != nil {
        return nil, err
    }

    // Build connection
    edges := make([]*model.UserEdge, 0, len(users))
    for i, user := range users {
        if i >= limit {
            break
        }
        edges = append(edges, &model.UserEdge{
            Node:   user,
            Cursor: encodeCursor(user.ID),
        })
    }

    var endCursor *string
    if len(edges) > 0 {
        endCursor = &edges[len(edges)-1].Cursor
    }

    return &model.UserConnection{
        Edges: edges,
        PageInfo: &model.PageInfo{
            HasNextPage:     len(users) > limit,
            HasPreviousPage: cursor != "",
            EndCursor:       endCursor,
        },
    }, nil
}

func (r *queryResolver) Product(ctx context.Context, id string) (*model.Product, error) {
    return r.ProductService.GetByID(ctx, id)
}

func (r *queryResolver) Products(
    ctx context.Context,
    first *int,
    after *string,
    filter *model.ProductFilter,
    sortBy *string,
    sortOrder *model.SortOrder,
) (*model.ProductConnection, error) {
    limit := 20
    if first != nil && *first > 0 && *first <= 100 {
        limit = *first
    }

    opts := service.ProductListOptions{
        Limit:     limit + 1,
        Cursor:    derefString(after),
        Filter:    filter,
        SortBy:    derefString(sortBy),
        SortOrder: sortOrder,
    }

    products, err := r.ProductService.List(ctx, opts)
    if err != nil {
        return nil, err
    }

    return buildProductConnection(products, limit, after != nil), nil
}

func (r *queryResolver) Search(
    ctx context.Context,
    query string,
    limit *int,
) (*model.SearchResult, error) {
    l := 10
    if limit != nil && *limit > 0 && *limit <= 50 {
        l = *limit
    }

    products, _ := r.ProductService.Search(ctx, query, l)
    categories, _ := r.CategoryService.Search(ctx, query, l)
    users, _ := r.UserService.Search(ctx, query, l)

    return &model.SearchResult{
        Products:   products,
        Categories: categories,
        Users:      users,
    }, nil
}

// Mutation resolvers

func (r *mutationResolver) Login(
    ctx context.Context,
    input model.LoginInput,
) (*model.AuthPayload, error) {
    return r.AuthService.Login(ctx, input.Email, input.Password)
}

func (r *mutationResolver) CreateUser(
    ctx context.Context,
    input model.CreateUserInput,
) (*model.User, error) {
    // Check if requester is admin
    currentUser, err := auth.UserFromContext(ctx)
    if err != nil {
        return nil, fmt.Errorf("unauthorized")
    }
    if currentUser.Role != model.UserRoleAdmin {
        return nil, fmt.Errorf("only admins can create users")
    }

    return r.UserService.Create(ctx, input)
}

func (r *mutationResolver) CreateOrder(
    ctx context.Context,
    input model.CreateOrderInput,
) (*model.Order, error) {
    user, err := auth.UserFromContext(ctx)
    if err != nil {
        return nil, fmt.Errorf("unauthorized")
    }

    return r.OrderService.Create(ctx, user.ID, input)
}

func (r *mutationResolver) UpdateOrderStatus(
    ctx context.Context,
    id string,
    status model.OrderStatus,
) (*model.Order, error) {
    // Check permissions
    currentUser, err := auth.UserFromContext(ctx)
    if err != nil {
        return nil, fmt.Errorf("unauthorized")
    }
    if currentUser.Role != model.UserRoleAdmin {
        return nil, fmt.Errorf("only admins can update order status")
    }

    return r.OrderService.UpdateStatus(ctx, id, status)
}

// Field resolvers for nested types

func (r *userResolver) Orders(
    ctx context.Context,
    obj *model.User,
    first *int,
    after *string,
) (*model.OrderConnection, error) {
    // Use dataloader to batch order fetching
    return r.Loaders.OrdersByUserID.Load(ctx, obj.ID)
}

func (r *productResolver) Category(
    ctx context.Context,
    obj *model.Product,
) (*model.Category, error) {
    // Use dataloader to avoid N+1
    return r.Loaders.CategoryByID.Load(ctx, obj.CategoryID)
}

func (r *productResolver) Reviews(
    ctx context.Context,
    obj *model.Product,
    first *int,
    after *string,
) (*model.ReviewConnection, error) {
    return r.Loaders.ReviewsByProductID.Load(ctx, obj.ID)
}

func (r *productResolver) AverageRating(
    ctx context.Context,
    obj *model.Product,
) (*float64, error) {
    return r.Loaders.AverageRatingByProductID.Load(ctx, obj.ID)
}

func (r *orderResolver) User(
    ctx context.Context,
    obj *model.Order,
) (*model.User, error) {
    return r.Loaders.UserByID.Load(ctx, obj.UserID)
}

func (r *orderResolver) Items(
    ctx context.Context,
    obj *model.Order,
) ([]*model.OrderItem, error) {
    return r.Loaders.OrderItemsByOrderID.Load(ctx, obj.ID)
}

func (r *orderItemResolver) Product(
    ctx context.Context,
    obj *model.OrderItem,
) (*model.Product, error) {
    return r.Loaders.ProductByID.Load(ctx, obj.ProductID)
}

// Helper functions

func encodeCursor(id string) string {
    return base64.StdEncoding.EncodeToString([]byte(id))
}

func decodeCursor(cursor string) (string, error) {
    bytes, err := base64.StdEncoding.DecodeString(cursor)
    if err != nil {
        return "", err
    }
    return string(bytes), nil
}

func derefString(s *string) string {
    if s == nil {
        return ""
    }
    return *s
}

func buildProductConnection(
    products []*model.Product,
    limit int,
    hasPrevious bool,
) *model.ProductConnection {
    edges := make([]*model.ProductEdge, 0, len(products))
    for i, p := range products {
        if i >= limit {
            break
        }
        edges = append(edges, &model.ProductEdge{
            Node:   p,
            Cursor: encodeCursor(p.ID),
        })
    }

    var endCursor *string
    if len(edges) > 0 {
        endCursor = &edges[len(edges)-1].Cursor
    }

    return &model.ProductConnection{
        Edges: edges,
        PageInfo: &model.PageInfo{
            HasNextPage:     len(products) > limit,
            HasPreviousPage: hasPrevious,
            EndCursor:       endCursor,
        },
    }
}
```

### Junior -> FAANG: Writing Resolvers That Pass Code Review

The resolver struct is a dependency injection container for your first job. Resist the temptation to add convenience methods directly on the resolver that call the database or perform business logic. The resolver should hold only service interfaces, and all logic lives in those services. This separation is what makes resolvers testable with mocks.

The pagination pattern in this file (fetch `limit+1` items, check if the extra item exists to determine `hasNextPage`) is the canonical cursor pagination implementation. Understand why it works: instead of making a separate `COUNT(*)` query (which is expensive and often inconsistent under concurrent writes), you over-fetch by one and use the presence of the extra item as the `hasNextPage` signal.

Error handling from resolvers follows a specific convention: return `nil, err` for errors that abort the entire operation, and return a partial result with errors added to the GraphQL error array for fields that partially fail. Do not return Go errors directly. Map them through an error presenter that strips internal details and attaches error codes to the `extensions` field.

For FAANG interviews: practice explaining the connection/edge/pageInfo pattern from memory. Interviewers who work on GraphQL systems consider this table stakes. Being able to explain what `endCursor` is used for (the client passes it as the `after` argument in the next request), why cursors are opaque strings rather than integer offsets (stability under insertions and deletions), and how `hasPreviousPage` is computed (track whether the client passed an `after` argument) demonstrates genuine familiarity.

### Senior @ FAANG: Resolver Architecture at Scale

At staff level, resolver design decisions have organizational implications beyond correctness and performance.

**The thin-resolver principle as an enforced convention.** Resolvers that contain business logic become a maintenance trap: the same logic gets duplicated across the GraphQL resolver, the REST handler, and the gRPC handler when a service exposes multiple interfaces. The organizational solution is an architecture decision record that mandates resolvers delegate to service interfaces, and a code review rubric that flags resolver methods containing conditional logic beyond authorization checks and argument validation as requiring justification.

**Field resolver vs query resolver placement.** gqlgen generates separate resolver interfaces for each type (a `UserResolver` interface, a `ProductResolver` interface, and so on). The field resolvers on these interfaces (for example, `(r *userResolver) Orders(...)`) are where N+1 risk lives. A useful heuristic: every field resolver that returns a list or a related object is a potential dataloader candidate. At code review time, any field resolver that calls a repository directly (rather than going through a dataloader) needs explicit justification for why batching is not needed.

**Pagination cursor design decisions.** The example encodes the item ID as the cursor using base64. This is simple but has a limitation: it only works for ID-based ordering. If the client wants to paginate by `createdAt` or `price`, the cursor must encode the sort key value, not just the ID, because the ID alone cannot determine the position in a non-ID-ordered result set. The production-grade pattern is to encode a struct containing all sort key values plus the ID as a tiebreaker, then base64-encode its JSON serialization. The cursor is opaque to the client but carries enough server-side context to reconstruct the `WHERE` clause for the next page.

**Resolver tracing for production observability.** gqlgen's `extension.Tracer` interface lets you intercept resolver start and end events. At staff level, you configure a tracer that records per-resolver latency as OpenTelemetry spans and emits the parent operation name as a span attribute. This gives you a flame graph per GraphQL operation showing exactly which resolver is responsible for tail latency, rather than a single operation-level latency metric that aggregates all resolver time opaquely.

**The `totalCount` problem.** Connection types in this schema include `totalCount` in `PageInfo`. Computing `totalCount` requires a `COUNT(*)` query that is separate from the data query. If the client never requests `totalCount`, the field resolver for it is never called (because gqlgen only invokes field resolvers for requested fields). However, if it is requested alongside a paginated list, you now execute three queries: the count, the list, and the dataloader batches for related fields. For large tables, the `COUNT(*)` can be slower than the data query. The production alternative is estimated counts (using PostgreSQL's `pg_class.reltuples` for approximate counts), cached counts (maintained via triggers or periodic jobs), or simply removing `totalCount` from the schema if clients do not actually need it.

---
