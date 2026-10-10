## Section 3: GraphQL API

GraphQL lets clients specify exactly the fields they need in a single request, solving both over-fetching and under-fetching that REST multi-endpoint designs suffer from. The Go implementation below defines a schema, resolvers that propagate `context.Context` for deadline and auth propagation, and an HTTP handler that parses the query document and dispatches to the correct resolver.

```go
package graphql

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/graph-gophers/graphql-go"
	"github.com/graph-gophers/graphql-go/relay"
)

const schema = `
	schema {
		query: Query
		mutation: Mutation
		subscription: Subscription
	}

	type Query {
		order(id: ID!): Order
		orders(customerId: ID!, page: Int, pageSize: Int): OrderPage
		product(id: ID!): Product
	}

	type Mutation {
		createOrder(input: CreateOrderInput!): CreateOrderPayload!
		cancelOrder(id: ID!): CancelOrderPayload!
	}

	type Subscription {
		orderUpdated(orderId: ID!): OrderEvent!
	}

	type Order {
		id: ID!
		customerId: ID!
		status: String!
		totalCents: Int!
		items: [OrderItem!]!
		createdAt: String!
	}

	type OrderItem {
		productId: ID!
		quantity: Int!
		priceCents: Int!
		product: Product
	}

	type Product {
		id: ID!
		name: String!
		priceCents: Int!
		inStock: Boolean!
	}

	type OrderPage {
		orders: [Order!]!
		total: Int!
		page: Int!
	}

	input CreateOrderInput {
		customerId: ID!
		items: [OrderItemInput!]!
	}

	input OrderItemInput {
		productId: ID!
		quantity: Int!
	}

	type CreateOrderPayload {
		order: Order
		errors: [String!]
	}

	type CancelOrderPayload {
		success: Boolean!
		error: String
	}

	type OrderEvent {
		orderId: ID!
		type: String!
		newStatus: String!
	}
`

// RootResolver implements all GraphQL resolvers
type RootResolver struct {
	orders    OrderService
	products  ProductService
	loader    *ProductLoader
}

type OrderService interface {
	FindByID(ctx context.Context, id string) (*Order, error)
	FindByCustomer(ctx context.Context, customerID string, page, pageSize int) ([]*Order, int, error)
	Create(ctx context.Context, customerID string, items []ItemInput) (*Order, error)
	Cancel(ctx context.Context, id string) error
}

type ProductService interface {
	FindByID(ctx context.Context, id string) (*Product, error)
	FindByIDs(ctx context.Context, ids []string) ([]*Product, error)
}

type Order struct {
	ID         string
	CustomerID string
	Status     string
	TotalCents int
	Items      []OrderItem
	CreatedAt  string
}

type OrderItem struct {
	ProductID  string
	Quantity   int
	PriceCents int
}

type Product struct {
	ID         string
	Name       string
	PriceCents int
	InStock    bool
}

type ItemInput struct {
	ProductID string
	Quantity  int
}

func NewRootResolver(orders OrderService, products ProductService) *RootResolver {
	return &RootResolver{
		orders:   orders,
		products: products,
		loader:   NewProductLoader(products),
	}
}

// Query resolvers
func (r *RootResolver) Order(ctx context.Context, args struct{ ID graphql.ID }) (*OrderResolver, error) {
	order, err := r.orders.FindByID(ctx, string(args.ID))
	if err != nil {
		return nil, err
	}
	return &OrderResolver{order: order, loader: r.loader}, nil
}

func (r *RootResolver) Orders(ctx context.Context, args struct {
	CustomerID graphql.ID
	Page       *int32
	PageSize   *int32
}) (*OrderPageResolver, error) {
	page := 1
	pageSize := 20
	if args.Page != nil {
		page = int(*args.Page)
	}
	if args.PageSize != nil {
		pageSize = int(*args.PageSize)
	}

	orders, total, err := r.orders.FindByCustomer(ctx, string(args.CustomerID), page, pageSize)
	if err != nil {
		return nil, err
	}

	resolvers := make([]*OrderResolver, len(orders))
	for i, o := range orders {
		resolvers[i] = &OrderResolver{order: o, loader: r.loader}
	}

	return &OrderPageResolver{orders: resolvers, total: total, page: page}, nil
}

// Mutation resolvers
func (r *RootResolver) CreateOrder(ctx context.Context, args struct {
	Input struct {
		CustomerID graphql.ID
		Items      []struct {
			ProductID graphql.ID
			Quantity  int32
		}
	}
}) (*CreateOrderPayloadResolver, error) {
	items := make([]ItemInput, len(args.Input.Items))
	for i, item := range args.Input.Items {
		items[i] = ItemInput{
			ProductID: string(item.ProductID),
			Quantity:  int(item.Quantity),
		}
	}

	order, err := r.orders.Create(ctx, string(args.Input.CustomerID), items)
	if err != nil {
		errors := []string{err.Error()}
		return &CreateOrderPayloadResolver{errors: errors}, nil
	}

	return &CreateOrderPayloadResolver{
		order: &OrderResolver{order: order, loader: r.loader},
	}, nil
}

// ─── Type Resolvers ───

type OrderResolver struct {
	order  *Order
	loader *ProductLoader
}

func (r *OrderResolver) ID() graphql.ID      { return graphql.ID(r.order.ID) }
func (r *OrderResolver) CustomerID() graphql.ID { return graphql.ID(r.order.CustomerID) }
func (r *OrderResolver) Status() string      { return r.order.Status }
func (r *OrderResolver) TotalCents() int32   { return int32(r.order.TotalCents) }
func (r *OrderResolver) CreatedAt() string   { return r.order.CreatedAt }

func (r *OrderResolver) Items() []*OrderItemResolver {
	resolvers := make([]*OrderItemResolver, len(r.order.Items))
	for i, item := range r.order.Items {
		resolvers[i] = &OrderItemResolver{item: item, loader: r.loader}
	}
	return resolvers
}

type OrderItemResolver struct {
	item   OrderItem
	loader *ProductLoader
}

func (r *OrderItemResolver) ProductID() graphql.ID  { return graphql.ID(r.item.ProductID) }
func (r *OrderItemResolver) Quantity() int32         { return int32(r.item.Quantity) }
func (r *OrderItemResolver) PriceCents() int32       { return int32(r.item.PriceCents) }

// Product() uses the dataloader to batch-load products
func (r *OrderItemResolver) Product(ctx context.Context) (*ProductResolver, error) {
	product, err := r.loader.Load(ctx, r.item.ProductID)
	if err != nil {
		return nil, err
	}
	return &ProductResolver{product: product}, nil
}

type ProductResolver struct{ product *Product }

func (r *ProductResolver) ID() graphql.ID    { return graphql.ID(r.product.ID) }
func (r *ProductResolver) Name() string       { return r.product.Name }
func (r *ProductResolver) PriceCents() int32  { return int32(r.product.PriceCents) }
func (r *ProductResolver) InStock() bool      { return r.product.InStock }

type OrderPageResolver struct {
	orders []*OrderResolver
	total  int
	page   int
}

func (r *OrderPageResolver) Orders() []*OrderResolver { return r.orders }
func (r *OrderPageResolver) Total() int32             { return int32(r.total) }
func (r *OrderPageResolver) Page() int32              { return int32(r.page) }

type CreateOrderPayloadResolver struct {
	order  *OrderResolver
	errors []string
}

func (r *CreateOrderPayloadResolver) Order() *OrderResolver { return r.order }
func (r *CreateOrderPayloadResolver) Errors() *[]string {
	if len(r.errors) == 0 {
		return nil
	}
	return &r.errors
}

// ─── DataLoader for N+1 prevention ───

type ProductLoader struct {
	service  ProductService
	mu       sync.Mutex
	batch    map[string][]chan<- productResult
	timer    *time.Timer
}

type productResult struct {
	product *Product
	err     error
}

func NewProductLoader(service ProductService) *ProductLoader {
	return &ProductLoader{
		service: service,
		batch:   make(map[string][]chan<- productResult),
	}
}

// Load queues a product load and returns the result when batch fires
func (l *ProductLoader) Load(ctx context.Context, id string) (*Product, error) {
	ch := make(chan productResult, 1)

	l.mu.Lock()
	l.batch[id] = append(l.batch[id], ch)

	if l.timer == nil {
		// Fire batch after 1ms (collects all loads in current request)
		l.timer = time.AfterFunc(1*time.Millisecond, func() {
			l.dispatch(ctx)
		})
	}
	l.mu.Unlock()

	result := <-ch
	return result.product, result.err
}

func (l *ProductLoader) dispatch(ctx context.Context) {
	l.mu.Lock()
	batch := l.batch
	l.batch = make(map[string][]chan<- productResult)
	l.timer = nil
	l.mu.Unlock()

	ids := make([]string, 0, len(batch))
	for id := range batch {
		ids = append(ids, id)
	}

	products, err := l.service.FindByIDs(ctx, ids)

	productMap := make(map[string]*Product)
	for _, p := range products {
		productMap[p.ID] = p
	}

	for id, channels := range batch {
		var result productResult
		if err != nil {
			result.err = err
		} else if p, ok := productMap[id]; ok {
			result.product = p
		} else {
			result.err = fmt.Errorf("product not found: %s", id)
		}
		for _, ch := range channels {
			ch <- result
		}
	}
}

// RegisterHandler returns an http.Handler for the GraphQL endpoint
func RegisterHandler(resolver *RootResolver) http.Handler {
	schema := graphql.MustParseSchema(schema, resolver)
	return &relay.Handler{Schema: schema}
}

// GraphQL Playground
func PlaygroundHandler(endpoint string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprintf(w, `<!DOCTYPE html>
<html><head><title>GraphQL Playground</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/graphql-playground-react/build/static/css/index.css" />
</head><body>
<div id="root"></div>
<script src="https://cdn.jsdelivr.net/npm/graphql-playground-react/build/static/js/middleware.js"></script>
<script>window.addEventListener('load', function(event) {
  GraphQLPlayground.init(document.getElementById('root'), { endpoint: '%s' });
});</script></body></html>`, endpoint)
	})
}

// ─── JSON helper ───
func toJSON(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}
```

---

### Junior → FAANG: Understanding the N+1 Problem and Why DataLoader Is Non-Negotiable

The N+1 query problem is one of the most common performance issues in GraphQL APIs, and understanding it concretely is essential for FAANG interviews. The problem arises from the way GraphQL resolvers compose: each resolver for a field is called independently, without awareness of sibling calls at the same level.

Consider the `Order.items` resolver that returns a list of `OrderItem`, and each `OrderItem` has a `product` field that loads from the product service. If a client queries 20 orders and each order has 5 items, the naive implementation calls the product service once per item: 100 separate calls. With DataLoader, all 100 product IDs are batched into a single call, returning all products in one round trip.

The 1ms batch window in the `ProductLoader.Load` implementation is the key insight: within one request's resolver execution, every call to `Load` within a 1ms window is collected, and then a single `FindByIDs` call fires. This works because GraphQL resolvers for a single request execute concurrently under the hood, so all item-level product loads happen within the same request timeline.

First-job habit: any GraphQL field resolver that loads data from a database or downstream service should use a DataLoader unless it is provably loading a singleton. This is not optional at production scale.

### Senior @ FAANG: GraphQL Schema Design, Authorization Boundaries, and Operational Complexity

At senior level, GraphQL is not just a resolver implementation question. It is a schema design, authorization, and operational architecture question with significant trade-offs compared to gRPC.

Schema design is the first concern. A naive GraphQL schema exposes the full data model directly, which creates two problems: it leaks internal implementation details (field names, relationships, identifiers that match your database schema), and it makes the schema difficult to evolve because any change breaks existing client queries. The better approach is to design the GraphQL schema as an explicit API contract, distinct from the internal domain model. This means mapping field names intentionally, using connection-style pagination (Relay spec cursor pagination) rather than offset pagination for large collections, and using mutations with payload types that carry both the result and structured errors.

Authorization in GraphQL is more complex than in REST. A REST endpoint has a single authorization check. A GraphQL query can traverse multiple resource types in a single request, each requiring its own authorization decision. The naive approach of checking auth in each resolver creates inconsistency and is easy to miss. The production approach is a permission system that operates at the field level: a directive or middleware that evaluates the caller's permissions against the field being requested, applied consistently across the schema. Libraries like `99designs/gqlgen` support this via directives.

Persisted queries (APQ) are a senior-level concern for mobile and high-traffic clients. Instead of sending the full query document with each request, the client sends a hash, and the server looks up the pre-registered query by hash. This reduces payload size and eliminates the schema introspection attack surface: if the server only executes known queries, an attacker cannot probe the schema by sending arbitrary queries. FAANG-scale GraphQL deployments universally use persisted queries for their mobile clients.

The operational cost of GraphQL is higher than REST or gRPC for the same feature set. Each query has unpredictable complexity (a deeply nested query may fan out across dozens of services), so query complexity analysis and cost limits are production requirements. Without them, a malicious or buggy client can send a query that causes catastrophic fan-out, overwhelming backends and causing cascading failure. The `graph-gophers/graphql-go` library exposes complexity extension points. Set limits that reflect the realistic maximum query you expect from legitimate clients, plus a safety margin.
