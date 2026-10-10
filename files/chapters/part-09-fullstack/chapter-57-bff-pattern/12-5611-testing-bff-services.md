## 57.11 Testing BFF Services

BFF testing differs from microservice testing because the unit under test is the aggregation and transformation logic, not a domain model, making integration tests against downstream service stubs more valuable than pure unit tests. Spinning up stub HTTP servers in `TestMain` and injecting them via the client interfaces allows realistic tests that verify field mapping, error propagation, and timeout behavior without a running infrastructure stack. The test suite below covers the happy path, a degraded partial failure, and a full downstream outage scenario.

```go
// services/web-bff/internal/handler/home_test.go
package handler_test

import (
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "testing"
    "time"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
    "github.com/stretchr/testify/require"

    "shared/pkg/serviceclient"
    "web-bff/internal/aggregator"
    "web-bff/internal/handler"
)

func TestHomeHandler(t *testing.T) {
    t.Run("returns complete home data for authenticated user", func(t *testing.T) {
        mockAggregator := new(MockHomeAggregator)
        mockAggregator.On("GetHomeData", mock.Anything, mock.AnythingOfType("*string")).
            Return(&handler.HomeResponse{
                Hero: &handler.HeroSection{
                    Title: "Welcome",
                },
                FeaturedProducts: []*handler.ProductCard{
                    {ID: "prod-1", Name: "Product 1"},
                },
                User: &handler.UserSummary{
                    Name:      "John",
                    CartCount: 3,
                },
            }, nil)

        h := handler.NewHomeHandler(mockAggregator)

        req := httptest.NewRequest("GET", "/api/home", nil)
        req = req.WithContext(withUser(req.Context(), "user-123"))
        rec := httptest.NewRecorder()

        h.ServeHTTP(rec, req)

        require.Equal(t, http.StatusOK, rec.Code)

        var resp handler.HomeResponse
        err := json.NewDecoder(rec.Body).Decode(&resp)
        require.NoError(t, err)

        assert.Equal(t, "Welcome", resp.Hero.Title)
        assert.Len(t, resp.FeaturedProducts, 1)
        assert.Equal(t, "John", resp.User.Name)
        assert.Equal(t, 3, resp.User.CartCount)
    })

    t.Run("returns home data without user-specific content for anonymous", func(t *testing.T) {
        mockAggregator := new(MockHomeAggregator)
        mockAggregator.On("GetHomeData", mock.Anything, (*string)(nil)).
            Return(&handler.HomeResponse{
                Hero: &handler.HeroSection{
                    Title: "Welcome",
                },
                FeaturedProducts: []*handler.ProductCard{
                    {ID: "prod-1", Name: "Product 1"},
                },
                User: nil, // No user data
            }, nil)

        h := handler.NewHomeHandler(mockAggregator)

        req := httptest.NewRequest("GET", "/api/home", nil)
        rec := httptest.NewRecorder()

        h.ServeHTTP(rec, req)

        require.Equal(t, http.StatusOK, rec.Code)

        var resp handler.HomeResponse
        err := json.NewDecoder(rec.Body).Decode(&resp)
        require.NoError(t, err)

        assert.Nil(t, resp.User)
        assert.Nil(t, resp.Recommendations)
        assert.Nil(t, resp.RecentlyViewed)
    })

    t.Run("handles partial failures gracefully", func(t *testing.T) {
        mockAggregator := new(MockHomeAggregator)
        // Return partial data even if some services failed
        mockAggregator.On("GetHomeData", mock.Anything, mock.Anything).
            Return(&handler.HomeResponse{
                Hero:             &handler.HeroSection{Title: "Welcome"},
                FeaturedProducts: nil, // Product service failed
                Categories:       nil, // Category service failed
            }, nil)

        h := handler.NewHomeHandler(mockAggregator)

        req := httptest.NewRequest("GET", "/api/home", nil)
        rec := httptest.NewRecorder()

        h.ServeHTTP(rec, req)

        // Should still return 200 with partial data
        require.Equal(t, http.StatusOK, rec.Code)
    })
}

// Integration test with real service clients (mocked at HTTP level)
func TestHomeHandlerIntegration(t *testing.T) {
    // Mock backend services
    productServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        json.NewEncoder(w).Encode(map[string]any{
            "products": []map[string]any{
                {"id": "1", "name": "Product 1", "price_cents": 1999},
                {"id": "2", "name": "Product 2", "price_cents": 2999},
            },
        })
    }))
    defer productServer.Close()

    categoryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        json.NewEncoder(w).Encode([]map[string]any{
            {"id": "cat1", "name": "Electronics"},
            {"id": "cat2", "name": "Clothing"},
        })
    }))
    defer categoryServer.Close()

    // Create real clients pointing to mock servers
    productClient := serviceclient.NewProductClient(serviceclient.Config{
        BaseURL: productServer.URL,
        Timeout: 5 * time.Second,
    })

    categoryClient := serviceclient.NewCategoryClient(serviceclient.Config{
        BaseURL: categoryServer.URL,
        Timeout: 5 * time.Second,
    })

    cache := NewInMemoryCache()
    agg := aggregator.NewHomeAggregator(productClient, categoryClient, nil, nil, nil, cache)
    h := handler.NewHomeHandler(agg)

    req := httptest.NewRequest("GET", "/api/home", nil)
    rec := httptest.NewRecorder()

    h.ServeHTTP(rec, req)

    require.Equal(t, http.StatusOK, rec.Code)

    var resp handler.HomeResponse
    err := json.NewDecoder(rec.Body).Decode(&resp)
    require.NoError(t, err)

    assert.Len(t, resp.FeaturedProducts, 2)
    assert.Len(t, resp.Categories, 2)
}
```

### Junior -> FAANG: What to Test in a BFF

BFF testing differs from domain service testing because there is no domain model to unit test. The value is in the aggregation logic, the transformation correctness, and the failure handling. Focus your test energy on three scenarios.

The happy path test verifies that all upstream services returning success produces the correct response shape. This is table stakes. Every BFF handler needs it. Use `httptest.NewServer` to stand up stub upstream servers, wire them through real client implementations, and verify the assembled response.

The partial failure test verifies that one upstream service returning 500 still produces a 200 response with available data and correctly empty or nil optional fields. This test is the one that most junior engineers skip, and it is the one that surfaces the most production bugs. Run it for every optional section in your BFF response.

The timeout test verifies that an upstream service that hangs for longer than the BFF's timeout still produces a response within the expected deadline. Use `httptest.NewServer` with a handler that sleeps before responding, and verify that the BFF respects its context deadline and returns within the configured timeout plus a small margin.

For interviews, if asked to describe your testing strategy for a BFF, name all three scenarios and explain why partial failure testing is the most important one that teams neglect.

### Senior @ FAANG: Contract Testing and the Testing Pyramid

At senior level, the BFF testing strategy extends beyond the service boundary into contract testing with upstream services. The `TestHomeHandlerIntegration` test above is an integration test: it spins up stub HTTP servers that return hardcoded responses. This is useful for testing aggregation logic but does not verify that the stub responses actually match what the real upstream service returns.

Consumer-driven contract testing (Pact) closes this gap. Each BFF publishes a set of contracts: "I call `GET /products?limit=12&sort_by=featured` and expect a response with these fields." The product service's CI runs these contracts against its actual implementation. If the product service changes the field name from `review_count` to `reviews`, its CI fails because the web BFF's contract expects `review_count`. The product service team knows immediately that they have a breaking change and must coordinate with the BFF team before merging.

This inverts the blame model. Without contract testing, the web BFF discovers the breaking change in production when the field is suddenly nil. With contract testing, the product service CI discovers it before the change is merged. This is the correct direction for distributed systems testing.

Mutation testing is a senior-level quality assurance technique for BFF transformation logic. After writing table-driven transformation tests, run a mutation testing tool (like `go-mutesting`) that systematically introduces bugs into your transformation functions (flipping conditions, removing assignments, changing arithmetic) and verifies that your test suite catches each mutation. Transformation code that passes 100% coverage but fails mutation testing has tests that are not actually verifying the right behavior. This is especially important for field filtering and role-based data omission, where a missing condition can leak sensitive data.

At staff level, you define the testing standard for all BFF teams in your platform. A reasonable standard: unit tests for all aggregation and transformation logic, integration tests with `httptest.NewServer` for all BFF handlers covering happy path and partial failure, Pact contract tests for all upstream service clients, and a payload size test that verifies compressed response sizes stay within budget. Make the standard part of the BFF starter template so new teams inherit it without having to discover it.

---
