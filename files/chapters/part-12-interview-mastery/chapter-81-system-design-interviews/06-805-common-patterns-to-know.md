## 81.5 Common Patterns to Know

### 1. Load Balancing

Load balancing distributes incoming traffic across multiple service instances, preventing any single instance from becoming a bottleneck and enabling zero-downtime deployments through connection draining. The following Go implementation demonstrates the core algorithms, round-robin, least-connections, and consistent hashing, used in production load balancers.

```go
// Round Robin
type RoundRobin struct {
    servers []string
    current uint64
}

func (r *RoundRobin) Next() string {
    idx := atomic.AddUint64(&r.current, 1) % uint64(len(r.servers))
    return r.servers[idx]
}

// Weighted Round Robin
type WeightedRR struct {
    servers []serverWeight
    total   int
}

type serverWeight struct {
    addr   string
    weight int
}

func (w *WeightedRR) Next() string {
    r := rand.IntN(w.total)
    for _, s := range w.servers {
        r -= s.weight
        if r < 0 {
            return s.addr
        }
    }
    return w.servers[0].addr
}

// Least Connections
type LeastConn struct {
    mu      sync.Mutex
    servers map[string]int  // server -> active connections
}

func (l *LeastConn) Next() string {
    l.mu.Lock()
    defer l.mu.Unlock()

    minConn := math.MaxInt
    selected := ""
    for server, conn := range l.servers {
        if conn < minConn {
            minConn = conn
            selected = server
        }
    }
    l.servers[selected]++
    return selected
}
```

### 2. Circuit Breaker

The circuit breaker pattern prevents cascading failures by stopping requests to a failing dependency until it recovers, giving it time to stabilize. The following state machine implementation transitions between closed, open, and half-open states based on configurable error rate and timeout thresholds.

```go
type CircuitBreaker struct {
    mu           sync.Mutex
    failures     int
    successes    int
    state        State
    lastFailure  time.Time
    threshold    int
    timeout      time.Duration
}

type State int
const (
    Closed State = iota
    Open
    HalfOpen
)

func (cb *CircuitBreaker) Execute(fn func() error) error {
    cb.mu.Lock()

    switch cb.state {
    case Open:
        if time.Since(cb.lastFailure) > cb.timeout {
            cb.state = HalfOpen
            cb.mu.Unlock()
        } else {
            cb.mu.Unlock()
            return ErrCircuitOpen
        }
    default:
        cb.mu.Unlock()
    }

    err := fn()

    cb.mu.Lock()
    defer cb.mu.Unlock()

    if err != nil {
        cb.failures++
        cb.lastFailure = time.Now()
        if cb.failures >= cb.threshold {
            cb.state = Open
        }
        return err
    }

    if cb.state == HalfOpen {
        cb.successes++
        if cb.successes >= cb.threshold {
            cb.state = Closed
            cb.failures = 0
            cb.successes = 0
        }
    }

    return nil
}
```

### 3. Event Sourcing

Event sourcing stores state changes as an immutable append-only log of domain events, enabling temporal queries, event replay, and audit trails that are impossible with update-in-place databases. The `Event` struct uses `json.RawMessage` for its `Data` field so the store is agnostic to the payload type, and the projection function folds the ordered event stream into current state by dispatching each `Event.Type` to its corresponding state-mutation case.

```go
// Event represents a domain event
type Event struct {
    ID        string
    Type      string
    Data      json.RawMessage
    Timestamp time.Time
    Version   int
}

// EventStore stores and retrieves events
type EventStore interface {
    Append(streamID string, events []Event) error
    GetEvents(streamID string, fromVersion int) ([]Event, error)
}

// Aggregate rebuilds state from events
type Account struct {
    ID      string
    Balance int64
    Version int
}

func (a *Account) Apply(event Event) {
    switch event.Type {
    case "AccountCreated":
        var data struct{ InitialBalance int64 }
        json.Unmarshal(event.Data, &data)
        a.Balance = data.InitialBalance

    case "MoneyDeposited":
        var data struct{ Amount int64 }
        json.Unmarshal(event.Data, &data)
        a.Balance += data.Amount

    case "MoneyWithdrawn":
        var data struct{ Amount int64 }
        json.Unmarshal(event.Data, &data)
        a.Balance -= data.Amount
    }
    a.Version = event.Version
}

// Rebuild aggregate from events
func LoadAccount(store EventStore, id string) (*Account, error) {
    events, err := store.GetEvents(id, 0)
    if err != nil {
        return nil, err
    }

    account := &Account{ID: id}
    for _, event := range events {
        account.Apply(event)
    }
    return account, nil
}
```

---

### Junior → FAANG: Patterns as a Design Vocabulary You Deploy, Not Describe

The common patterns in this section (load balancing, message queues, caching layers, databases, circuit breakers) are the building blocks of every system design interview. The mistake is treating them as a vocabulary list to memorize rather than a toolkit to deploy. The difference shows immediately: a candidate who says "I would use a message queue" and stops is describing. A candidate who says "I would use a message queue here to decouple the upload service from the processing service, which lets me scale them independently and retry failed processing jobs without re-uploading" is deploying.

For each pattern, practice the three-part deployment: what the pattern is, why it fits this specific problem, and what the trade-off is (latency, consistency, operational complexity, cost). Junior candidates who have practiced these three-part answers for each pattern can discuss any design confidently.

Entry-point interview signal: one pattern that junior candidates often miss is idempotency. For any write operation in a distributed system, the question "what happens if this request is retried" is almost always relevant, and the answer involves idempotency keys. Knowing this pattern and volunteering it proactively distinguishes prepared candidates.

### Senior @ FAANG: Pattern Selection as Architectural Constraint Management

At L5/L6, patterns are not just building blocks. They are constraints. Choosing a message queue introduces at-least-once delivery semantics, which requires idempotent consumers. Choosing eventual consistency requires application-level handling of stale reads. Choosing a circuit breaker requires defining the failure threshold, the half-open probe interval, and the fallback behavior. A senior candidate understands the full constraint chain, not just the pattern name.

The Saga pattern for distributed transactions is particularly important at senior level because it appears in every system with a cross-service write path. Being able to walk through a choreography-based saga (where each service publishes events and other services react) versus an orchestration-based saga (where a central coordinator manages the transaction state), with the trade-offs of each (choreography: simpler services but harder to observe, orchestration: clearer control flow but a coordinator bottleneck), is the L5/L6 standard.

Platform governance: at staff level, patterns become organizational standards. A staff engineer who establishes "all new Go services must implement the circuit breaker pattern for outbound calls using the `gobreaker` library and must emit the circuit state as a metric" is defining a platform-level reliability standard. This kind of pattern governance reduces the per-service decision burden and ensures consistent behavior across the platform, which becomes critical when managing dozens of services.
