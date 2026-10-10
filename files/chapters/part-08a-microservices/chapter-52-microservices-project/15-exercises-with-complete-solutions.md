## 52.14 Exercises with Complete Solutions

### Exercise 1: Add Distributed Tracing Across All Services

Implement OpenTelemetry tracing that propagates across service boundaries:

```go
// pkg/tracing/tracing.go
package tracing

import (
    "context"
    "net/http"

    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/attribute"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/propagation"
    "go.opentelemetry.io/otel/sdk/resource"
    sdktrace "go.opentelemetry.io/otel/sdk/trace"
    semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
    "go.opentelemetry.io/otel/trace"
    "google.golang.org/grpc"
)

// InitTracer initializes OpenTelemetry tracer
func InitTracer(ctx context.Context, serviceName, endpoint string) (*sdktrace.TracerProvider, error) {
    // Create OTLP exporter
    exporter, err := otlptracegrpc.New(ctx,
        otlptracegrpc.WithEndpoint(endpoint),
        otlptracegrpc.WithInsecure(),
    )
    if err != nil {
        return nil, err
    }

    // Create resource with service info
    res, err := resource.New(ctx,
        resource.WithAttributes(
            semconv.ServiceName(serviceName),
            semconv.ServiceVersion("1.0.0"),
        ),
    )
    if err != nil {
        return nil, err
    }

    // Create tracer provider
    tp := sdktrace.NewTracerProvider(
        sdktrace.WithBatcher(exporter),
        sdktrace.WithResource(res),
        sdktrace.WithSampler(sdktrace.AlwaysSample()),
    )

    otel.SetTracerProvider(tp)
    otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
        propagation.TraceContext{},
        propagation.Baggage{},
    ))

    return tp, nil
}

// HTTPMiddleware adds tracing to HTTP handlers
func HTTPMiddleware(serviceName string) func(http.Handler) http.Handler {
    tracer := otel.Tracer(serviceName)

    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Extract trace context from incoming request
            ctx := otel.GetTextMapPropagator().Extract(
                r.Context(),
                propagation.HeaderCarrier(r.Header),
            )

            // Start span
            ctx, span := tracer.Start(ctx, r.URL.Path,
                trace.WithSpanKind(trace.SpanKindServer),
                trace.WithAttributes(
                    semconv.HTTPMethod(r.Method),
                    semconv.HTTPRoute(r.URL.Path),
                    semconv.HTTPScheme(r.URL.Scheme),
                ),
            )
            defer span.End()

            // Wrap response writer to capture status code
            wrapped := &responseWriter{ResponseWriter: w, statusCode: 200}

            // Continue with traced context
            next.ServeHTTP(wrapped, r.WithContext(ctx))

            // Record response
            span.SetAttributes(semconv.HTTPStatusCode(wrapped.statusCode))
            if wrapped.statusCode >= 400 {
                span.SetStatus(codes.Error, http.StatusText(wrapped.statusCode))
            }
        })
    }
}

type responseWriter struct {
    http.ResponseWriter
    statusCode int
}

func (w *responseWriter) WriteHeader(code int) {
    w.statusCode = code
    w.ResponseWriter.WriteHeader(code)
}

// TracedHTTPClient wraps http.Client with tracing
type TracedHTTPClient struct {
    client  *http.Client
    tracer  trace.Tracer
}

func NewTracedHTTPClient(serviceName string) *TracedHTTPClient {
    return &TracedHTTPClient{
        client: &http.Client{Timeout: 30 * time.Second},
        tracer: otel.Tracer(serviceName),
    }
}

func (c *TracedHTTPClient) Do(ctx context.Context, req *http.Request) (*http.Response, error) {
    ctx, span := c.tracer.Start(ctx, req.URL.Path,
        trace.WithSpanKind(trace.SpanKindClient),
        trace.WithAttributes(
            semconv.HTTPMethod(req.Method),
            semconv.HTTPRoute(req.URL.Path),
            attribute.String("http.host", req.URL.Host),
        ),
    )
    defer span.End()

    // Inject trace context into outgoing request
    otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(req.Header))

    resp, err := c.client.Do(req.WithContext(ctx))
    if err != nil {
        span.RecordError(err)
        span.SetStatus(codes.Error, err.Error())
        return nil, err
    }

    span.SetAttributes(semconv.HTTPStatusCode(resp.StatusCode))
    return resp, nil
}

// TracedGRPCClient adds tracing to gRPC calls
func TracedGRPCUnaryInterceptor() grpc.UnaryClientInterceptor {
    tracer := otel.Tracer("grpc-client")

    return func(
        ctx context.Context,
        method string,
        req, reply any,
        cc *grpc.ClientConn,
        invoker grpc.UnaryInvoker,
        opts ...grpc.CallOption,
    ) error {
        ctx, span := tracer.Start(ctx, method,
            trace.WithSpanKind(trace.SpanKindClient),
            trace.WithAttributes(
                semconv.RPCSystemGRPC,
                semconv.RPCMethod(method),
            ),
        )
        defer span.End()

        err := invoker(ctx, method, req, reply, cc, opts...)
        if err != nil {
            span.RecordError(err)
            span.SetStatus(codes.Error, err.Error())
        }
        return err
    }
}

// Example: Tracing across Order → Inventory → Payment
func (s *OrderService) CreateOrderWithTracing(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    tracer := otel.Tracer("order-service")

    ctx, span := tracer.Start(ctx, "CreateOrder")
    defer span.End()

    span.SetAttributes(
        attribute.String("order.user_id", req.UserID),
        attribute.Int("order.item_count", len(req.Items)),
    )

    // Call inventory - trace propagates via context
    ctx, inventorySpan := tracer.Start(ctx, "ReserveInventory")
    reservation, err := s.inventoryClient.Reserve(ctx, req.Items)
    if err != nil {
        inventorySpan.RecordError(err)
        inventorySpan.SetStatus(codes.Error, "inventory reservation failed")
        inventorySpan.End()
        return nil, err
    }
    inventorySpan.SetAttributes(attribute.String("reservation.id", reservation.ID))
    inventorySpan.End()

    // Call payment - trace propagates
    ctx, paymentSpan := tracer.Start(ctx, "ProcessPayment")
    payment, err := s.paymentClient.Process(ctx, req.Payment)
    if err != nil {
        paymentSpan.RecordError(err)
        paymentSpan.End()

        // Compensate with traced span
        ctx, compSpan := tracer.Start(ctx, "CompensateInventory")
        s.inventoryClient.Release(ctx, reservation.ID)
        compSpan.End()

        return nil, err
    }
    paymentSpan.SetAttributes(attribute.String("payment.id", payment.ID))
    paymentSpan.End()

    // Create order
    order := &Order{
        ID:        generateID(),
        UserID:    req.UserID,
        PaymentID: payment.ID,
        Status:    OrderConfirmed,
    }

    span.SetAttributes(attribute.String("order.id", order.ID))

    return order, nil
}
```

### Exercise 2: Implement a Complete Product Search Service with Elasticsearch

Build a search service that indexes products in Elasticsearch and supports full-text queries, category/brand/price filters, faceted results, and autocomplete suggestions. The service listens for product and inventory events from Kafka to keep the search index synchronized with the source-of-truth databases.

```go
// internal/search/service.go
package search

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "log/slog"

    "github.com/elastic/go-elasticsearch/v8"
    "github.com/elastic/go-elasticsearch/v8/esapi"
)

type SearchService struct {
    es      *elasticsearch.Client
    index   string
    logger  *slog.Logger
}

type Product struct {
    ID          string   `json:"id"`
    Name        string   `json:"name"`
    Description string   `json:"description"`
    Category    string   `json:"category"`
    Brand       string   `json:"brand"`
    PriceCents  int64    `json:"price_cents"`
    Tags        []string `json:"tags"`
    InStock     bool     `json:"in_stock"`
    Rating      float64  `json:"rating"`
    CreatedAt   string   `json:"created_at"`
}

type SearchRequest struct {
    Query      string
    Category   string
    Brand      string
    MinPriceCents int64
    MaxPriceCents int64
    InStock    *bool
    SortBy     string
    SortOrder  string
    Page       int
    PageSize   int
}

type SearchResult struct {
    Products   []Product
    Total      int64
    Took       int64
    Facets     map[string][]Facet
}

type Facet struct {
    Value string
    Count int64
}

func NewSearchService(esURL, index string) (*SearchService, error) {
    cfg := elasticsearch.Config{
        Addresses: []string{esURL},
    }

    client, err := elasticsearch.NewClient(cfg)
    if err != nil {
        return nil, err
    }

    return &SearchService{
        es:     client,
        index:  index,
        logger: slog.Default(),
    }, nil
}

// CreateIndex creates the products index with proper mappings
func (s *SearchService) CreateIndex(ctx context.Context) error {
    mapping := map[string]any{
        "settings": map[string]any{
            "number_of_shards":   3,
            "number_of_replicas": 1,
            "analysis": map[string]any{
                "analyzer": map[string]any{
                    "product_analyzer": map[string]any{
                        "type":      "custom",
                        "tokenizer": "standard",
                        "filter":    []string{"lowercase", "asciifolding", "snowball"},
                    },
                },
            },
        },
        "mappings": map[string]any{
            "properties": map[string]any{
                "name": map[string]any{
                    "type":     "text",
                    "analyzer": "product_analyzer",
                    "fields": map[string]any{
                        "keyword": map[string]any{"type": "keyword"},
                        "suggest": map[string]any{"type": "completion"},
                    },
                },
                "description": map[string]any{
                    "type":     "text",
                    "analyzer": "product_analyzer",
                },
                "category": map[string]any{
                    "type": "keyword",
                },
                "brand": map[string]any{
                    "type": "keyword",
                },
                "price_cents": map[string]any{
                    "type": "long",
                },
                "tags": map[string]any{
                    "type": "keyword",
                },
                "in_stock": map[string]any{
                    "type": "boolean",
                },
                "rating": map[string]any{
                    "type": "float",
                },
                "created_at": map[string]any{
                    "type": "date",
                },
            },
        },
    }

    body, _ := json.Marshal(mapping)
    req := esapi.IndicesCreateRequest{
        Index: s.index,
        Body:  bytes.NewReader(body),
    }

    res, err := req.Do(ctx, s.es)
    if err != nil {
        return err
    }
    defer res.Body.Close()

    if res.IsError() {
        return fmt.Errorf("error creating index: %s", res.String())
    }

    return nil
}

// IndexProduct adds or updates a product in the index
func (s *SearchService) IndexProduct(ctx context.Context, product *Product) error {
    body, err := json.Marshal(product)
    if err != nil {
        return err
    }

    req := esapi.IndexRequest{
        Index:      s.index,
        DocumentID: product.ID,
        Body:       bytes.NewReader(body),
        Refresh:    "true",
    }

    res, err := req.Do(ctx, s.es)
    if err != nil {
        return err
    }
    defer res.Body.Close()

    if res.IsError() {
        return fmt.Errorf("error indexing product: %s", res.String())
    }

    return nil
}

// Search performs a full-text search with filters and facets
func (s *SearchService) Search(ctx context.Context, req *SearchRequest) (*SearchResult, error) {
    // Build query
    query := s.buildQuery(req)

    // Add sorting
    sort := s.buildSort(req)

    // Add aggregations for facets
    aggs := map[string]any{
        "categories": map[string]any{
            "terms": map[string]any{"field": "category", "size": 20},
        },
        "brands": map[string]any{
            "terms": map[string]any{"field": "brand", "size": 20},
        },
        "price_ranges": map[string]any{
            "range": map[string]any{
                "field": "price_cents",
                "ranges": []map[string]any{
                    {"to": 5000, "key": "Under $50"},
                    {"from": 5000, "to": 10000, "key": "$50-$100"},
                    {"from": 10000, "to": 20000, "key": "$100-$200"},
                    {"from": 20000, "key": "Over $200"},
                },
            },
        },
    }

    // Calculate pagination
    from := (req.Page - 1) * req.PageSize
    if from < 0 {
        from = 0
    }

    searchBody := map[string]any{
        "query":        query,
        "sort":         sort,
        "aggs":         aggs,
        "from":         from,
        "size":         req.PageSize,
        "track_total_hits": true,
    }

    body, _ := json.Marshal(searchBody)

    res, err := s.es.Search(
        s.es.Search.WithContext(ctx),
        s.es.Search.WithIndex(s.index),
        s.es.Search.WithBody(bytes.NewReader(body)),
    )
    if err != nil {
        return nil, err
    }
    defer res.Body.Close()

    if res.IsError() {
        return nil, fmt.Errorf("search error: %s", res.String())
    }

    var response searchResponse
    if err := json.NewDecoder(res.Body).Decode(&response); err != nil {
        return nil, err
    }

    return s.parseResponse(&response), nil
}

func (s *SearchService) buildQuery(req *SearchRequest) map[string]any {
    must := []map[string]any{}
    filter := []map[string]any{}

    // Full-text search
    if req.Query != "" {
        must = append(must, map[string]any{
            "multi_match": map[string]any{
                "query":  req.Query,
                "fields": []string{"name^3", "description", "brand^2", "tags"},
                "type":   "best_fields",
                "fuzziness": "AUTO",
            },
        })
    }

    // Category filter
    if req.Category != "" {
        filter = append(filter, map[string]any{
            "term": map[string]any{"category": req.Category},
        })
    }

    // Brand filter
    if req.Brand != "" {
        filter = append(filter, map[string]any{
            "term": map[string]any{"brand": req.Brand},
        })
    }

    // Price range filter
    priceRange := map[string]any{}
    if req.MinPriceCents > 0 {
        priceRange["gte"] = req.MinPriceCents
    }
    if req.MaxPriceCents > 0 {
        priceRange["lte"] = req.MaxPriceCents
    }
    if len(priceRange) > 0 {
        filter = append(filter, map[string]any{
            "range": map[string]any{"price_cents": priceRange},
        })
    }

    // Stock filter
    if req.InStock != nil {
        filter = append(filter, map[string]any{
            "term": map[string]any{"in_stock": *req.InStock},
        })
    }

    // Build bool query
    boolQuery := map[string]any{}
    if len(must) > 0 {
        boolQuery["must"] = must
    } else {
        boolQuery["must"] = []map[string]any{
            {"match_all": map[string]any{}},
        }
    }
    if len(filter) > 0 {
        boolQuery["filter"] = filter
    }

    return map[string]any{"bool": boolQuery}
}

func (s *SearchService) buildSort(req *SearchRequest) []map[string]any {
    sortField := "created_at"
    sortOrder := "desc"

    if req.SortBy != "" {
        switch req.SortBy {
        case "price", "price_cents":
            sortField = "price_cents"
        case "rating":
            sortField = "rating"
        case "name":
            sortField = "name.keyword"
        }
    }

    if req.SortOrder == "asc" {
        sortOrder = "asc"
    }

    return []map[string]any{
        {sortField: map[string]any{"order": sortOrder}},
        {"_score": map[string]any{"order": "desc"}},
    }
}

// Autocomplete provides search suggestions
func (s *SearchService) Autocomplete(ctx context.Context, prefix string, size int) ([]string, error) {
    query := map[string]any{
        "suggest": map[string]any{
            "product-suggest": map[string]any{
                "prefix": prefix,
                "completion": map[string]any{
                    "field":           "name.suggest",
                    "size":            size,
                    "skip_duplicates": true,
                },
            },
        },
    }

    body, _ := json.Marshal(query)

    res, err := s.es.Search(
        s.es.Search.WithContext(ctx),
        s.es.Search.WithIndex(s.index),
        s.es.Search.WithBody(bytes.NewReader(body)),
    )
    if err != nil {
        return nil, err
    }
    defer res.Body.Close()

    var response map[string]any
    json.NewDecoder(res.Body).Decode(&response)

    suggestions := []string{}
    if suggest, ok := response["suggest"].(map[string]any); ok {
        if productSuggest, ok := suggest["product-suggest"].([]any); ok {
            for _, s := range productSuggest {
                if entry, ok := s.(map[string]any); ok {
                    if options, ok := entry["options"].([]any); ok {
                        for _, opt := range options {
                            if option, ok := opt.(map[string]any); ok {
                                if text, ok := option["text"].(string); ok {
                                    suggestions = append(suggestions, text)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    return suggestions, nil
}

// Event handler for keeping search index in sync
type ProductEventHandler struct {
    search *SearchService
    logger *slog.Logger
}

func (h *ProductEventHandler) HandleProductCreated(ctx context.Context, event ProductCreatedEvent) error {
    product := &Product{
        ID:          event.ProductID,
        Name:        event.Name,
        Description: event.Description,
        Category:    event.Category,
        Brand:       event.Brand,
        PriceCents:  event.PriceCents,
        Tags:        event.Tags,
        InStock:     event.InStock,
        CreatedAt:   event.CreatedAt.Format(time.RFC3339),
    }

    return h.search.IndexProduct(ctx, product)
}

func (h *ProductEventHandler) HandleProductUpdated(ctx context.Context, event ProductUpdatedEvent) error {
    // Re-index with updated data
    return h.search.IndexProduct(ctx, &Product{
        ID:          event.ProductID,
        Name:        event.Name,
        Description: event.Description,
        PriceCents:  event.PriceCents,
        InStock:     event.InStock,
    })
}

func (h *ProductEventHandler) HandleInventoryUpdated(ctx context.Context, event InventoryUpdatedEvent) error {
    // Update only the in_stock field
    update := map[string]any{
        "doc": map[string]any{
            "in_stock": event.Quantity > 0,
        },
    }

    body, _ := json.Marshal(update)

    req := esapi.UpdateRequest{
        Index:      h.search.index,
        DocumentID: event.ProductID,
        Body:       bytes.NewReader(body),
    }

    res, err := req.Do(ctx, h.search.es)
    if err != nil {
        return err
    }
    defer res.Body.Close()

    return nil
}
```

### Junior → FAANG: How to Approach These Exercises for Maximum Interview Benefit

These two exercises (distributed tracing and Elasticsearch search) are full implementations, not skeleton code. The maximum value comes from understanding the design decisions inside each implementation, not from running the code.

**For the tracing exercise, study the propagation chain.** The `HTTPMiddleware` extracts trace context from the incoming request and creates a new span. The `TracedHTTPClient` injects trace context into the outgoing request. This propagation, extract on entry, inject on exit, is the mechanism that makes a trace span multiple services. A trace ID set at the API gateway arrives in the order service, inventory service, and payment service because each service extracts the same ID and adds its spans to the same trace. If any link in the chain fails to propagate (for example, a service creates a new context without the trace), the trace breaks and you lose the cross-service correlation. Practice explaining this propagation chain in your own words.

**For the Elasticsearch exercise, study the mapping design.** The `name` field has three sub-fields: `text` for full-text search, `keyword` for exact match and sorting, and `suggest` for autocomplete. This triple-field pattern is the standard Elasticsearch approach for product catalog fields. Get it wrong (store name only as `text`) and you cannot sort alphabetically or do autocomplete. Know this pattern by name: "multi-field mapping."

**Both exercises use event-driven index synchronization.** The search consumer handles `ProductCreated`, `ProductUpdated`, and `InventoryUpdated` events. This is a read model projection: the search index is a denormalized view of the product catalog, kept in sync by events. The pattern applies to any read model (a user profile cache, a recommendation dataset, a reporting table). Practice describing this pattern: "We use event-driven projections to maintain read-optimized views without synchronous coupling to the source service."

**First-job habit.** For both exercises, write the test before the implementation. For tracing: assert that a request produces a span with the correct attributes. For search: assert that indexing a product and then searching for it by name returns the correct result.

### Senior @ FAANG: Tracing Infrastructure and Search Platform Architecture

These exercises introduce two platform-level concerns: observability infrastructure and search infrastructure. At FAANG, both are managed by dedicated platform teams with their own roadmaps, governance, and SLOs.

**Tracing sampling strategy at scale.** The `InitTracer` function uses `sdktrace.AlwaysSample()`. At high request rates, this means every request generates trace data, which can be gigabytes per minute. Production systems use tail-based sampling: collect all spans for a trace, then decide whether to keep the trace based on its outcome (discard 99% of successful fast traces, keep 100% of error traces and slow traces). Jaeger and the OpenTelemetry Collector both support tail-based sampling. The sampling policy is a platform governance decision: who sets the rules, how are they tuned, and what is the retention period for sampled traces?

**Cardinality control for trace attributes.** The `attribute.String("user_id", req.UserID)` line adds a high-cardinality label to each span. In a tracing backend that indexes labels, high-cardinality attributes can cause memory exhaustion and query timeouts. Platform teams at FAANG define cardinality budgets: which attributes are allowed on spans, which are prohibited (raw user IDs, email addresses), and what the maximum label count is per span. This policy is enforced through a custom span processor that strips prohibited attributes before export.

**Search index governance.** The Elasticsearch index mapping in this exercise is defined in Go code, which means it is version-controlled and deployed with the service. In production, index mappings are managed through an index lifecycle management (ILM) policy and a dedicated schema migration process. Changing a mapping (adding an analyzer, changing a field type) requires a reindex, which can take hours for a large catalog. The platform team owns the reindex playbook, the blue-green index switch (write to both old and new indexes during migration, then switch the alias), and the monitoring that confirms the new index is serving queries correctly before the old one is retired.

---
