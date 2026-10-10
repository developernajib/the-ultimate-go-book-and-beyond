## Exercises with Complete Solutions

### Exercise 1: Implement Query Complexity Calculator

Build a custom complexity calculator that accounts for pagination and field weights. The calculator walks the parsed AST, assigns a base cost to each field, and multiplies child complexity by pagination arguments like `first` and `last`. Fields with known high cost (search, aggregation) get higher base weights. The calculator is registered as a gqlgen extension that intercepts operations before resolver execution and rejects queries exceeding the threshold.

```go
// Solution: complexity/calculator.go
package complexity

import (
    "context"
    "fmt"
    "strconv"
    "testing"

    "github.com/99designs/gqlgen/graphql"
    "github.com/vektah/gqlparser/v2/ast"
    "github.com/vektah/gqlparser/v2/gqlerror"
)

// FieldWeight defines complexity weights for specific fields
type FieldWeight struct {
    Type  string
    Field string
    Base  int    // Base cost for this field
    Child int    // Multiplier for child fields
}

// Calculator calculates query complexity
type Calculator struct {
    maxComplexity int
    weights       map[string]FieldWeight // "Type.Field" -> weight
    defaultBase   int
    defaultChild  int
}

func NewCalculator(maxComplexity int) *Calculator {
    return &Calculator{
        maxComplexity: maxComplexity,
        weights:       make(map[string]FieldWeight),
        defaultBase:   1,
        defaultChild:  1,
    }
}

// SetWeight sets the complexity weight for a specific field
func (c *Calculator) SetWeight(typeName, fieldName string, base, child int) {
    key := typeName + "." + fieldName
    c.weights[key] = FieldWeight{
        Type:  typeName,
        Field: fieldName,
        Base:  base,
        Child: child,
    }
}

// Calculate returns the complexity of an operation
func (c *Calculator) Calculate(
    ctx context.Context,
    oc *ast.OperationDefinition,
    es graphql.ExecutableSchema,
) (int, error) {
    schema := es.Schema()

    var rootType *ast.Definition
    switch oc.Operation {
    case ast.Query:
        rootType = schema.Query
    case ast.Mutation:
        rootType = schema.Mutation
    case ast.Subscription:
        rootType = schema.Subscription
    }

    if rootType == nil {
        return 0, nil
    }

    complexity := c.calculateSelection(schema, rootType, oc.SelectionSet, 1)

    if complexity > c.maxComplexity {
        return complexity, fmt.Errorf(
            "query complexity %d exceeds maximum %d",
            complexity,
            c.maxComplexity,
        )
    }

    return complexity, nil
}

func (c *Calculator) calculateSelection(
    schema *ast.Schema,
    parentType *ast.Definition,
    selections ast.SelectionSet,
    multiplier int,
) int {
    total := 0

    for _, sel := range selections {
        switch s := sel.(type) {
        case *ast.Field:
            total += c.calculateField(schema, parentType, s, multiplier)

        case *ast.FragmentSpread:
            frag := schema.Fragments[s.Name]
            if frag != nil {
                fragType := schema.Types[frag.TypeCondition]
                if fragType != nil {
                    total += c.calculateSelection(schema, fragType, frag.SelectionSet, multiplier)
                }
            }

        case *ast.InlineFragment:
            fragType := parentType
            if s.TypeCondition != "" {
                fragType = schema.Types[s.TypeCondition]
            }
            if fragType != nil {
                total += c.calculateSelection(schema, fragType, s.SelectionSet, multiplier)
            }
        }
    }

    return total
}

func (c *Calculator) calculateField(
    schema *ast.Schema,
    parentType *ast.Definition,
    field *ast.Field,
    multiplier int,
) int {
    // Get field definition
    fieldDef := parentType.Fields.ForName(field.Name)
    if fieldDef == nil {
        return 0
    }

    // Get weight configuration
    key := parentType.Name + "." + field.Name
    weight, hasWeight := c.weights[key]

    baseCost := c.defaultBase
    childMultiplier := c.defaultChild
    if hasWeight {
        baseCost = weight.Base
        childMultiplier = weight.Child
    }

    // Check for pagination arguments
    paginationMultiplier := 1
    for _, arg := range field.Arguments {
        switch arg.Name {
        case "first", "last", "limit":
            if intVal, ok := arg.Value.Raw.(int64); ok {
                paginationMultiplier = int(intVal)
            } else if strVal, ok := arg.Value.Raw.(string); ok {
                if n, err := strconv.Atoi(strVal); err == nil {
                    paginationMultiplier = n
                }
            }
        }
    }

    // Calculate this field's complexity
    fieldComplexity := baseCost * multiplier

    // Calculate children if any
    if field.SelectionSet != nil {
        // Get the return type
        returnType := schema.Types[getNamedType(fieldDef.Type)]
        if returnType != nil {
            childComplexity := c.calculateSelection(
                schema,
                returnType,
                field.SelectionSet,
                paginationMultiplier * childMultiplier,
            )
            fieldComplexity += childComplexity
        }
    }

    return fieldComplexity
}

func getNamedType(t *ast.Type) string {
    if t.NamedType != "" {
        return t.NamedType
    }
    if t.Elem != nil {
        return getNamedType(t.Elem)
    }
    return ""
}

// Extension wraps the calculator as a gqlgen extension
type ComplexityExtension struct {
    calc *Calculator
}

func NewComplexityExtension(maxComplexity int) *ComplexityExtension {
    calc := NewCalculator(maxComplexity)

    // Configure weights for expensive fields
    calc.SetWeight("Query", "users", 10, 2)
    calc.SetWeight("User", "orders", 5, 3)
    calc.SetWeight("Order", "items", 2, 1)
    calc.SetWeight("Query", "search", 20, 1)

    return &ComplexityExtension{calc: calc}
}

func (e *ComplexityExtension) ExtensionName() string {
    return "ComplexityLimit"
}

func (e *ComplexityExtension) Validate(schema graphql.ExecutableSchema) error {
    return nil
}

func (e *ComplexityExtension) InterceptOperation(
    ctx context.Context,
    next graphql.OperationHandler,
) graphql.ResponseHandler {
    oc := graphql.GetOperationContext(ctx)

    complexity, err := e.calc.Calculate(ctx, oc.Operation, oc.Schema)
    if err != nil {
        return func(ctx context.Context) *graphql.Response {
            return &graphql.Response{
                Errors: gqlerror.List{{
                    Message: err.Error(),
                    Extensions: map[string]any{
                        "code":       "COMPLEXITY_LIMIT_EXCEEDED",
                        "complexity": complexity,
                        "limit":      e.calc.maxComplexity,
                    },
                }},
            }
        }
    }

    // Add complexity to response extensions
    return func(ctx context.Context) *graphql.Response {
        resp := next(ctx)(ctx)
        if resp.Extensions == nil {
            resp.Extensions = make(map[string]any)
        }
        resp.Extensions["complexity"] = complexity
        return resp
    }
}

// Test the calculator
func TestComplexityCalculator(t *testing.T) {
    ext := NewComplexityExtension(100)

    tests := []struct {
        name           string
        query          string
        wantComplexity int
        wantError      bool
    }{
        {
            name: "simple query",
            query: `
                query {
                    me {
                        id
                        name
                    }
                }
            `,
            wantComplexity: 3,
            wantError:      false,
        },
        {
            name: "paginated query",
            query: `
                query {
                    users(first: 10) {
                        id
                        name
                    }
                }
            `,
            wantComplexity: 30, // 10 base + 10 * 2 children
            wantError:      false,
        },
        {
            name: "nested pagination",
            query: `
                query {
                    users(first: 10) {
                        orders(first: 10) {
                            items(first: 5) {
                                id
                            }
                        }
                    }
                }
            `,
            wantComplexity: 310, // Deeply nested
            wantError:      true,
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            // Parse and calculate
            // ... implementation
        })
    }
}
```

### Exercise 2: Build a GraphQL Federation Gateway

Implement a simple federation gateway that routes queries to multiple services. The gateway maintains a registry of services and the types they own. When a query arrives, it parses the operation, groups top-level selections by owning service, builds subqueries for each service, and executes them in parallel when there are no dependencies between them. Results from all services are merged into a single response.

```go
// Solution: federation/gateway.go
package federation

import (
    "context"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "strings"
    "sync"
    "time"

    "github.com/vektah/gqlparser/v2/ast"
    "github.com/vektah/gqlparser/v2/parser"
)

// Service represents a federated GraphQL service
type Service struct {
    Name   string
    URL    string
    Types  []string // Types this service is responsible for
    client *http.Client
}

// Gateway coordinates queries across federated services
type Gateway struct {
    services map[string]*Service
    typeMap  map[string]string // Type name -> service name
    mu       sync.RWMutex
}

func NewGateway() *Gateway {
    return &Gateway{
        services: make(map[string]*Service),
        typeMap:  make(map[string]string),
    }
}

// RegisterService adds a service to the gateway
func (g *Gateway) RegisterService(svc *Service) {
    g.mu.Lock()
    defer g.mu.Unlock()

    svc.client = &http.Client{Timeout: 30 * time.Second}
    g.services[svc.Name] = svc

    for _, typ := range svc.Types {
        g.typeMap[typ] = svc.Name
    }
}

// ExecuteQuery handles incoming GraphQL queries
func (g *Gateway) ExecuteQuery(
    ctx context.Context,
    query string,
    variables map[string]any,
    operationName string,
) (*Response, error) {
    // Parse the query
    doc, err := parser.ParseQuery(&ast.Source{Input: query})
    if err != nil {
        return nil, fmt.Errorf("parsing query: %w", err)
    }

    // Find the operation to execute
    var operation *ast.OperationDefinition
    for _, op := range doc.Operations {
        if operationName == "" || op.Name == operationName {
            operation = op
            break
        }
    }

    if operation == nil {
        return nil, fmt.Errorf("operation not found")
    }

    // Plan the query execution
    plan := g.planQuery(operation)

    // Execute the plan
    return g.executePlan(ctx, plan, variables)
}

// QueryPlan represents the execution plan
type QueryPlan struct {
    Fetch    *FetchNode
    Sequence []*QueryPlan
    Parallel []*QueryPlan
}

type FetchNode struct {
    Service      string
    Query        string
    Variables    []string
    Requires     []string // Fields needed from previous fetches
    Provides     []string // Fields this fetch provides
}

func (g *Gateway) planQuery(operation *ast.OperationDefinition) *QueryPlan {
    g.mu.RLock()
    defer g.mu.RUnlock()

    // Group top-level selections by owning service
    serviceSelections := make(map[string][]ast.Selection)

    for _, sel := range operation.SelectionSet {
        field, ok := sel.(*ast.Field)
        if !ok {
            continue
        }

        // Determine which service owns this field
        service := g.getServiceForField(field)
        serviceSelections[service] = append(serviceSelections[service], sel)
    }

    // Create parallel fetch nodes for independent services
    if len(serviceSelections) == 1 {
        for service, selections := range serviceSelections {
            return &QueryPlan{
                Fetch: &FetchNode{
                    Service: service,
                    Query:   g.buildSubquery(operation.Operation, selections),
                },
            }
        }
    }

    // Multiple services - execute in parallel
    plan := &QueryPlan{Parallel: make([]*QueryPlan, 0)}

    for service, selections := range serviceSelections {
        plan.Parallel = append(plan.Parallel, &QueryPlan{
            Fetch: &FetchNode{
                Service: service,
                Query:   g.buildSubquery(operation.Operation, selections),
            },
        })
    }

    return plan
}

func (g *Gateway) getServiceForField(field *ast.Field) string {
    // Check if this is a root query field
    for name, svc := range g.services {
        for _, typ := range svc.Types {
            if strings.HasPrefix(field.Name, strings.ToLower(typ)) {
                return name
            }
        }
    }
    return "default"
}

func (g *Gateway) buildSubquery(op ast.Operation, selections []ast.Selection) string {
    var sb strings.Builder

    switch op {
    case ast.Query:
        sb.WriteString("query")
    case ast.Mutation:
        sb.WriteString("mutation")
    }

    sb.WriteString(" { ")

    for _, sel := range selections {
        g.printSelection(&sb, sel)
    }

    sb.WriteString(" }")

    return sb.String()
}

func printValue(v *ast.Value) string {
    if v == nil {
        return "null"
    }
    return v.Raw
}

func (g *Gateway) printSelection(sb *strings.Builder, sel ast.Selection) {
    switch s := sel.(type) {
    case *ast.Field:
        if s.Alias != "" {
            sb.WriteString(s.Alias)
            sb.WriteString(": ")
        }
        sb.WriteString(s.Name)

        if len(s.Arguments) > 0 {
            sb.WriteString("(")
            for i, arg := range s.Arguments {
                if i > 0 {
                    sb.WriteString(", ")
                }
                sb.WriteString(arg.Name)
                sb.WriteString(": ")
                sb.WriteString(printValue(arg.Value))
            }
            sb.WriteString(")")
        }

        if s.SelectionSet != nil {
            sb.WriteString(" { ")
            for _, subSel := range s.SelectionSet {
                g.printSelection(sb, subSel)
                sb.WriteString(" ")
            }
            sb.WriteString("}")
        }
    }
}

type Response struct {
    Data   map[string]any `json:"data,omitempty"`
    Errors []GraphQLError         `json:"errors,omitempty"`
}

type GraphQLError struct {
    Message string `json:"message"`
}

func (g *Gateway) executePlan(
    ctx context.Context,
    plan *QueryPlan,
    variables map[string]any,
) (*Response, error) {
    result := &Response{Data: make(map[string]any)}

    if plan.Fetch != nil {
        // Single fetch
        data, err := g.executeRemoteQuery(ctx, plan.Fetch, variables)
        if err != nil {
            result.Errors = append(result.Errors, GraphQLError{Message: err.Error()})
        } else {
            g.mergeData(result.Data, data)
        }
        return result, nil
    }

    if len(plan.Parallel) > 0 {
        // Execute in parallel
        var wg sync.WaitGroup
        var mu sync.Mutex

        for _, subPlan := range plan.Parallel {
            wg.Add(1)
            go func(p *QueryPlan) {
                defer wg.Done()

                subResult, err := g.executePlan(ctx, p, variables)

                mu.Lock()
                if err != nil {
                    result.Errors = append(result.Errors, GraphQLError{Message: err.Error()})
                } else {
                    g.mergeData(result.Data, subResult.Data)
                    result.Errors = append(result.Errors, subResult.Errors...)
                }
                mu.Unlock()
            }(subPlan)
        }

        wg.Wait()
    }

    if len(plan.Sequence) > 0 {
        // Execute in sequence
        for _, subPlan := range plan.Sequence {
            subResult, err := g.executePlan(ctx, subPlan, variables)
            if err != nil {
                result.Errors = append(result.Errors, GraphQLError{Message: err.Error()})
                continue
            }
            g.mergeData(result.Data, subResult.Data)
            result.Errors = append(result.Errors, subResult.Errors...)
        }
    }

    return result, nil
}

func (g *Gateway) executeRemoteQuery(
    ctx context.Context,
    fetch *FetchNode,
    variables map[string]any,
) (map[string]any, error) {
    g.mu.RLock()
    svc := g.services[fetch.Service]
    g.mu.RUnlock()

    if svc == nil {
        return nil, fmt.Errorf("service not found: %s", fetch.Service)
    }

    // Build request
    reqBody := map[string]any{
        "query":     fetch.Query,
        "variables": variables,
    }

    bodyBytes, err := json.Marshal(reqBody)
    if err != nil {
        return nil, err
    }

    req, err := http.NewRequestWithContext(ctx, "POST", svc.URL, strings.NewReader(string(bodyBytes)))
    if err != nil {
        return nil, err
    }

    req.Header.Set("Content-Type", "application/json")

    resp, err := svc.client.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    body, err := io.ReadAll(resp.Body)
    if err != nil {
        return nil, err
    }

    var result struct {
        Data   map[string]any `json:"data"`
        Errors []GraphQLError         `json:"errors"`
    }

    if err := json.Unmarshal(body, &result); err != nil {
        return nil, err
    }

    if len(result.Errors) > 0 {
        return result.Data, fmt.Errorf("service error: %s", result.Errors[0].Message)
    }

    return result.Data, nil
}

func (g *Gateway) mergeData(target, source map[string]any) {
    for k, v := range source {
        target[k] = v
    }
}

// HTTP Handler
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    if r.Method != "POST" {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }

    var req struct {
        Query         string                 `json:"query"`
        Variables     map[string]any `json:"variables"`
        OperationName string                 `json:"operationName"`
    }

    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid request", http.StatusBadRequest)
        return
    }

    result, err := g.ExecuteQuery(r.Context(), req.Query, req.Variables, req.OperationName)
    if err != nil {
        result = &Response{
            Errors: []GraphQLError{{Message: err.Error()}},
        }
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(result)
}

// Usage example
func main() {
    gateway := NewGateway()

    // Register services
    gateway.RegisterService(&Service{
        Name:  "users",
        URL:   "http://users-service:8080/graphql",
        Types: []string{"User", "Profile"},
    })

    gateway.RegisterService(&Service{
        Name:  "products",
        URL:   "http://products-service:8080/graphql",
        Types: []string{"Product", "Category"},
    })

    gateway.RegisterService(&Service{
        Name:  "orders",
        URL:   "http://orders-service:8080/graphql",
        Types: []string{"Order", "OrderItem"},
    })

    http.Handle("/graphql", gateway)
    http.ListenAndServe(":8080", nil)
}
```

### Junior -> FAANG: Getting the Most From These Exercises

Exercise 1 (complexity calculator) is worth doing in full, including the test suite. The recursive AST walk is a common interview problem variant: "given a tree structure, compute a weighted score." Practice until you can write the core `calculateSelection` function without references. The pagination multiplier logic (reading `first`/`last` argument values from the AST node) is the part that trips up most implementations.

Exercise 2 (federation gateway) is the more advanced exercise. For a junior engineer, the valuable part is not the complete implementation but understanding the query planning step: how do you determine which fields belong to which service, and how do you build a subquery that contains only the selections owned by that service? Work through the `planQuery` function manually with a concrete example before reading the solution.

Both exercises have testing gaps to fill. Exercise 1's `TestComplexityCalculator` has stubs that need implementation. Write real assertions: parse the query string, run the calculator, assert on the returned complexity value and whether an error was returned. This is where the learning happens.

### Senior @ FAANG: Production-Hardening These Exercises

**Exercise 1: complexity calculator in production.** The implementation here uses a static field weight map (`calc.SetWeight("Query", "users", 10, 2)`). In production, these weights need to be calibrated against actual resolver latency data. A field whose P99 resolver time is 500ms should cost more than a field whose P99 is 1ms. The calibration process: instrument all resolvers with latency metrics for one week, compute relative cost ratios, update the weight configuration, and deploy. The weight configuration should be hot-reloadable (stored in a config file or a database) without a service restart, because recalibrating weights requires iteration.

**Exercise 2: federation gateway in production.** The `executeRemoteQuery` function has no circuit breaker. If a subgraph is slow or down, the gateway goroutine hangs until the `http.Client` timeout fires (30 seconds in the example). With multiple slow subgraphs, the gateway exhausts its goroutine pool. The production fix: wrap each subgraph client with a circuit breaker (using a library like `sony/gobreaker` or `afex/hystrix-go`). When a subgraph trips its circuit breaker (after N consecutive failures within a window), subsequent requests to that subgraph are rejected immediately with a service-unavailable error, and the gateway returns partial results for fields owned by the available subgraphs. Document this behavior in the API contract so clients know that partial results are possible and how to detect which subgraph failed (via the field path in the errors array).

---
