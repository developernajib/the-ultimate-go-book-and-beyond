export default `## Exercises

### Exercise 1: Mental Shift Practice

Take a small Java or Python class you've written and redesign it in Go using struct + interface. Focus on what the type can do rather than what it is.

**Solution:**

\`\`\`python
# Original Python
class ShoppingCart:
    def __init__(self):
        self._items = []
        self._discount = 0

    def add_item(self, item, quantity):
        self._items.append({"item": item, "qty": quantity})

    def apply_discount(self, percent):
        self._discount = percent

    def total(self):
        subtotal = sum(i["item"].price * i["qty"] for i in self._items)
        return subtotal * (1 - self._discount / 100)
\`\`\`

\`\`\`go
// Go version
type Item interface {
    Price() float64
}

type CartItem struct {
    Item     Item
    Quantity int
}

type ShoppingCart struct {
    items    []CartItem
    discount float64
}

func (c *ShoppingCart) AddItem(item Item, qty int) {
    c.items = append(c.items, CartItem{Item: item, Quantity: qty})
}

func (c *ShoppingCart) ApplyDiscount(percent float64) {
    c.discount = percent
}

func (c *ShoppingCart) Total() float64 {
    var subtotal float64
    for _, ci := range c.items {
        subtotal += ci.Item.Price() * float64(ci.Quantity)
    }
    return subtotal * (1 - c.discount/100)
}
\`\`\`

### Exercise 2: Package Organization

Create a small project with three packages that would create a circular import if done wrong. Solve the circular import using interfaces.

**Solution:**

\`\`\`
// Problem: user needs notification, notification needs user
// Solution: Use interfaces

// pkg/types/types.go
package types

type User struct {
    ID    int
    Email string
    Name  string
}

// pkg/notification/notification.go
package notification

import "context"

type UserFinder interface {
    GetUser(ctx context.Context, id int) (*types.User, error)
}

type Service struct {
    users UserFinder
}

func New(users UserFinder) *Service {
    return &Service{users: users}
}

func (s *Service) NotifyUser(ctx context.Context, userID int, msg string) error {
    user, err := s.users.GetUser(ctx, userID)
    if err != nil {
        return err
    }
    // Send notification to user.Email
    return nil
}

// pkg/user/user.go
package user

import "context"

type Service struct {
    // db, etc.
}

func (s *Service) GetUser(ctx context.Context, id int) (*types.User, error) {
    // Query database
    return &types.User{ID: id, Email: "test@example.com"}, nil
}

// main.go - wire everything together
func main() {
    userService := &user.Service{}
    notificationService := notification.New(userService)  // Satisfies UserFinder
}
\`\`\`

### Exercise 3: Error Handling

Write a function that opens a file, reads its contents, and parses JSON. Handle all errors explicitly with context about what failed.

**Solution:**

\`\`\`go
func LoadConfig(path string) (*Config, error) {
    f, err := os.Open(path)
    if err != nil {
        return nil, fmt.Errorf("opening config file %s: %w", path, err)
    }
    defer f.Close()

    data, err := io.ReadAll(f)
    if err != nil {
        return nil, fmt.Errorf("reading config file %s: %w", path, err)
    }

    var config Config
    if err := json.Unmarshal(data, &config); err != nil {
        return nil, fmt.Errorf("parsing config file %s: %w", path, err)
    }

    if err := config.Validate(); err != nil {
        return nil, fmt.Errorf("validating config: %w", err)
    }

    return &config, nil
}
\`\`\`

### Exercise 4: Closure Practice

Implement a function that returns a function that generates unique IDs starting from 1.

**Solution:**

\`\`\`go
func NewIDGenerator() func() int64 {
    var id int64
    var mu sync.Mutex

    return func() int64 {
        mu.Lock()
        defer mu.Unlock()
        id++
        return id
    }
}

// Usage
gen := NewIDGenerator()
fmt.Println(gen())  // 1
fmt.Println(gen())  // 2
fmt.Println(gen())  // 3

// Thread-safe due to mutex
var wg sync.WaitGroup
for i := 0; i < 100; i++ {
    wg.Add(1)
    go func() {
        defer wg.Done()
        _ = gen()
    }()
}
wg.Wait()
fmt.Println(gen())  // 104
\`\`\`

### Exercise 5: Gotcha Identification

Predict the output of this code before running:

\`\`\`go
package main

import (
    "fmt"
    "sync"
)

func main() {
    var wg sync.WaitGroup
    data := []int{1, 2, 3}

    for _, v := range data {
        wg.Add(1)
        go func() {
            defer wg.Done()
            fmt.Println(v)
        }()
    }
    wg.Wait()
}
\`\`\`

**Answer:**

- **Go 1.21 and earlier**: Prints \`3 3 3\` (or some order of 3s) because all goroutines capture the same loop variable \`v\`, which equals 3 by the time they execute.

- **Go 1.22+**: Prints \`1 2 3\` (in some order) because loop variables are now per-iteration.

**Pre-1.22 fix:**
\`\`\`go
for _, v := range data {
    v := v  // Shadow with new variable
    wg.Add(1)
    go func() {
        defer wg.Done()
        fmt.Println(v)
    }()
}
\`\`\`

---

### Mid-Level FAANG-Entry Track

These exercises test the unlearning that distinguishes a fluent Go engineer from a translator. Time yourself. Each should take 30 to 60 minutes from a blank file with no reference.

6. **Translate one of your services.** Pick a small service you have written in Java, Python, or TypeScript. Re-implement it in idiomatic Go from a blank file, with no reference to the original code. The exercise is not the syntax. It is noticing every time you reach for a pattern from your previous language and choosing the Go-idiomatic replacement instead. Keep a list of the patterns you caught yourself reaching for. The list is the artifact.

7. **Implement an in-memory cache with TTL and LRU eviction.** Use \`sync.Mutex\` for concurrency. Use \`container/list\` for the LRU order. Provide \`Get(key string) (value any, ok bool)\`, \`Set(key string, value any, ttl time.Duration)\`, and \`Delete(key string)\`. Self-check: write a benchmark that hammers the cache with 10,000 concurrent goroutines and verify there are no data races (\`go test -race\`).

8. **Build a worker pool.** Implement \`type Pool struct\` with \`Submit(task func() error) <-chan error\` that runs the task on one of N worker goroutines and returns the result on the channel. Handle graceful shutdown via \`Close()\`. Self-check: a \`Pool\` with 3 workers should handle 1000 tasks correctly, and the test should fail if you accidentally make it sequential.

9. **Replace exception-style error handling.** Take a Python module of your choice that uses try/except heavily and translate it to Go. Pay attention to where exceptions provided implicit propagation and how the explicit \`if err != nil\` chain reads at scale. The exercise is recognising when the verbosity is the price of explicitness and when it signals an over-decomposed function.

10. **Wire up a real REST endpoint with structured logging.** Use only \`log/slog\` (1.21+), \`net/http\`, and \`encoding/json\`. Add request-ID middleware that injects an ID into the context and logs it with every line. Self-check: hit the endpoint with curl and verify that all log lines for a single request share the same request ID.

### Senior at FAANG Track

These exercises test the judgment that distinguishes a senior Go engineer from a fluent one.

11. **Write your team's "from X to Go" cheatsheet.** Pick the dominant background of your team's recent hires (likely Java, Python, or TypeScript in 2026). Write a 1500-word cheatsheet that lists the patterns to unlearn, the Go-idiomatic replacements, and the most common code-review findings. Send it to a recent hire from that background and incorporate their feedback. The deliverable is the cheatsheet plus the feedback log.

12. **Audit one of your team's services for the anti-patterns in Section 3.7.** Pick a service that has been in production for at least a year. Walk through it looking specifically for: typed-nil interface returns, \`interface{}\`/\`any\` parameters that should be typed, \`init()\` functions doing runtime configuration, getter and setter methods on plain data, exception-style error wrapping at every layer. Write the audit findings as a 500-word document. Decide which findings to fix in the next sprint and which to live with. The act of deciding is the deliverable.

13. **Design the Go module structure for your team's monorepo.** If you are starting from scratch, write the directory layout as a README. If you have an existing monorepo, write the migration plan to move it to the layout. Address: team ownership boundaries, public-vs-internal API surface, dependency management strategy (one module vs many), CI build performance, and the migration path from where you are today. The deliverable is the document. The interesting part is the trade-offs you make and why.

14. **Run a one-hour migration teardown for an engineer leaving your team.** Use the user-service project from Section 3.9 as the reference implementation. Walk the engineer through which patterns the team uses, which it has tried and rejected, and which are still up for debate. Record the discussion. The recording becomes the team's institutional memory for when the next senior engineer joins.

15. **Write the team's error-handling discipline.** Specify when to wrap with \`%w\`, when to wrap with \`%v\`, when to define a sentinel error, when to define a typed error, and when to log versus return. The deliverable is a one-page document plus a CI lint configuration that enforces the rules where possible. The harder part is articulating the why, because the team will challenge any rule whose justification is not explicit.

---
`;
