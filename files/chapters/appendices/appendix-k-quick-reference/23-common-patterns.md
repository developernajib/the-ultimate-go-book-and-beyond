## Common Patterns

These patterns appear frequently in production Go codebases. The functional options pattern configures objects without long parameter lists. Worker pools, fan-out/fan-in, and pipelines structure concurrent processing. Retry with backoff, graceful shutdown, and context-based cancellation handle reliability concerns.

```go
// Error wrapping
if err := doSomething(); err != nil {
    return fmt.Errorf("operation failed: %w", err)
}

// Functional options
type Config struct {
    Timeout time.Duration
    Retries int
}

type Option func(*Config)

func WithTimeout(d time.Duration) Option {
    return func(c *Config) {
        c.Timeout = d
    }
}

func WithRetries(n int) Option {
    return func(c *Config) {
        c.Retries = n
    }
}

func New(opts ...Option) *Client {
    cfg := &Config{
        Timeout: 30 * time.Second,
        Retries: 3,
    }
    for _, opt := range opts {
        opt(cfg)
    }
    return &Client{config: cfg}
}

// Use: client := New(WithTimeout(10*time.Second), WithRetries(5))

// Builder pattern
type QueryBuilder struct {
    table  string
    where  []string
    limit  int
}

func (qb *QueryBuilder) Table(name string) *QueryBuilder {
    qb.table = name
    return qb
}

func (qb *QueryBuilder) Where(condition string) *QueryBuilder {
    qb.where = append(qb.where, condition)
    return qb
}

func (qb *QueryBuilder) Limit(n int) *QueryBuilder {
    qb.limit = n
    return qb
}

func (qb *QueryBuilder) Build() string {
    // Build query
    return query
}

// Use: query := NewQueryBuilder().Table("users").Where("age > 18").Limit(10).Build()

// Worker pool
func workerPool(jobs <-chan Job, results chan<- Result, workers int) {
    var wg sync.WaitGroup
    for i := 0; i < workers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for job := range jobs {
                results <- process(job)
            }
        }()
    }
    wg.Wait()
    close(results)
}

// Singleton
var (
    instance *Singleton
    once     sync.Once
)

func GetInstance() *Singleton {
    once.Do(func() {
        instance = &Singleton{}
    })
    return instance
}

// Context with timeout
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()

result, err := doWorkWithContext(ctx)
if err != nil {
    if errors.Is(err, context.DeadlineExceeded) {
        // Timeout
    }
    return err
}

// Retry with exponential backoff
func retryWithBackoff(ctx context.Context, fn func() error, maxRetries int) error {
    var err error
    for i := 0; i < maxRetries; i++ {
        err = fn()
        if err == nil {
            return nil
        }

        backoff := time.Duration(1<<uint(i)) * time.Second
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(backoff):
            continue
        }
    }
    return fmt.Errorf("max retries exceeded: %w", err)
}

// Debounce
func debounce(interval time.Duration, fn func()) func() {
    var timer *time.Timer
    var mu sync.Mutex

    return func() {
        mu.Lock()
        defer mu.Unlock()

        if timer != nil {
            timer.Stop()
        }

        timer = time.AfterFunc(interval, fn)
    }
}

// Throttle
func throttle(interval time.Duration, fn func()) func() {
    var (
        lastRun time.Time
        mu      sync.Mutex
    )

    return func() {
        mu.Lock()
        defer mu.Unlock()

        if time.Since(lastRun) < interval {
            return
        }

        lastRun = time.Now()
        fn()
    }
}

// Pipeline with cancellation
func pipeline(ctx context.Context, nums ...int) <-chan int {
    out := make(chan int)
    go func() {
        defer close(out)
        for _, n := range nums {
            select {
            case out <- n:
            case <-ctx.Done():
                return
            }
        }
    }()
    return out
}

// Graceful shutdown
func run() error {
    ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
    defer stop()

    server := &http.Server{Addr: ":8080"}

    go func() {
        if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatal(err)
        }
    }()

    <-ctx.Done()

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    return server.Shutdown(shutdownCtx)
}

// Table-driven tests
tests := []struct {
    name    string
    input   Input
    want    Output
    wantErr bool
}{
    {"case1", input1, output1, false},
    {"case2", input2, output2, true},
}

for _, tt := range tests {
    t.Run(tt.name, func(t *testing.T) {
        got, err := function(tt.input)
        if (err != nil) != tt.wantErr {
            t.Errorf("unexpected error: %v", err)
        }
        if !reflect.DeepEqual(got, tt.want) {
            t.Errorf("got %v, want %v", got, tt.want)
        }
    })
}
```

---
