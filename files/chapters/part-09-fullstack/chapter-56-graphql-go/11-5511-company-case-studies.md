## 56.10 Company Case Studies

### GitHub: GraphQL API at Scale

GitHub migrated from REST to GraphQL for their v4 API, handling billions of requests per day (*GitHub Engineering Blog*, "The GitHub GraphQL API", 2016; *GitHub Docs*, "Resource limitations and rate limits for the GraphQL API"). Their key challenge was preventing abusive queries from consuming disproportionate server resources. GitHub solved this with a node-based complexity model: each field costs 1 point, and list fields multiply by their `first`/`last` argument, with a per-request cap of 5,000 nodes. Combined with a point-based rate limiter that charges based on actual query cost rather than flat per-request, this lets legitimate clients fetch complex data while blocking queries that would fan out into millions of database lookups.

```go
// github/pkg/graphql/complexity.go
// GitHub-style complexity calculation for preventing abusive queries
package graphql

import (
    "context"
    "fmt"
    "strconv"
    "time"

    "github.com/99designs/gqlgen/graphql"
    "github.com/redis/go-redis/v9"
    "github.com/vektah/gqlparser/v2/ast"
)

// GitHubComplexityCalculator implements GitHub's node-based complexity model
type GitHubComplexityCalculator struct {
    // MaxNodes is the maximum number of nodes a query can request
    MaxNodes int
    // MaxDepth is the maximum nesting depth
    MaxDepth int
}

func NewGitHubComplexityCalculator(maxNodes, maxDepth int) *GitHubComplexityCalculator {
    return &GitHubComplexityCalculator{
        MaxNodes: maxNodes,
        MaxDepth: maxDepth,
    }
}

// Calculate node count for a query
// GitHub formula: complexity = 1 + (first/last * child_complexity)
func (c *GitHubComplexityCalculator) Calculate(
    ctx context.Context,
    root *ast.OperationDefinition,
) (int, error) {
    complexity := c.calculateField(root.SelectionSet, 1, 0)

    if complexity > c.MaxNodes {
        return complexity, fmt.Errorf(
            "query complexity %d exceeds maximum allowed %d nodes",
            complexity, c.MaxNodes,
        )
    }

    return complexity, nil
}

func (c *GitHubComplexityCalculator) calculateFragment(name string, multiplier, depth int) int {
    return multiplier
}

func (c *GitHubComplexityCalculator) calculateField(
    selectionSet ast.SelectionSet,
    multiplier int,
    depth int,
) int {
    if depth > c.MaxDepth {
        return c.MaxNodes + 1 // Exceed limit to trigger error
    }

    total := 0
    for _, selection := range selectionSet {
        switch sel := selection.(type) {
        case *ast.Field:
            fieldComplexity := 1
            childMultiplier := 1

            // Check for pagination arguments
            for _, arg := range sel.Arguments {
                switch arg.Name {
                case "first", "last":
                    if n, err := strconv.Atoi(arg.Value.Raw); err == nil {
                        childMultiplier = n
                    }
                }
            }

            // Calculate child complexity
            if sel.SelectionSet != nil {
                childComplexity := c.calculateField(
                    sel.SelectionSet,
                    childMultiplier,
                    depth+1,
                )
                fieldComplexity += childComplexity
            }

            total += fieldComplexity * multiplier

        case *ast.FragmentSpread:
            // Handle fragments
            total += c.calculateFragment(sel.Name, multiplier, depth)
        }
    }

    return total
}

// RateLimiter for GraphQL queries based on complexity
type GraphQLRateLimiter struct {
    redis     *redis.Client
    maxPoints int           // Points per hour
    window    time.Duration
}

type QueryCost struct {
    Points    int
    Remaining int
    ResetAt   time.Time
}

func (r *GraphQLRateLimiter) CheckLimit(
    ctx context.Context,
    userID string,
    queryComplexity int,
) (*QueryCost, error) {
    key := fmt.Sprintf("graphql:rate:%s", userID)
    now := time.Now()
    windowStart := now.Truncate(r.window)

    // Use Redis transaction to atomically check and update
    var cost *QueryCost

    err := r.redis.Watch(ctx, func(tx *redis.Tx) error {
        // Get current usage
        currentStr, err := tx.Get(ctx, key).Result()
        current := 0
        if err == nil {
            current, _ = strconv.Atoi(currentStr)
        }

        newTotal := current + queryComplexity
        if newTotal > r.maxPoints {
            cost = &QueryCost{
                Points:    queryComplexity,
                Remaining: 0,
                ResetAt:   windowStart.Add(r.window),
            }
            return fmt.Errorf("rate limit exceeded")
        }

        // Update usage
        pipe := tx.Pipeline()
        pipe.Set(ctx, key, newTotal, r.window)
        _, err = pipe.Exec(ctx)
        if err != nil {
            return err
        }

        cost = &QueryCost{
            Points:    queryComplexity,
            Remaining: r.maxPoints - newTotal,
            ResetAt:   windowStart.Add(r.window),
        }
        return nil
    }, key)

    return cost, err
}

func costFromContext(ctx context.Context) *QueryCost {
    if cost, ok := ctx.Value("queryCost").(*QueryCost); ok {
        return cost
    }
    return nil
}

// Middleware to add rate limit headers
func RateLimitMiddleware(limiter *GraphQLRateLimiter) graphql.ResponseMiddleware {
    return func(ctx context.Context, next graphql.ResponseHandler) *graphql.Response {
        resp := next(ctx)

        // Add rate limit info to extensions
        if cost := costFromContext(ctx); cost != nil {
            if resp.Extensions == nil {
                resp.Extensions = make(map[string]any)
            }
            resp.Extensions["rateLimit"] = map[string]any{
                "cost":      cost.Points,
                "remaining": cost.Remaining,
                "resetAt":   cost.ResetAt.Format(time.RFC3339),
            }
        }

        return resp
    }
}
```

### Shopify: Schema Stitching for Multi-Service Architecture

Shopify uses GraphQL to federate across hundreds of microservices, each owning a slice of the overall schema (*Shopify Engineering*, "Building a Federated GraphQL Gateway at Shopify", 2021; "Shopify Storefront GraphQL API"). A central gateway receives client queries, decomposes them into subqueries routed to the owning service, and merges the results before returning to the client. Cross-service references are resolved using entity resolution queries (`_entities`) that batch-fetch referenced types by their keys. The query planner groups selections by owning service, identifies dependency chains between steps, and executes independent steps in parallel.

```go
// shopify/pkg/federation/gateway.go
// Shopify-style federated GraphQL gateway
package federation

import (
    "context"
    "fmt"
    "sync"
    "time"

    "github.com/vektah/gqlparser/v2/ast"
    "github.com/vektah/gqlparser/v2/parser"
)

// GraphQLClient executes GraphQL operations against a downstream subgraph service
type GraphQLClient interface {
    Execute(ctx context.Context, query string, vars map[string]any) (map[string]any, error)
}

// ServiceRegistry tracks available GraphQL services
type ServiceRegistry struct {
    mu       sync.RWMutex
    services map[string]*ServiceConfig
    schemas  map[string]*ast.Schema
}

func (r *ServiceRegistry) GetOwner(fieldName string) string {
    r.mu.RLock()
    defer r.mu.RUnlock()
    return "default"
}

type ServiceConfig struct {
    Name        string
    URL         string
    Types       []string // Types this service owns
    HealthCheck string
}

type SchemaCache struct{}

func NewSchemaCache(ttl time.Duration) *SchemaCache {
    return &SchemaCache{}
}

// Gateway coordinates queries across services
type Gateway struct {
    registry *ServiceRegistry
    planner  *QueryPlanner
    executor *FederatedExecutor
    cache    *SchemaCache
}

func NewGateway(registry *ServiceRegistry) *Gateway {
    return &Gateway{
        registry: registry,
        planner:  NewQueryPlanner(registry),
        executor: NewFederatedExecutor(registry),
        cache:    NewSchemaCache(5 * time.Minute),
    }
}

// QueryPlanner breaks queries into service-specific subqueries
type QueryPlanner struct {
    registry *ServiceRegistry
}

func NewQueryPlanner(registry *ServiceRegistry) *QueryPlanner {
    return &QueryPlanner{registry: registry}
}

type QueryPlan struct {
    Steps []QueryStep
}

type QueryStep struct {
    Service   string
    Query     string
    Variables map[string]any
    DependsOn []string // IDs of steps this depends on
    Provides  []string // Fields this step provides
}

func (p *QueryPlanner) buildSubquery(op ast.Operation, selections ast.SelectionSet) string {
    return ""
}

func (p *QueryPlanner) extractVariables(selections ast.SelectionSet, vars map[string]any) map[string]any {
    return vars
}

func (p *QueryPlanner) addEntityResolutionSteps(plan *QueryPlan) *QueryPlan {
    return plan
}

func (p *QueryPlanner) Plan(
    ctx context.Context,
    query string,
    variables map[string]any,
) (*QueryPlan, error) {
    doc, err := parser.ParseQuery(&ast.Source{Input: query})
    if err != nil {
        return nil, fmt.Errorf("parsing query: %w", err)
    }

    plan := &QueryPlan{Steps: []QueryStep{}}

    for _, op := range doc.Operations {
        serviceSelections := p.groupByService(op.SelectionSet)

        for service, selections := range serviceSelections {
            step := QueryStep{
                Service:   service,
                Query:     p.buildSubquery(op.Operation, selections),
                Variables: p.extractVariables(selections, variables),
            }
            plan.Steps = append(plan.Steps, step)
        }
    }

    plan = p.addEntityResolutionSteps(plan)

    return plan, nil
}

func (p *QueryPlanner) groupByService(
    selections ast.SelectionSet,
) map[string]ast.SelectionSet {
    result := make(map[string]ast.SelectionSet)

    for _, sel := range selections {
        field, ok := sel.(*ast.Field)
        if !ok {
            continue
        }

        service := p.registry.GetOwner(field.Name)
        if service == "" {
            service = "default"
        }

        result[service] = append(result[service], sel)
    }

    return result
}

// FederatedExecutor runs query plans across services
type FederatedExecutor struct {
    clients  map[string]GraphQLClient
    registry *ServiceRegistry
}

func NewFederatedExecutor(registry *ServiceRegistry) *FederatedExecutor {
    return &FederatedExecutor{
        clients:  make(map[string]GraphQLClient),
        registry: registry,
    }
}

func (e *FederatedExecutor) buildExecutionLevels(plan *QueryPlan) [][]QueryStep {
    if len(plan.Steps) == 0 {
        return nil
    }
    return [][]QueryStep{plan.Steps}
}

func (e *FederatedExecutor) resolveDependencies(s QueryStep, results map[string]any) map[string]any {
    return s.Variables
}

func mergeResults(dst, src map[string]any) {
    for k, v := range src {
        dst[k] = v
    }
}

func (e *FederatedExecutor) getFieldsForType(typename string) string {
    return "id"
}

func (e *FederatedExecutor) Execute(
    ctx context.Context,
    plan *QueryPlan,
) (map[string]any, error) {
    results := make(map[string]any)
    var mu sync.Mutex

    levels := e.buildExecutionLevels(plan)

    for _, level := range levels {
        var wg sync.WaitGroup
        errChan := make(chan error, len(level))

        for _, step := range level {
            wg.Add(1)
            go func(s QueryStep) {
                defer wg.Done()

                vars := e.resolveDependencies(s, results)

                client := e.clients[s.Service]
                if client == nil {
                    errChan <- fmt.Errorf("service client not found: %s", s.Service)
                    return
                }
                result, err := client.Execute(ctx, s.Query, vars)
                if err != nil {
                    errChan <- fmt.Errorf("service %s: %w", s.Service, err)
                    return
                }

                mu.Lock()
                mergeResults(results, result)
                mu.Unlock()
            }(step)
        }

        wg.Wait()
        close(errChan)

        for err := range errChan {
            return nil, err
        }
    }

    return results, nil
}

// Entity resolution for federated types
func (e *FederatedExecutor) resolveEntities(
    ctx context.Context,
    service string,
    typename string,
    keys []map[string]any,
) ([]any, error) {
    query := fmt.Sprintf(`
        query($representations: [_Any!]!) {
            _entities(representations: $representations) {
                ... on %s {
                    __typename
                    %s
                }
            }
        }
    `, typename, e.getFieldsForType(typename))

    representations := make([]map[string]any, len(keys))
    for i, key := range keys {
        key["__typename"] = typename
        representations[i] = key
    }

    client := e.clients[service]
    if client == nil {
        return nil, fmt.Errorf("client not found: %s", service)
    }

    result, err := client.Execute(ctx, query, map[string]any{
        "representations": representations,
    })
    if err != nil {
        return nil, err
    }

    entities, ok := result["_entities"].([]any)
    if !ok {
        return nil, fmt.Errorf("invalid response format from entity resolver")
    }

    return entities, nil
}
```

### Netflix: Performance Optimizations for High-Traffic GraphQL

Netflix's GraphQL API serves personalized content to millions of concurrent users, where latency directly affects engagement (*Netflix Technology Blog*, "How Netflix Scales Its API with GraphQL Federation", 2020; "Our Learnings from Adopting GraphQL", 2021). Their optimizations focus on three layers: query caching with LRU eviction and TTL to avoid re-parsing and re-validating repeated queries, automatic persisted queries (APQ) that replace full query strings with SHA-256 hashes to reduce payload size, and an optimized dataloader that triggers batch execution both on a timer (2ms) and when the batch reaches capacity, whichever comes first.

```go
// netflix/pkg/graphql/performance.go
// Netflix-style performance optimizations
package graphql

import (
    "container/list"
    "context"
    "crypto/sha256"
    "encoding/hex"
    "errors"
    "fmt"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
)

var ErrQueryNotFound = errors.New("query not found")

// QueryCache with LRU eviction and TTL
type QueryCache struct {
    mu       sync.RWMutex
    cache    map[string]*cacheEntry
    lru      *list.List
    maxSize  int
    ttl      time.Duration
}

type cacheEntry struct {
    key       string
    value     any
    expiresAt time.Time
    element   *list.Element
}

func NewQueryCache(maxSize int, ttl time.Duration) *QueryCache {
    qc := &QueryCache{
        cache:   make(map[string]*cacheEntry),
        lru:     list.New(),
        maxSize: maxSize,
        ttl:     ttl,
    }

    // Start cleanup goroutine
    go qc.cleanup()

    return qc
}

func (c *QueryCache) cleanup() {
    ticker := time.NewTicker(c.ttl)
    defer ticker.Stop()
    for range ticker.C {
        c.mu.Lock()
        now := time.Now()
        for key, entry := range c.cache {
            if now.After(entry.expiresAt) {
                c.lru.Remove(entry.element)
                delete(c.cache, key)
            }
        }
        c.mu.Unlock()
    }
}

func (c *QueryCache) Get(key string) (any, bool) {
    c.mu.RLock()
    entry, exists := c.cache[key]
    c.mu.RUnlock()

    if !exists || time.Now().After(entry.expiresAt) {
        return nil, false
    }

    // Move to front of LRU
    c.mu.Lock()
    c.lru.MoveToFront(entry.element)
    c.mu.Unlock()

    return entry.value, true
}

func (c *QueryCache) Set(key string, value any) {
    c.mu.Lock()
    defer c.mu.Unlock()

    // Check if exists
    if entry, exists := c.cache[key]; exists {
        entry.value = value
        entry.expiresAt = time.Now().Add(c.ttl)
        c.lru.MoveToFront(entry.element)
        return
    }

    // Evict if necessary
    for c.lru.Len() >= c.maxSize {
        oldest := c.lru.Back()
        if oldest != nil {
            c.lru.Remove(oldest)
            delete(c.cache, oldest.Value.(*cacheEntry).key)
        }
    }

    // Add new entry
    entry := &cacheEntry{
        key:       key,
        value:     value,
        expiresAt: time.Now().Add(c.ttl),
    }
    entry.element = c.lru.PushFront(entry)
    c.cache[key] = entry
}

// PersistedQueryStore for Automatic Persisted Queries (APQ)
type PersistedQueryStore struct {
    redis *redis.Client
    local *QueryCache
}

func (s *PersistedQueryStore) Get(ctx context.Context, hash string) (string, error) {
    // Check local cache first
    if query, ok := s.local.Get(hash); ok {
        return query.(string), nil
    }

    // Check Redis
    query, err := s.redis.Get(ctx, "apq:"+hash).Result()
    if err == redis.Nil {
        return "", ErrQueryNotFound
    }
    if err != nil {
        return "", err
    }

    // Update local cache
    s.local.Set(hash, query)

    return query, nil
}

func (s *PersistedQueryStore) Set(ctx context.Context, query string) (string, error) {
    // Compute hash
    h := sha256.Sum256([]byte(query))
    hash := hex.EncodeToString(h[:])

    // Store in Redis with 7-day TTL
    err := s.redis.Set(ctx, "apq:"+hash, query, 7*24*time.Hour).Err()
    if err != nil {
        return "", err
    }

    // Store locally
    s.local.Set(hash, query)

    return hash, nil
}

// BatchingDataLoader with Netflix optimizations
type OptimizedDataLoader struct {
    batchFn    BatchFunc
    cache      *sync.Map
    pending    map[string][]chan Result
    mu         sync.Mutex
    batchSize  int
    wait       time.Duration
    timer      *time.Timer
}

type BatchFunc func(ctx context.Context, keys []string) ([]any, []error)

type Result struct {
    Value any
    Error error
}

type LoaderOption func(*OptimizedDataLoader)

func NewOptimizedDataLoader(batchFn BatchFunc, opts ...LoaderOption) *OptimizedDataLoader {
    loader := &OptimizedDataLoader{
        batchFn:   batchFn,
        cache:     &sync.Map{},
        pending:   make(map[string][]chan Result),
        batchSize: 100,
        wait:      2 * time.Millisecond,
    }

    for _, opt := range opts {
        opt(loader)
    }

    return loader
}

func (l *OptimizedDataLoader) Load(ctx context.Context, key string) (any, error) {
    // Check cache
    if val, ok := l.cache.Load(key); ok {
        return val, nil
    }

    // Create result channel
    resultChan := make(chan Result, 1)

    l.mu.Lock()
    l.pending[key] = append(l.pending[key], resultChan)
    pendingCount := len(l.pending)

    // Start batch timer if this is the first pending request
    if pendingCount == 1 {
        l.timer = time.AfterFunc(l.wait, func() {
            l.executeBatch(ctx)
        })
    }

    // Execute immediately if batch is full
    if pendingCount >= l.batchSize {
        if l.timer != nil {
            l.timer.Stop()
        }
        go l.executeBatch(ctx)
    }
    l.mu.Unlock()

    // Wait for result
    select {
    case result := <-resultChan:
        return result.Value, result.Error
    case <-ctx.Done():
        return nil, ctx.Err()
    }
}

func (l *OptimizedDataLoader) executeBatch(ctx context.Context) {
    l.mu.Lock()
    pending := l.pending
    l.pending = make(map[string][]chan Result)
    l.mu.Unlock()

    if len(pending) == 0 {
        return
    }

    // Collect keys
    keys := make([]string, 0, len(pending))
    for key := range pending {
        keys = append(keys, key)
    }

    // Execute batch function
    values, errs := l.batchFn(ctx, keys)

    // Distribute results
    for i, key := range keys {
        var result Result
        if i < len(errs) && errs[i] != nil {
            result = Result{Error: errs[i]}
        } else if i < len(values) {
            result = Result{Value: values[i]}
            // Cache successful results
            l.cache.Store(key, values[i])
        } else {
            result = Result{Error: fmt.Errorf("no result for key: %s", key)}
        }

        for _, ch := range pending[key] {
            ch <- result
            close(ch)
        }
    }
}

// Prefetching based on query patterns
type QueryPrefetcher struct {
    patterns map[string][]string // query pattern -> likely next fields
    loader   *OptimizedDataLoader
}

func (p *QueryPrefetcher) extractPattern(query string) string {
    return query
}

func (p *QueryPrefetcher) extractIDs(result any, nextFields []string) []string {
    return nil
}

func (p *QueryPrefetcher) extractRequestedFields(query string) []string {
    return nil
}

func (p *QueryPrefetcher) Prefetch(ctx context.Context, query string, result any) {
    pattern := p.extractPattern(query)

    if nextFields, ok := p.patterns[pattern]; ok {
        // Extract IDs from result that might be needed
        ids := p.extractIDs(result, nextFields)

        // Prefetch in background
        go func() {
            for _, id := range ids {
                p.loader.Load(ctx, id)
            }
        }()
    }
}

func (p *QueryPrefetcher) LearnPattern(query string, followUpQuery string) {
    pattern := p.extractPattern(query)
    fields := p.extractRequestedFields(followUpQuery)

    p.patterns[pattern] = append(p.patterns[pattern], fields...)
}
```

### Junior -> FAANG: What to Learn From Each Case Study

GitHub's case study is the most important for interview preparation. The node-based complexity model (each field costs 1, list fields multiply by their `first`/`last` argument, cap at 5000 nodes) is the reference implementation that senior engineers cite when discussing complexity limiting. Understand it well enough to implement the core algorithm from memory: recursive AST walk, multiply child complexity by pagination argument, cap at the limit and return an error before execution.

The key GitHub insight for junior engineers: rate limiting by query cost rather than request count is more fair. A client who requests 10 nodes in one query should not be charged the same as a client who requests 5000 nodes in one query.

Shopify's case study introduces federation concepts. The important pattern: the `_entities` query lets one subgraph resolve a reference to a type owned by another subgraph. This is how cross-service relationships work in a federated graph without tight coupling between services.

Netflix's case study demonstrates the two-level cache pattern for APQ: local in-process LRU for the fastest path, Redis for shared state across instances. This two-level pattern is reusable for any shared lookup (feature flags, user permissions, rate limit counters) where the data changes slowly relative to request frequency.

### Senior @ FAANG: Platform Patterns Abstracted From the Case Studies

These case studies collectively describe three platform capabilities that every large-scale GraphQL deployment needs.

**Capability 1: request cost governance.** GitHub's complexity model and rate limiting by complexity points is the mature form of this capability. The less mature form is `FixedComplexityLimit` with a flat number and hope. The mature form requires: a per-field cost annotation system (some fields are cheap, some are expensive), a cost computation algorithm that accounts for pagination multipliers and fragment spreading, a per-user (or per-token) rate limit bucket that is charged by cost rather than request count, and rate limit headers in the response so clients can implement adaptive backoff. Building this as a gateway plugin rather than per-service logic ensures consistent enforcement.

**Capability 2: schema composition and service mesh integration.** Shopify's federation gateway is the reference architecture for multi-service GraphQL. The production requirements beyond what the case study shows: the gateway must handle subgraph unavailability gracefully (return partial results with errors for the unavailable subgraph's fields rather than returning a 503 for the entire operation), must support canary deployments of individual subgraphs (the gateway routes a percentage of traffic to the new subgraph version and compares response shapes), and must provide a schema explorer that shows which subgraph owns which type and field (for on-call debugging and schema governance).

**Capability 3: multi-layer caching for read-heavy workloads.** Netflix's two-level cache (local LRU plus Redis) plus APQ is the production pattern for reducing query overhead on read-heavy public-facing APIs. Extended to a full read-optimization strategy: APQ gives CDN-cacheability for GET-form queries, the local LRU eliminates Redis round trips for the most popular queries within each instance, and a distributed cache (Redis or Memcached) handles the long tail. For subscription-heavy workloads, the caching strategy shifts entirely: subscriptions cannot be cached, so the optimization target is minimizing the per-event fan-out cost rather than reducing query parsing overhead.

---
