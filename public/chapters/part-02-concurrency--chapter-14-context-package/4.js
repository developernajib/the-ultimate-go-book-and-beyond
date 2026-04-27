export default `## 14.3 Timeouts and Deadlines

Timeouts prevent operations from running forever and ensure system resources are released.

### Timeout vs Deadline

\`WithTimeout\` and \`WithDeadline\` are semantically equivalent, \`WithTimeout\` is simply a convenience wrapper that converts a duration into an absolute time by adding it to \`time.Now()\`. Prefer \`WithTimeout\` when you are starting a fresh operation and only care about elapsed time. Prefer \`WithDeadline\` when you need to share the same wall-clock cutoff across multiple independent operations.

\`\`\`go
// Timeout: Duration from now
ctx, cancel := context.WithTimeout(parent, 5*time.Second)
defer cancel()
// Deadline will be time.Now().Add(5*time.Second)

// Deadline: Absolute point in time
deadline := time.Now().Add(5 * time.Second)
ctx, cancel = context.WithDeadline(parent, deadline)
defer cancel()

// Use Timeout when:
// - Duration is relative to current operation
// - You're starting a new operation

// Use Deadline when:
// - You have a specific end time (e.g., from request header)
// - You want to synchronize multiple operations to same deadline
\`\`\`

### Hierarchical Timeouts

When a child context is derived with its own timeout, the effective deadline is the minimum of the child's timeout and the parent's remaining time. This means sub-operations never silently exceed the overall request budget: if the parent's 30-second window expires first, every child context is cancelled even if the child's own deadline has not yet been reached.

\`\`\`go
func handleRequest(w http.ResponseWriter, r *http.Request) {
    // Overall request timeout: 30 seconds
    ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
    defer cancel()

    // Step 1: Database query (max 5s, but respects parent)
    user, err := fetchUser(ctx)
    if err != nil {
        handleError(w, err)
        return
    }

    // Step 2: External API call (max 10s, but respects parent)
    data, err := callExternalAPI(ctx, user.ID)
    if err != nil {
        handleError(w, err)
        return
    }

    // Step 3: Process and respond
    result := process(user, data)
    json.NewEncoder(w).Encode(result)
}

func fetchUser(ctx context.Context) (*User, error) {
    // Child timeout: 5 seconds or parent's remaining time, whichever is less
    ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
    defer cancel()

    return db.QueryUser(ctx)
}

func callExternalAPI(ctx context.Context, userID string) (*Data, error) {
    // Child timeout: 10 seconds or parent's remaining time
    ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
    defer cancel()

    req, _ := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    var data Data
    return &data, json.NewDecoder(resp.Body).Decode(&data)
}
\`\`\`

### Checking Remaining Time

\`ctx.Deadline()\` lets a function inspect how much time is left before committing to expensive work. The \`adaptiveOperation\` example below takes this further by dividing the remaining budget proportionally among sub-operations, so each stage gets a fair share rather than risking one slow step consuming the entire window.

\`\`\`go
func processWithDeadlineAwareness(ctx context.Context) error {
    deadline, ok := ctx.Deadline()
    if !ok {
        // No deadline set
        return doWork(ctx)
    }

    remaining := time.Until(deadline)
    if remaining < time.Second {
        // Not enough time, fail fast
        return fmt.Errorf("insufficient time: %v remaining", remaining)
    }

    log.Printf("Starting work with %v remaining", remaining)
    return doWork(ctx)
}

// Adaptive timeout based on remaining budget
func adaptiveOperation(ctx context.Context) error {
    deadline, ok := ctx.Deadline()
    if !ok {
        // Default timeout if no deadline
        var cancel context.CancelFunc
        ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
        defer cancel()
        deadline, _ = ctx.Deadline()
    }

    remaining := time.Until(deadline)

    // Allocate time proportionally
    dbTimeout := remaining / 3
    apiTimeout := remaining / 3
    // Reserve 1/3 for processing

    dbCtx, cancel := context.WithTimeout(ctx, dbTimeout)
    defer cancel()
    data, err := queryDatabase(dbCtx)
    if err != nil {
        return err
    }

    apiCtx, cancel := context.WithTimeout(ctx, apiTimeout)
    defer cancel()
    return callAPI(apiCtx, data)
}
\`\`\`

### Timeout Strategies for Different Operations

Centralising per-operation timeout values in a \`TimeoutConfig\` struct makes the budget explicit and easy to tune without hunting through business logic. Notice that cache misses cancel the cache context immediately with \`cacheCancel()\` rather than deferring it, freeing resources as soon as the result is known rather than waiting until the enclosing function returns.

\`\`\`go
// Per-operation timeout budget
type TimeoutConfig struct {
    Total     time.Duration
    Database  time.Duration
    Cache     time.Duration
    External  time.Duration
}

var DefaultTimeouts = TimeoutConfig{
    Total:    30 * time.Second,
    Database: 5 * time.Second,
    Cache:    100 * time.Millisecond,
    External: 10 * time.Second,
}

type Service struct {
    config TimeoutConfig
}

func (s *Service) Handle(ctx context.Context) (*Response, error) {
    // Overall timeout
    ctx, cancel := context.WithTimeout(ctx, s.config.Total)
    defer cancel()

    // Try cache first with short timeout
    cacheCtx, cacheCancel := context.WithTimeout(ctx, s.config.Cache)
    if cached, err := s.cache.Get(cacheCtx, key); err == nil {
        cacheCancel()
        return cached, nil
    }
    cacheCancel()

    // Fall back to database
    dbCtx, dbCancel := context.WithTimeout(ctx, s.config.Database)
    data, err := s.db.Query(dbCtx)
    dbCancel()
    if err != nil {
        return nil, err
    }

    // Call external service
    extCtx, extCancel := context.WithTimeout(ctx, s.config.External)
    defer extCancel()
    enriched, err := s.external.Enrich(extCtx, data)
    if err != nil {
        // External enrichment failed, return base data
        log.Printf("enrichment failed: %v", err)
        return &Response{Data: data}, nil
    }

    return &Response{Data: enriched}, nil
}
\`\`\`

### The Deadline Budget Principle

Every request arrives with a deadline (explicit from client timeout or implicit from SLO). Every downstream call must receive a deadline less than or equal to the remaining request budget. The pattern:

\`\`\`go
func (s *Service) CallDownstream(ctx context.Context) error {
    remaining := time.Until(ctx.Deadline().Time)
    if remaining < minCallTime {
        return errors.New("insufficient budget for downstream call")
    }

    // Give downstream 80% of remaining, keep 20% for our response handling
    downstreamCtx, cancel := context.WithTimeout(ctx, remaining*4/5)
    defer cancel()
    return s.client.Call(downstreamCtx, ...)
}
\`\`\`

Without this, a slow call can consume the entire budget and leave no time to serialise the response to the client.

### Deadline Propagation Across RPC Boundaries

gRPC propagates deadlines automatically (the deadline is encoded in request metadata and reconstructed on the server side). HTTP does not have a standard mechanism, but the common pattern is to propagate \`X-Request-Timeout-Ms\` or equivalent header. For production Go services, either:

- Use gRPC, which handles this correctly by default.
- Adopt a header convention and middleware that reads it on entry and sets it on every outbound HTTP call.

Without cross-RPC deadline propagation, each service runs with its own clock, timeouts compound unpredictably, and slow downstreams cause bloat past the client's timeout.

### Staff Lens: End-to-End Deadline Audit

The staff-level exercise: take one request through your system and trace every context-deadline transition. If Service A calls B with 500ms and B calls C without propagating the deadline, you have an integration bug. If C has its own default timeout of 5s, it will happily spend 5s on work no one is still waiting for. Fix this by enforcing deadline propagation at every boundary and auditing periodically.

---
`;
