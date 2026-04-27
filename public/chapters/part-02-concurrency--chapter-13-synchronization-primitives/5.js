export default `## 13.4 Once: One-Time Execution

\`sync.Once\` guarantees a function executes exactly once, even with concurrent calls.

### Basic Singleton Pattern

The singleton pattern uses a package-level \`sync.Once\` variable paired with a pointer to the shared instance. When \`GetDatabase\` is called for the first time, \`dbOnce.Do\` runs the initializer, opens the database connection, and stores the result. Every subsequent call, regardless of concurrency, skips the initializer and returns the already-created instance immediately.

\`\`\`go
type Database struct {
    conn *sql.DB
}

var (
    dbInstance *Database
    dbOnce     sync.Once
)

func GetDatabase() *Database {
    dbOnce.Do(func() {
        conn, err := sql.Open("postgres", "connection-string")
        if err != nil {
            panic(err)  // Or handle differently
        }
        dbInstance = &Database{conn: conn}
    })
    return dbInstance
}
\`\`\`

### Once with Error Handling

The standard \`sync.Once\` doesn't retry on failure. Here are patterns to handle this:

\`\`\`go
// Pattern 1: Once that stores error
type OnceValue[T any] struct {
    once   sync.Once
    value  T
    err    error
}

func (o *OnceValue[T]) Get(f func() (T, error)) (T, error) {
    o.once.Do(func() {
        o.value, o.err = f()
    })
    return o.value, o.err
}

// Usage
var configOnce OnceValue[*Config]

func GetConfig() (*Config, error) {
    return configOnce.Get(func() (*Config, error) {
        return loadConfig()
    })
}

// Pattern 2: Retryable initialization
type RetryableOnce[T any] struct {
    mu      sync.Mutex
    done    bool
    value   T
}

func (o *RetryableOnce[T]) Do(f func() (T, error)) (T, error) {
    o.mu.Lock()
    defer o.mu.Unlock()

    if o.done {
        return o.value, nil
    }

    value, err := f()
    if err != nil {
        var zero T
        return zero, err  // Not marked done, will retry
    }

    o.value = value
    o.done = true
    return value, nil
}

// Pattern 3: OnceFunc (Go 1.21+)
var initOnce = sync.OnceFunc(func() {
    // Initialization code
    fmt.Println("Initialized!")
})

func DoSomething() {
    initOnce()  // Calls function once
    // ... rest of logic
}

// OnceValue (Go 1.21+)
var getExpensiveValue = sync.OnceValue(func() int {
    return expensiveComputation()
})

func UseValue() {
    value := getExpensiveValue()  // Computed once
    fmt.Println(value)
}

// OnceValues (Go 1.21+)
var loadData = sync.OnceValues(func() ([]byte, error) {
    return os.ReadFile("data.json")
})

func GetData() ([]byte, error) {
    return loadData()  // Loaded once
}
\`\`\`

### Lazy Initialization Pattern

Lazy initialization defers the creation of an expensive resource until it is actually needed, avoiding startup cost when the resource may never be used at all. The generic \`Lazy[T]\` wrapper encapsulates a \`sync.Once\` and a stored value so callers interact with a simple \`Get()\` method, keeping the one-time initialization logic transparent and reusable across any resource type.

\`\`\`go
// Generic lazy initialization wrapper
type Lazy[T any] struct {
    once  sync.Once
    value T
    init  func() T
}

func NewLazy[T any](init func() T) *Lazy[T] {
    return &Lazy[T]{init: init}
}

func (l *Lazy[T]) Get() T {
    l.once.Do(func() {
        l.value = l.init()
    })
    return l.value
}

// Usage
type ExpensiveResource struct {
    data []byte
}

func NewExpensiveResource() *ExpensiveResource {
    return &ExpensiveResource{
        data: loadLargeFile(),
    }
}

var resource = NewLazy(NewExpensiveResource)

func ProcessData() {
    r := resource.Get()  // Created on first access
    // Use r...
}
\`\`\`

### Go 1.21+: OnceFunc, OnceValue, OnceValues

Go 1.21 added type-safe helpers that eliminate most hand-rolled \`sync.Once\` boilerplate:

\`\`\`go
// Replaces "var once sync.Once; once.Do(fn)"
init := sync.OnceFunc(initialize)
init() // fn runs first time; no-op after

// Replaces the Lazy pattern above
getConfig := sync.OnceValue(func() *Config { return loadConfig() })
cfg := getConfig() // first call computes; subsequent calls return cached

// For functions returning (value, error)
getClient := sync.OnceValues(func() (*Client, error) { return newClient() })
client, err := getClient()
\`\`\`

Prefer these over hand-rolled \`Once\` wrappers in new code. They are shorter, type-safe, and clearer about intent. The Lazy type shown earlier is teaching material; \`sync.OnceValue\` is the production version.

### Once With Error Handling

\`sync.Once\` is not retry-safe. If the initialisation fails, the \`Once\` is still considered "done" and subsequent calls do not retry. For initialisation that might fail:

\`\`\`go
type OnceWithError struct {
    once sync.Once
    err  error
}

func (o *OnceWithError) Do(f func() error) error {
    o.once.Do(func() { o.err = f() })
    return o.err
}
\`\`\`

This stores the error for callers to check, but the initialisation still runs exactly once. For "retry until success" semantics, \`sync.Once\` is the wrong primitive. Use a \`sync.Mutex\` with a done flag and explicit retry logic, or switch to \`golang.org/x/sync/singleflight\` for request coalescing.

### Staff Lens: Once Pattern Trap

Lazy initialisation via \`sync.Once\` is convenient but creates hidden dependencies on startup order. A service that lazily initialises a database client on first request has unpredictable latency for the first request after process start. The staff-level rule: prefer eager initialisation at process start over lazy initialisation in the request path. Startup slowness is easier to diagnose than occasional request slowness. Reserve \`sync.Once\` for genuinely optional subsystems that might never be used.

---
`;
