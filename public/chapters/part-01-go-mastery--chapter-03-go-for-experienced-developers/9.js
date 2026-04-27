export default `## 3.8 Migration Guide: From Other Languages

### Migrating from Java

**Java patterns to unlearn:**

| Java Pattern | Go Alternative |
|-------------|----------------|
| \`class\` with inheritance | \`struct\` with composition |
| \`interface\` with explicit implements | Implicit interface satisfaction |
| \`getX()/setX()\` | Exported fields or methods |
| \`try-catch-finally\` | \`if err != nil\` + \`defer\` |
| Generics everywhere | Use generics sparingly (Go 1.18+) |
| Dependency injection frameworks | Manual dependency injection |
| \`synchronized\` blocks | \`sync.Mutex\` or channels |
| Thread pools | Goroutines (no pools needed usually) |

The following example rewrites a typical Spring-style Java service in idiomatic Go. Notice how dependency injection is done through constructor parameters rather than annotation-driven frameworks, and how error handling replaces exceptions:

\`\`\`java
// Java
public class UserService {
    private final UserRepository repository;
    private final EmailService emailService;

    @Autowired
    public UserService(UserRepository repository, EmailService emailService) {
        this.repository = repository;
        this.emailService = emailService;
    }

    public User createUser(CreateUserRequest request) throws ValidationException {
        if (request.getEmail() == null) {
            throw new ValidationException("email is required");
        }
        User user = new User(request.getName(), request.getEmail());
        repository.save(user);
        emailService.sendWelcome(user);
        return user;
    }
}
\`\`\`

\`\`\`go
// Go equivalent
type UserService struct {
    repo   UserRepository  // Interface
    mailer EmailService    // Interface
}

func NewUserService(repo UserRepository, mailer EmailService) *UserService {
    return &UserService{repo: repo, mailer: mailer}
}

func (s *UserService) CreateUser(ctx context.Context, req CreateUserRequest) (*User, error) {
    if req.Email == "" {
        return nil, &ValidationError{Field: "email", Message: "is required"}
    }

    user := &User{Name: req.Name, Email: req.Email}

    if err := s.repo.Save(ctx, user); err != nil {
        return nil, fmt.Errorf("saving user: %w", err)
    }

    if err := s.mailer.SendWelcome(ctx, user); err != nil {
        // Log but don't fail - email is non-critical
        log.Printf("failed to send welcome email: %v", err)
    }

    return user, nil
}
\`\`\`

### How Uber Migrated from Java to Go

Uber's engineering blog documents their Java to Go migration:

**Key learnings:**

1. **Do not translate line-by-line**: Go idioms differ from Java. Rewrite, do not translate.

2. **Reduce abstraction layers**: Java's AbstractFactoryFactory patterns do not translate. Go prefers simple, direct code.

3. **Embrace the standard library**: Go's \`net/http\`, \`encoding/json\`, \`database/sql\` are production-ready. You do not need a Spring equivalent.

4. **Tests are simpler**: No TestNG, JUnit, Mockito. Go's \`testing\` package + interfaces for mocking.

Uber uses their \`fx\` dependency injection framework to wire services together. This template shows how a typical Uber Go service bootstraps:

\`\`\`go
// Uber's service template
package main

import (
    "context"
    "net/http"

    "go.uber.org/fx"
    "go.uber.org/zap"
)

func main() {
    fx.New(
        fx.Provide(
            NewConfig,
            NewLogger,
            NewDatabase,
            NewUserService,
            NewHTTPServer,
        ),
        fx.Invoke(StartServer),
    ).Run()
}

func NewLogger() (*zap.Logger, error) {
    return zap.NewProduction()
}

func NewHTTPServer(userService *UserService, logger *zap.Logger) *http.Server {
    mux := http.NewServeMux()
    mux.HandleFunc("/users", userService.HandleCreateUser)
    return &http.Server{
        Addr:    ":8080",
        Handler: mux,
    }
}
\`\`\`

### Migrating from Python

**Python patterns to unlearn:**

| Python Pattern | Go Alternative |
|---------------|----------------|
| Duck typing everywhere | Explicit interfaces where needed |
| \`try-except\` | \`if err != nil\` |
| Decorators | Middleware functions or functional options |
| \`*args, **kwargs\` | Variadic args, functional options |
| List comprehensions | Explicit for loops |
| Classes with \`__init__\` | Struct with NewXxx factory |
| \`async/await\` | Goroutines + channels |

This side-by-side comparison translates a Python async service with caching into Go. The Go version replaces Python's \`async/await\` with synchronous code (Go handles concurrency at the goroutine level, not the function level) and uses explicit error returns instead of exceptions:

\`\`\`python
# Python
import asyncio
from dataclasses import dataclass
from typing import Optional

@dataclass
class User:
    id: int
    name: str
    email: str

class UserService:
    def __init__(self, db, cache):
        self.db = db
        self.cache = cache

    async def get_user(self, user_id: int) -> Optional[User]:
        # Try cache first
        cached = await self.cache.get(f"user:{user_id}")
        if cached:
            return User(**cached)

        # Fetch from database
        row = await self.db.fetch_one(
            "SELECT * FROM users WHERE id = \$1",
            user_id
        )
        if not row:
            return None

        user = User(**row)
        await self.cache.set(f"user:{user_id}", user.__dict__)
        return user
\`\`\`

\`\`\`go
// Go equivalent
type User struct {
    ID    int    \`json:"id" db:"id"\`
    Name  string \`json:"name" db:"name"\`
    Email string \`json:"email" db:"email"\`
}

type UserService struct {
    db    *sql.DB
    cache *redis.Client
}

func NewUserService(db *sql.DB, cache *redis.Client) *UserService {
    return &UserService{db: db, cache: cache}
}

func (s *UserService) GetUser(ctx context.Context, userID int) (*User, error) {
    // Try cache first
    key := fmt.Sprintf("user:%d", userID)
    cached, err := s.cache.Get(ctx, key).Result()
    if err == nil {
        var user User
        if err := json.Unmarshal([]byte(cached), &user); err == nil {
            return &user, nil
        }
    }

    // Fetch from database
    var user User
    err = s.db.QueryRowContext(ctx,
        "SELECT id, name, email FROM users WHERE id = \$1",
        userID,
    ).Scan(&user.ID, &user.Name, &user.Email)

    if err == sql.ErrNoRows {
        return nil, nil  // Not found, not an error
    }
    if err != nil {
        return nil, fmt.Errorf("querying user: %w", err)
    }

    // Cache the result
    data, _ := json.Marshal(user)
    s.cache.Set(ctx, key, data, time.Hour)

    return &user, nil
}
\`\`\`

### How Cloudflare Migrated from Python to Go

Cloudflare's engineering blog discusses their migration:

**Performance gains:**
- Request handling: 10x throughput improvement
- Memory usage: 80% reduction
- Startup time: 50ms vs 5 seconds for Python

**Migration strategy:**
1. **Identify hot paths**: Profile Python services to find bottlenecks
2. **Write new services in Go**: Don't rewrite working Python code
3. **Replace incrementally**: Use Go for new features, gradually replace Python
4. **Keep Python for scripts**: Data analysis, one-off tasks stay in Python

### Migrating from Node.js/JavaScript

**JavaScript patterns to unlearn:**

| JavaScript Pattern | Go Alternative |
|-------------------|----------------|
| \`Promise.all()\` | \`errgroup.Group\` |
| \`async/await\` | Goroutines + channels |
| Callbacks | Return values |
| \`null\`/\`undefined\` | Zero values + nil |
| npm ecosystem | Go modules |
| Express middleware | http.Handler wrapping |
| Dynamic typing | Static typing |

This example converts a Node.js aggregation endpoint to Go. The JavaScript version uses \`Promise.all()\` for concurrent fetches. The Go version uses \`errgroup.Group\`, which provides the same fan-out pattern with context cancellation and typed error propagation:

\`\`\`javascript
// Node.js
const express = require('express');
const axios = require('axios');

const app = express();

app.get('/aggregate', async (req, res) => {
    try {
        const [users, products, orders] = await Promise.all([
            axios.get('http://users-service/api/users'),
            axios.get('http://products-service/api/products'),
            axios.get('http://orders-service/api/orders'),
        ]);

        res.json({
            users: users.data,
            products: products.data,
            orders: orders.data,
        });
    } catch (err) {
        console.error('Aggregation failed:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.listen(3000);
\`\`\`

\`\`\`go
// Go equivalent
package main

import (
    "context"
    "encoding/json"
    "net/http"
    "time"

    "golang.org/x/sync/errgroup"
)

type AggregatedData struct {
    Users    []User    \`json:"users"\`
    Products []Product \`json:"products"\`
    Orders   []Order   \`json:"orders"\`
}

func aggregateHandler(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    var data AggregatedData
    g, ctx := errgroup.WithContext(ctx)

    g.Go(func() error {
        users, err := fetchUsers(ctx)
        if err != nil {
            return fmt.Errorf("fetching users: %w", err)
        }
        data.Users = users
        return nil
    })

    g.Go(func() error {
        products, err := fetchProducts(ctx)
        if err != nil {
            return fmt.Errorf("fetching products: %w", err)
        }
        data.Products = products
        return nil
    })

    g.Go(func() error {
        orders, err := fetchOrders(ctx)
        if err != nil {
            return fmt.Errorf("fetching orders: %w", err)
        }
        data.Orders = orders
        return nil
    })

    if err := g.Wait(); err != nil {
        log.Printf("aggregation failed: %v", err)
        http.Error(w, "Internal server error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(data)
}

func main() {
    http.HandleFunc("/aggregate", aggregateHandler)
    log.Fatal(http.ListenAndServe(":3000", nil))
}
\`\`\`

### Migration Economics: When Is the Rewrite Worth It?

For a senior engineer evaluating a Go migration proposal, the syntax mapping above is the easy part. The hard part is deciding which services to migrate and in what order. Three rules from teams that have done this at scale:

1. **Migrate I/O-bound services first.** A Python or Node service that spends 80% of its time waiting on a database or downstream HTTP call sees an outsized win from Go's goroutines and lower per-request memory. A CPU-bound service (image processing, ML scoring, numerical work) sees less of a win because Go's CPU performance is comparable to the JVM and worse than Rust or C++ for tight numerical loops.
2. **Do not migrate services that work.** A Python service that handles 100 RPS with no operational pain has no migration ROI. The engineering cost (rewrite, retest, redeploy, retrain on-call) is real and the operational gain is zero. The right time to migrate is when a service is hitting a wall (memory, latency, deployment image size, GIL contention) that Go would solve.
3. **Sequence the migration to deliver value early.** A multi-quarter "rewrite the platform in Go" project that ships nothing for six months will lose org sponsorship before it lands. The right shape is a sequence of small, individually shippable migrations, each of which reduces operational pain immediately.

The migration economics also have a hidden cost: knowing two languages well across the team. For the duration of the migration, the team is responsible for both the legacy stack and the Go stack, and on-call coverage doubles. Plan for it explicitly, or the migration will stall when the wrong engineer is on call at 3 AM and the runbook is for the wrong language.

### Cross-Language Onboarding Patterns

For a senior engineer running an onboarding programme that mixes engineers from different backgrounds, the patterns differ significantly:

- **Java-to-Go onboarding.** The hardest unlearning is "everything is a class with inheritance". The fastest payoff is showing them the standard library's interface design (\`io.Reader\`, \`io.Writer\`, \`http.Handler\`) and demonstrating that composition with small interfaces does what inheritance hierarchies were doing in Java with less code.
- **Python-to-Go onboarding.** The hardest unlearning is "duck typing means I do not have to think about types". The fastest payoff is showing them the IDE's type-checking and refactoring capabilities, which Python engineers rarely have to the same degree, and the resulting confidence in large-scale changes.
- **Node-to-Go onboarding.** The hardest unlearning is "everything is async/await". The fastest payoff is the goroutine-and-channel mental model for fan-out, which collapses Promise.all-with-timeout-with-error-handling chains into a \`select\` block.
- **C++-to-Go onboarding.** The hardest unlearning is "I have to think about memory allocation everywhere". The fastest payoff is the productivity boost from not having to think about it, with the realisation that the GC pauses are tractable for almost all workloads.
- **Rust-to-Go onboarding.** The hardest unlearning is "the compiler will catch all my concurrency mistakes". The fastest payoff is the developer velocity, but the senior-track caveat is that Go programs can have data races that the compiler will not catch and the engineer needs the discipline to use \`sync.Mutex\` or channels correctly.

### Code-Review Lens (Senior Track)

Three patterns a staff reviewer will spot in a Go PR from an engineer who has just migrated:

1. **Class-shaped Go.** A struct with a \`New\` constructor that returns a pointer, a set of methods that all use pointer receivers, no embedded types, and a corresponding "factory" interface. The pattern is fine for some types but reflexive for engineers from Java. The reviewer asks "could this be a function or a small struct with no methods?".
2. **Try-catch-shaped Go.** A function that wraps every error with \`fmt.Errorf("error: %w", err)\` and uses \`defer\` plus \`recover()\` as a general-purpose exception handler. The reviewer asks "could this propagate the error explicitly and let the caller decide?".
3. **Promise-chain-shaped Go.** A function that uses goroutines plus channels for sequential operations that have no concurrency benefit. The reviewer asks "could this be straight-line synchronous code?". Goroutines are for actual concurrency, not for stylistic familiarity.

### Migration Lens

The migration patterns above are not a complete map. Each language has dozens of patterns that translate to Go in non-obvious ways, and the team's own codebase will have institutional patterns that are nowhere in the standard mapping. The discipline is to write your team's own "from X to Go" cheatsheet as a living document, updated as you encounter new patterns. The cheatsheet is the artifact that survives the migration. The code is the byproduct.

---
`;
