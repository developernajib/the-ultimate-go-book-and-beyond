## Company-Specific Terminology

### Google's Go Terminology

```go
// Terms used in Google's Go codebase and documentation

// "Protobufs" - Protocol Buffers, Google's serialization format
// Commonly used for all service communication at Google
type UserRequest struct {
    // In Go, we use protoc-gen-go to generate these
}

// "Stubby" - Google's internal RPC framework (precursor to gRPC)
// Go services at Google use gRPC, the open-source version

// "Borglet" - Job scheduler terminology
// Go services are scheduled as Borg tasks

// "Golden file testing" - Testing pattern where expected output is stored
// Common in Google's Go testing practices
func TestGolden(t *testing.T) {
    got := myFunction()
    golden := filepath.Join("testdata", t.Name()+".golden")

    if *update {
        os.WriteFile(golden, got, 0644)
        return
    }

    want, _ := os.ReadFile(golden)
    if !bytes.Equal(got, want) {
        t.Errorf("mismatch: got %q, want %q", got, want)
    }
}

// "Flume" - Data pipeline abstraction
// Go implementations use similar patterns
type Pipeline interface {
    Map(func(any) any) Pipeline
    Filter(func(any) bool) Pipeline
    Reduce(func(any, any) any) any
}
```

### Uber's Go Terminology

```go
// Terms from Uber's Go ecosystem

// "fx" - Uber's dependency injection framework
// Used extensively in Uber's Go services
import "go.uber.org/fx"

func main() {
    fx.New(
        fx.Provide(NewDatabase),
        fx.Provide(NewHTTPServer),
        fx.Invoke(StartServer),
    ).Run()
}

// "zap" - Uber's structured logging library
// "Sugared logger" vs "Core logger"
logger, _ := zap.NewProduction()
sugar := logger.Sugar() // More ergonomic but slower

// "Cadence" / "Temporal" - Workflow orchestration
// Originally developed at Uber
type Workflow interface {
    Execute(ctx workflow.Context, input Input) (Output, error)
}

// "Ring pop" - Consistent hashing membership protocol
// Used for distributed services

// "H3" - Hexagonal hierarchical geospatial indexing
// Used for location-based services
```

### Netflix's Go Terminology

```go
// Terms from Netflix's engineering practices

// "Chaos Monkey" - Failure injection for resilience testing
type ChaosMonkey interface {
    InjectFailure(target string) error
    TerminateInstance(instanceID string) error
}

// "Circuit Breaker" - Pattern popularized by Netflix's Hystrix
// States: Closed -> Open -> Half-Open
type CircuitState int

const (
    Closed CircuitState = iota
    Open
    HalfOpen
)

// "Zuul" - API Gateway / Edge Service
// Go implementations follow similar patterns
type GatewayFilter interface {
    Pre(ctx context.Context, req *Request) error
    Route(ctx context.Context, req *Request) (*Response, error)
    Post(ctx context.Context, req *Request, resp *Response) error
}

// "Eureka" - Service Discovery
// Go services register with Eureka-like systems
type ServiceRegistry interface {
    Register(service *ServiceInstance) error
    Deregister(serviceID string) error
    GetInstances(serviceName string) ([]*ServiceInstance, error)
}

// "EVCache" - Distributed caching layer
// Memcached-based, Go clients available
```

### Stripe's Go Terminology

```go
// Terms from Stripe's API and infrastructure

// "Idempotency Key" - Unique key for safe retries
// Stripe's approach to exactly-once semantics
type Request struct {
    IdempotencyKey string `header:"Idempotency-Key"`
    // ...
}

// "Expand" - API parameter to include related objects
// Reduces N+1 queries
type ListParams struct {
    Expand []string `form:"expand"`
}

// "API Version" - Stripe's versioning approach
// Each version is a snapshot of the API
const (
    APIVersion20231201 = "2023-12-01"
    APIVersion20240101 = "2024-01-01"
)

// "Webhook" - Event notifications
type WebhookEvent struct {
    ID      string          `json:"id"`
    Type    string          `json:"type"`
    Data    json.RawMessage `json:"data"`
    Created int64           `json:"created"`
}

// "Connect" - Stripe's platform for marketplaces
// Multi-tenant payment processing
type ConnectedAccount struct {
    ID            string `json:"id"`
    BusinessType  string `json:"business_type"`
    ChargesEnabled bool  `json:"charges_enabled"`
}
```

### Industry-Wide Go Terminology

| Term | Meaning | Used By |
|------|---------|---------|
| **Goroutine** | Lightweight thread | All Go code |
| **Channel** | Communication primitive | All Go code |
| **Interface** | Behavioral contract | All Go code |
| **Embedding** | Composition mechanism | All Go code |
| **Zero value** | Default initialization | All Go code |
| **Blank identifier** | `_` for discarding | All Go code |
| **Receiver** | Method's bound type | All Go code |
| **Variadic** | `...` for variable args | All Go code |
| **Deferred** | `defer` for cleanup | All Go code |
| **Panic/Recover** | Exception mechanism | All Go code |

---

---

## Conclusion

For deeper explanations of these terms, refer to the corresponding chapters in the main text. Use this glossary as a quick reference while reading code or reviewing unfamiliar concepts.

---

| [◀ Appendix G: Migration Guides](../appendix-g-migration-guides/00-introduction.md) | [Appendix H: Comprehensive Glossary](00-introduction.md) | [Appendix I: Recommended Resources](../appendix-i-resources/00-introduction.md) ▶ |
| :--- | :---: | ---: |
