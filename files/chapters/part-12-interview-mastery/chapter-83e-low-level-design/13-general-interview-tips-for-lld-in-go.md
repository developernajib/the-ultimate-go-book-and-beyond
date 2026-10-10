## 83E.13 General Interview Tips for LLD in Go

### 1. Start with Requirements

Always clarify:
- What are the core use cases?
- What are the constraints (concurrent access, scale)?
- What operations need to be fast?

### 2. Define Interfaces First

Interfaces in Go are satisfied implicitly, enabling loosely coupled designs where concrete types are decoupled from their consumers. The following example demonstrates minimal interface definition, multiple implementations, and composition to extend behavior without modifying existing code.

```go
type Vehicle interface {
    LicensePlate() string
}

type Ticket struct {
    ID string
}

// Start here - what behavior does the system need?
type ParkingLotService interface {
    ParkVehicle(v Vehicle) (*Ticket, error)
    UnparkVehicle(ticketID string) (int64, error)
}
```

### 3. Use Go Idioms, Not Java Patterns

| Java/OOP | Go Equivalent |
|---|---|
| `Abstract class Shape` | `type Shape interface { Area() float64 }` |
| `class Circle extends Shape` | `type Circle struct { radius float64 }` + method |
| `private int x` | `x int` (unexported) |
| `public int getX()` | `func (c *Circle) X() int` |
| `Factory pattern` | `func NewCircle(r float64) Shape` |
| `Singleton` | `sync.Once` + package-level var |
| `Observer pattern` | Channels |
| `Strategy pattern` | Interface field |

### 4. Always Add Thread Safety

Interviewers expect you to handle concurrency:

```go
type SafeCounter struct {
    mu    sync.Mutex
    count int
}

func (sc *SafeCounter) Increment() {
    sc.mu.Lock()
    defer sc.mu.Unlock()
    sc.count++
}
```

For read-heavy workloads, use `sync.RWMutex`.

### 5. Apply SOLID Explicitly

Call out SOLID principles during the interview:

- "I am separating the fee calculation into its own interface - that is the Single Responsibility Principle."
- "By using an interface for the dispatcher, we can add new dispatching strategies without modifying the building code - Open-Closed Principle."
- "The `RateLimiter` interface has just one method, `Allow` - Interface Segregation."

### 6. Common Follow-ups

- **"How would you make this distributed?"** → Use Redis for shared state, message queues for events
- **"How would you add persistence?"** → Repository pattern with database behind an interface
- **"How would you test this?"** → Show mock interfaces, table-driven tests
- **"What about performance?"** → Discuss lock granularity, caching, read-write locks

### 7. Testing Pattern

Demonstrating testability is a strong signal in LLD interviews. Write table-driven tests that exercise the core operations and edge cases of your design. The following tests cover the major LLD problems from this chapter and illustrate the patterns interviewers expect to see.
```go
func TestParkingLot_ParkAndUnpark(t *testing.T) {
    cfg := ParkingLotConfig{
        Name:   "Test Lot",
        Floors: 1,
        SpotsPerFloor: map[SpotSize]int{
            SmallSpot:   2,
            CompactSpot: 3,
            LargeSpot:   1,
        },
        FeeCalculator: NewHourlyFeeCalculator(),
    }
    lot := NewParkingLot(cfg)

    // Park a car
    ticket, err := lot.ParkVehicle(NewCar("ABC-123"))
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if ticket == nil {
        t.Fatal("expected ticket, got nil")
    }

    // Verify available spots decreased
    available := lot.GetAvailableSpots(Car)
    if available != 3 { // 3 compact + 1 large - 1 used = 3
        t.Errorf("expected 3 available spots, got %d", available)
    }

    // Unpark
    fee, err := lot.UnparkVehicle(ticket.ID)
    if err != nil {
        t.Fatalf("unexpected error: %v", err)
    }
    if fee < 0 {
        t.Errorf("expected non-negative fee, got %d", fee)
    }
}

func TestLRUCache(t *testing.T) {
    cache := Constructor(2)

    cache.Put(1, 1)
    cache.Put(2, 2)

    if got := cache.Get(1); got != 1 {
        t.Errorf("Get(1) = %d, want 1", got)
    }

    cache.Put(3, 3) // evicts key 2

    if got := cache.Get(2); got != -1 {
        t.Errorf("Get(2) = %d, want -1 (evicted)", got)
    }

    if got := cache.Get(3); got != 3 {
        t.Errorf("Get(3) = %d, want 3", got)
    }
}

func TestMinStack(t *testing.T) {
    ms := Constructor()
    ms.Push(-2)
    ms.Push(0)
    ms.Push(-3)

    if got := ms.GetMin(); got != -3 {
        t.Errorf("GetMin() = %d, want -3", got)
    }

    ms.Pop()

    if got := ms.Top(); got != 0 {
        t.Errorf("Top() = %d, want 0", got)
    }

    if got := ms.GetMin(); got != -2 {
        t.Errorf("GetMin() = %d, want -2", got)
    }
}

func TestSnakeGame(t *testing.T) {
    game := NewSnakeGame(3, 2, [][]int{{1, 2}, {0, 1}})

    tests := []struct {
        direction string
        want      int
    }{
        {"R", 0},
        {"D", 0},
        {"R", 1}, // eats food at (1,2)
        {"U", 1},
        {"L", 2}, // eats food at (0,1)
        {"U", -1}, // hits wall
    }

    for i, tt := range tests {
        got := game.Move(tt.direction)
        if got != tt.want {
            t.Errorf("move %d (%s): got %d, want %d", i, tt.direction, got, tt.want)
        }
    }
}

func TestRateLimiter(t *testing.T) {
    limiter := NewTokenBucketLimiter(3, 1) // 3 tokens, 1/sec refill

    // Should allow first 3 requests
    for i := 0; i < 3; i++ {
        if !limiter.Allow("user1") {
            t.Errorf("request %d should be allowed", i+1)
        }
    }

    // 4th should be denied
    if limiter.Allow("user1") {
        t.Error("4th request should be denied")
    }

    // Different user should still be allowed
    if !limiter.Allow("user2") {
        t.Error("different user should be allowed")
    }
}

func TestFileSystem(t *testing.T) {
    fs := Constructor()

    fs.Mkdir("/a/b/c")
    fs.AddContentToFile("/a/b/c/d.txt", "hello ")
    fs.AddContentToFile("/a/b/c/d.txt", "world")

    content := fs.ReadContentFromFile("/a/b/c/d.txt")
    if content != "hello world" {
        t.Errorf("got %q, want %q", content, "hello world")
    }

    ls := fs.Ls("/a/b/c")
    if len(ls) != 1 || ls[0] != "d.txt" {
        t.Errorf("Ls = %v, want [d.txt]", ls)
    }
}

func TestTwitterFeed(t *testing.T) {
    tw := Constructor()

    tw.PostTweet(1, 5)
    feed := tw.GetNewsFeed(1)
    if len(feed) != 1 || feed[0] != 5 {
        t.Errorf("feed = %v, want [5]", feed)
    }

    tw.Follow(1, 2)
    tw.PostTweet(2, 6)
    feed = tw.GetNewsFeed(1)
    if len(feed) != 2 || feed[0] != 6 || feed[1] != 5 {
        t.Errorf("feed = %v, want [6, 5]", feed)
    }

    tw.Unfollow(1, 2)
    feed = tw.GetNewsFeed(1)
    if len(feed) != 1 || feed[0] != 5 {
        t.Errorf("feed = %v, want [5]", feed)
    }
}
```


### Junior → FAANG: LLD Interview Tips for Go Developers

Go-specific LLD interview tips: start by defining your interfaces before your structs (interface-first design clarifies the contract before the implementation), use struct embedding for code reuse rather than reaching for inheritance patterns from other languages, and name your interfaces based on their behavior (Store, Notifier, Scheduler) rather than their identity (DataInterface). Avoid empty interfaces (interface{}) in LLD designs unless necessary. Use typed interfaces or generics instead. Test your design by describing how you would unit test each component: if any component requires setting up a large dependency tree to test, your design has coupling problems.

### Senior @ FAANG: LLD Interview Tips at the Senior Bar: Code Review Standards and Design Documentation

Senior candidates should approach LLD interviews with the same standards they apply in production code reviews. Specifically: every exported type and function should have a docstring explaining what it does and its contracts. Error handling should be explicit rather than relying on panic. And zero-value initialization should be meaningful (a zero-value struct should be in a valid, usable state where possible). The bar-raiser signal in LLD at L6 is the ability to describe how the design would be documented: which behaviors are guaranteed by the interface contract, which are implementation details that callers should not depend on, and how the design communicates these distinctions clearly. This documentation discipline is what enables other engineers to safely extend or replace components in the future.

---
