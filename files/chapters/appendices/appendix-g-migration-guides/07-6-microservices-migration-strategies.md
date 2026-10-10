## 6. Microservices Migration Strategies

### 6.1 Strangler Fig Pattern

**Overview**: Gradually replace old system by routing traffic to new services.

```
┌─────────────────────────────────────────────┐
│         Load Balancer / API Gateway         │
└──────────┬──────────────────────────┬───────┘
           │                          │
           v                          v
   ┌───────────────┐          ┌─────────────┐
   │  Old Monolith │          │  New Go     │
   │  (Python)     │          │  Service    │
   └───────────────┘          └─────────────┘
        80% traffic               20% traffic
```

**Implementation**:
```go
// Proxy that routes traffic based on feature flags
package main

import (
    "math/rand/v2"
    "net/http"
    "net/http/httputil"
    "net/url"
)

type ServiceRouter struct {
    oldBackend *httputil.ReverseProxy
    newBackend *httputil.ReverseProxy
    rollout    int // Percentage to new service
}

func NewServiceRouter(oldURL, newURL string, rollout int) *ServiceRouter {
    oldTarget, _ := url.Parse(oldURL)
    newTarget, _ := url.Parse(newURL)

    return &ServiceRouter{
        oldBackend: httputil.NewSingleHostReverseProxy(oldTarget),
        newBackend: httputil.NewSingleHostReverseProxy(newTarget),
        rollout:    rollout,
    }
}

func (s *ServiceRouter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    // Route based on user ID hash, session, or random
    if shouldUseNewService(r, s.rollout) {
        s.newBackend.ServeHTTP(w, r)
    } else {
        s.oldBackend.ServeHTTP(w, r)
    }
}

func shouldUseNewService(r *http.Request, rollout int) bool {
    // Simple percentage-based routing
    // In production, use consistent hashing based on user ID
    return rand.IntN(100) < rollout
}

func main() {
    router := NewServiceRouter(
        "http://localhost:8000", // Old Python service
        "http://localhost:8001", // New Go service
        20,                       // 20% rollout
    )

    http.ListenAndServe(":8080", router)
}
```

### 6.2 Service-by-Service Migration

**Step 1: Identify Service Boundaries**
```go
// Analyze existing monolith
type ServiceAnalysis struct {
    Name         string
    Dependencies []string
    Complexity   int    // Lines of code, cyclomatic complexity
    Traffic      int    // Requests per second
    CanMigrate   bool
    Risk         string // Low, Medium, High
}

// Example services to migrate
services := []ServiceAnalysis{
    {
        Name:         "user-service",
        Dependencies: []string{"database"},
        Complexity:   500,
        Traffic:      100,
        CanMigrate:   true,
        Risk:         "Low",
    },
    {
        Name:         "payment-service",
        Dependencies: []string{"user-service", "notification-service", "stripe-api"},
        Complexity:   2000,
        Traffic:      50,
        CanMigrate:   true,
        Risk:         "High", // Handles money!
    },
}
```

**Step 2: Extract Service**
```go
// Before: Monolith with embedded user logic
// After: Standalone user service

package main

import (
    "context"
    "database/sql"

    "github.com/gin-gonic/gin"
    _ "github.com/lib/pq"
)

// Service struct
type UserService struct {
    db     *sql.DB
    cache  Cache
    logger Logger
}

// API endpoints
func (s *UserService) RegisterRoutes(r *gin.Engine) {
    users := r.Group("/api/v1/users")
    {
        users.GET("/:id", s.getUser)
        users.POST("", s.createUser)
        users.PUT("/:id", s.updateUser)
        users.DELETE("/:id", s.deleteUser)
    }
}

// Health check for service mesh
func (s *UserService) healthCheck(c *gin.Context) {
    // Check database
    if err := s.db.PingContext(c.Request.Context()); err != nil {
        c.JSON(503, gin.H{"status": "unhealthy", "error": err.Error()})
        return
    }

    // Check cache
    if err := s.cache.Ping(); err != nil {
        c.JSON(503, gin.H{"status": "degraded", "error": err.Error()})
        return
    }

    c.JSON(200, gin.H{"status": "healthy"})
}

func main() {
    // Database connection
    db, err := sql.Open("postgres", "...")
    if err != nil {
        panic(err)
    }

    // Initialize service
    service := &UserService{
        db:     db,
        cache:  NewRedisCache("localhost:6379"),
        logger: NewStructuredLogger(),
    }

    router := gin.Default()
    router.GET("/health", service.healthCheck)
    service.RegisterRoutes(router)

    router.Run(":8080")
}
```

**Step 3: Dual-Write Pattern**
```go
// Write to both old and new systems during migration
type DualWriteUserRepository struct {
    oldRepo UserRepository // Legacy system
    newRepo UserRepository // New Go service
    logger  Logger
}

func (d *DualWriteUserRepository) Create(ctx context.Context, user *User) error {
    // Write to new system first
    if err := d.newRepo.Create(ctx, user); err != nil {
        d.logger.Error("new repo create failed", "error", err)
        return d.oldRepo.Create(ctx, user) // Fallback to old
    }

    // Write to old system asynchronously
    go func() {
        if err := d.oldRepo.Create(context.Background(), user); err != nil {
            d.logger.Error("old repo create failed", "error", err)
            // Alert for manual sync
        }
    }()

    return nil
}

func (d *DualWriteUserRepository) Read(ctx context.Context, id int) (*User, error) {
    // Read from new system, fallback to old
    user, err := d.newRepo.Read(ctx, id)
    if err == nil {
        return user, nil
    }

    d.logger.Warn("new repo read failed, using old", "error", err)
    return d.oldRepo.Read(ctx, id)
}
```

### 6.3 Shared Data Handling

**Anti-Pattern: Shared Database**
```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Service A  │  │  Service B  │  │  Service C  │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┼────────────────┘
                        v
                ┌───────────────┐
                │ Shared DB     │
                └───────────────┘
```

**Better: Database per Service**
```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Service A  │  │  Service B  │  │  Service C  │
│     +DB     │  │     +DB     │  │     +DB     │
└──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                │
       └────────────────┼────────────────┘
                        v
                ┌───────────────┐
                │  Event Bus    │
                └───────────────┘
```

**Implementation: Saga Pattern**
```go
package main

import (
    "context"
    "fmt"
)

// Saga coordinator
type OrderSaga struct {
    orderService    *OrderService
    inventoryService *InventoryService
    paymentService  *PaymentService
}

type SagaStep struct {
    Name     string
    Execute  func(context.Context) error
    Rollback func(context.Context) error
}

func (s *OrderSaga) CreateOrder(ctx context.Context, order *Order) error {
    steps := []SagaStep{
        {
            Name: "reserve-inventory",
            Execute: func(ctx context.Context) error {
                return s.inventoryService.Reserve(ctx, order.Items)
            },
            Rollback: func(ctx context.Context) error {
                return s.inventoryService.Release(ctx, order.Items)
            },
        },
        {
            Name: "process-payment",
            Execute: func(ctx context.Context) error {
                return s.paymentService.Charge(ctx, order.Total)
            },
            Rollback: func(ctx context.Context) error {
                return s.paymentService.Refund(ctx, order.Total)
            },
        },
        {
            Name: "create-order",
            Execute: func(ctx context.Context) error {
                return s.orderService.Create(ctx, order)
            },
            Rollback: func(ctx context.Context) error {
                return s.orderService.Cancel(ctx, order.ID)
            },
        },
    }

    // Execute steps
    var executedSteps []SagaStep
    for _, step := range steps {
        if err := step.Execute(ctx); err != nil {
            // Rollback executed steps in reverse order
            for i := len(executedSteps) - 1; i >= 0; i-- {
                if rbErr := executedSteps[i].Rollback(ctx); rbErr != nil {
                    // Log compensation failure
                    fmt.Printf("Rollback failed for %s: %v\n",
                        executedSteps[i].Name, rbErr)
                }
            }
            return fmt.Errorf("saga step %s failed: %w", step.Name, err)
        }
        executedSteps = append(executedSteps, step)
    }

    return nil
}
```

### 6.4 API Compatibility

**Versioning Strategy**:
```go
// v1 API (legacy)
type UserV1 struct {
    ID    int    `json:"id"`
    Name  string `json:"name"`
    Email string `json:"email"`
}

// v2 API (new)
type UserV2 struct {
    ID        int       `json:"id"`
    FirstName string    `json:"first_name"`
    LastName  string    `json:"last_name"`
    Email     string    `json:"email"`
    CreatedAt time.Time `json:"created_at"`
}

// Adapter converts between versions
func (u *UserV2) ToV1() UserV1 {
    return UserV1{
        ID:    u.ID,
        Name:  u.FirstName + " " + u.LastName,
        Email: u.Email,
    }
}

// Router handles both versions
func setupVersionedAPI(router *gin.Engine, service *UserService) {
    // v1 API (maintain compatibility)
    v1 := router.Group("/api/v1")
    {
        v1.GET("/users/:id", func(c *gin.Context) {
            user, err := service.GetUser(c, c.Param("id"))
            if err != nil {
                c.JSON(404, gin.H{"error": "not found"})
                return
            }
            c.JSON(200, user.ToV1()) // Convert to v1 format
        })
    }

    // v2 API (new features)
    v2 := router.Group("/api/v2")
    {
        v2.GET("/users/:id", func(c *gin.Context) {
            user, err := service.GetUser(c, c.Param("id"))
            if err != nil {
                c.JSON(404, gin.H{"error": "not found"})
                return
            }
            c.JSON(200, user) // Native v2 format
        })
    }
}
```

---
