## 56.9 Testing GraphQL

Testing a GraphQL API requires covering schema validation, resolver logic, and the full HTTP request cycle including authentication headers and error serialization. gqlgen exposes a `client` package that issues real GraphQL operations against an `httptest.Server`, making integration tests straightforward without requiring a running database. The test patterns below combine table-driven tests for resolver logic with end-to-end tests that use the gqlgen client to verify operation responses against expected JSON shapes.

```go
// graph/resolver_test.go
package graph_test

import (
    "context"
    "net/http"
    "testing"

    "github.com/99designs/gqlgen/client"
    "github.com/99designs/gqlgen/graphql/handler"
    "github.com/99designs/gqlgen/graphql/handler/transport"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "graphql-api/graph"
    "graphql-api/graph/model"
    "graphql-api/internal/auth"
    "graphql-api/internal/testutil"
)

func TestUserQuery(t *testing.T) {
    // Setup test server
    srv, cleanup := setupTestServer(t)
    defer cleanup()

    c := client.New(srv)

    t.Run("get user by ID", func(t *testing.T) {
        var resp struct {
            User struct {
                ID    string
                Name  string
                Email string
            }
        }

        err := c.Post(`
            query GetUser($id: UUID!) {
                user(id: $id) {
                    id
                    name
                    email
                }
            }
        `, &resp,
            client.Var("id", "test-user-id"),
        )

        require.NoError(t, err)
        assert.Equal(t, "test-user-id", resp.User.ID)
        assert.Equal(t, "Test User", resp.User.Name)
    })

    t.Run("get user with orders", func(t *testing.T) {
        var resp struct {
            User struct {
                ID     string
                Name   string
                Orders struct {
                    Edges []struct {
                        Node struct {
                            ID     string
                            Status string
                        }
                    }
                }
            }
        }

        err := c.Post(`
            query GetUserWithOrders($id: UUID!) {
                user(id: $id) {
                    id
                    name
                    orders(first: 5) {
                        edges {
                            node {
                                id
                                status
                            }
                        }
                    }
                }
            }
        `, &resp,
            client.Var("id", "test-user-id"),
        )

        require.NoError(t, err)
        assert.NotEmpty(t, resp.User.Orders.Edges)
    })
}

func TestProductsQuery(t *testing.T) {
    srv, cleanup := setupTestServer(t)
    defer cleanup()

    c := client.New(srv)

    t.Run("list products with pagination", func(t *testing.T) {
        var resp struct {
            Products struct {
                Edges []struct {
                    Node struct {
                        ID    string
                        Name  string
                        PriceCents int64
                    }
                    Cursor string
                }
                PageInfo struct {
                    HasNextPage bool
                    EndCursor   *string
                }
            }
        }

        err := c.Post(`
            query ListProducts($first: Int) {
                products(first: $first) {
                    edges {
                        node {
                            id
                            name
                            price
                        }
                        cursor
                    }
                    pageInfo {
                        hasNextPage
                        endCursor
                    }
                }
            }
        `, &resp,
            client.Var("first", 10),
        )

        require.NoError(t, err)
        assert.Len(t, resp.Products.Edges, 10)
        assert.True(t, resp.Products.PageInfo.HasNextPage)
    })

    t.Run("filter products by category", func(t *testing.T) {
        var resp struct {
            Products struct {
                Edges []struct {
                    Node struct {
                        ID       string
                        Category struct {
                            ID string
                        }
                    }
                }
            }
        }

        err := c.Post(`
            query FilterProducts($filter: ProductFilter) {
                products(filter: $filter) {
                    edges {
                        node {
                            id
                            category {
                                id
                            }
                        }
                    }
                }
            }
        `, &resp,
            client.Var("filter", map[string]any{
                "categoryId": "electronics",
            }),
        )

        require.NoError(t, err)
        for _, edge := range resp.Products.Edges {
            assert.Equal(t, "electronics", edge.Node.Category.ID)
        }
    })
}

func TestCreateOrderMutation(t *testing.T) {
    srv, cleanup := setupTestServer(t)
    defer cleanup()

    c := client.New(srv)

    t.Run("create order requires authentication", func(t *testing.T) {
        var resp struct {
            CreateOrder struct {
                ID string
            }
        }

        err := c.Post(`
            mutation CreateOrder($input: CreateOrderInput!) {
                createOrder(input: $input) {
                    id
                }
            }
        `, &resp,
            client.Var("input", map[string]any{
                "items": []map[string]any{
                    {"productId": "prod-1", "quantity": 2},
                },
                "shippingAddress": map[string]any{
                    "street":     "123 Main St",
                    "city":       "NYC",
                    "state":      "NY",
                    "postalCode": "10001",
                    "country":    "USA",
                },
            }),
        )

        require.Error(t, err)
        assert.Contains(t, err.Error(), "unauthorized")
    })

    t.Run("create order with valid auth", func(t *testing.T) {
        var resp struct {
            CreateOrder struct {
                ID          string
                Status      string
                TotalAmountCents int64
                Items       []struct {
                    ProductID string
                    Quantity  int
                }
            }
        }

        // Add auth header
        err := c.Post(`
            mutation CreateOrder($input: CreateOrderInput!) {
                createOrder(input: $input) {
                    id
                    status
                    totalAmount
                    items {
                        product {
                            id
                        }
                        quantity
                    }
                }
            }
        `, &resp,
            client.Var("input", map[string]any{
                "items": []map[string]any{
                    {"productId": "prod-1", "quantity": 2},
                },
                "shippingAddress": map[string]any{
                    "street":     "123 Main St",
                    "city":       "NYC",
                    "state":      "NY",
                    "postalCode": "10001",
                    "country":    "USA",
                },
            }),
            client.AddHeader("Authorization", "Bearer valid-test-token"),
        )

        require.NoError(t, err)
        assert.NotEmpty(t, resp.CreateOrder.ID)
        assert.Equal(t, "PENDING", resp.CreateOrder.Status)
    })
}

func TestDataloaderBatching(t *testing.T) {
    srv, cleanup := setupTestServer(t)
    defer cleanup()

    c := client.New(srv)

    t.Run("products query batches category fetches", func(t *testing.T) {
        // Track database queries
        queryCounter := &testutil.QueryCounter{}

        var resp struct {
            Products struct {
                Edges []struct {
                    Node struct {
                        ID       string
                        Category struct {
                            Name string
                        }
                    }
                }
            }
        }

        err := c.Post(`
            query {
                products(first: 20) {
                    edges {
                        node {
                            id
                            category {
                                name
                            }
                        }
                    }
                }
            }
        `, &resp)

        require.NoError(t, err)
        // Should have 2 queries: 1 for products, 1 for categories (batched)
        // NOT 21 queries (N+1)
        assert.LessOrEqual(t, queryCounter.Count(), 3)
    })
}

// Helper functions

func setupTestServer(t *testing.T) (http.Handler, func()) {
    t.Helper()

    // Setup test database
    db := testutil.SetupTestDB(t)

    // Seed test data
    testutil.SeedTestData(t, db)

    // Create dependencies
    repos := repository.NewRepositories(db)
    services := service.NewServices(repos)
    authService := auth.NewTestService()

    resolver := graph.NewResolver(
        services.User,
        services.Product,
        services.Order,
        services.Review,
        authService,
    )

    // handler.New, not the deprecated handler.NewDefaultServer:
    // register only the transports tests need.
    srv := handler.New(graph.NewExecutableSchema(graph.Config{
        Resolvers:  resolver,
        Directives: graph.DirectiveRoot{},
    }))
    srv.AddTransport(transport.Options{})
    srv.AddTransport(transport.GET{})
    srv.AddTransport(transport.POST{})

    // Wrap with dataloader middleware
    h := dataloader.Middleware(repos)(srv)

    cleanup := func() {
        testutil.CleanupTestDB(t, db)
    }

    return h, cleanup
}
```

### Junior -> FAANG: Testing GraphQL Without Overcomplicating It

The most valuable test for a new GraphQL engineer is the integration test using gqlgen's `client` package against a real `httptest.Server`. It tests the full path: query parsing, variable binding, resolver invocation, dataloader batching, auth middleware, and JSON serialization. A unit test on the resolver method alone misses the auth middleware and the pagination cursor encoding.

For your first job, write tests in this order of priority:

First, the happy path for each operation (query, mutation, subscription) with valid auth. Verify the shape and key values of the response.

Second, the auth failure case for every protected operation. Verify that unauthenticated requests return the expected error code.

Third, the pagination test: request the first page, use the returned `endCursor` as the `after` argument for the second page, verify that results are non-overlapping and in the correct order.

The dataloader batching test (`TestDataloaderBatching`) is valuable but requires instrumentation to count database queries. If your test infrastructure does not support query counting, test the batching behavior indirectly by running a large list query and measuring response time, verifying it is consistent with O(1) database calls rather than O(N).

### Senior @ FAANG: Testing Strategy Across the GraphQL Stack

At staff level, testing strategy for a GraphQL platform spans multiple layers, and the right investment at each layer is different.

**Schema contract tests.** When clients use graphql-codegen or genqlient to generate typed clients from the schema, breaking schema changes break client code at generation time. A schema contract test suite runs against the GraphQL schema SDL (not a live server) and validates: all deprecated fields still exist (so deprecation does not become accidental removal), all `@key` fields for federated entities are present, and no fields have been renamed since the last release. This is a static analysis step in CI, not a runtime test.

**Resolver-level unit tests with mocks.** The resolver struct takes service interfaces. Unit tests provide mock implementations of those interfaces to test resolver logic in isolation: cursor encoding correctness, pagination boundary conditions, error mapping, and auth checks. These tests are fast (no database, no HTTP) and catch resolver-level bugs without requiring test infrastructure.

**Integration tests with a real database.** The `setupTestServer` pattern in this file uses a real database. At FAANG scale, the test database is a containerized instance started by the test suite using testcontainers-go. The test seeds specific data, runs GraphQL operations, and asserts on results. These tests are slower but catch issues that mock-based tests miss: SQL query correctness, index behavior with real data, cursor pagination with actual database ordering.

**Dataloader batching verification via OpenTelemetry.** To reliably verify that dataloaders are working in tests, configure the test server with an OpenTelemetry span exporter that writes spans to memory. After running a query, inspect the recorded spans: count the number of database query spans. A correctly batched `products` query with categories should produce exactly two database spans (one for products, one for categories), not N+1. This technique is more reliable than wrapping `sql.DB` with a custom query counter because it captures all database operations, including those initiated by goroutines that start after the resolver returns.

**Mutation idempotency tests.** For mutations that are retried on client failure (network timeout, server restart), test that sending the same mutation twice with the same idempotency key produces the same result without side effects (no duplicate orders, no duplicate charges). These tests require a database that persists between requests (unlike an in-memory database that resets) and a mechanism for generating deterministic idempotency keys.

**Performance regression tests.** For a high-traffic GraphQL API, add a benchmark test (`BenchmarkProductsWithCategories`) that measures the request throughput and p99 latency for a representative query against a seeded dataset. Run this benchmark in CI and fail the build if p99 latency increases by more than a configurable threshold (10-20%) relative to the baseline. This catches performance regressions from schema changes, new resolver logic, or accidental removal of dataloaders before they reach production.

---
