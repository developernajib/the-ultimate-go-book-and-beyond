## 5. Graceful Shutdown

Graceful shutdown ensures in-flight requests complete before termination.

### HTTP Server Graceful Shutdown

Listen for OS signals (SIGINT, SIGTERM), then call `server.Shutdown(ctx)` with a deadline context. This stops accepting new connections while letting in-flight requests finish within the deadline.

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "log"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

// Server wraps http.Server with graceful shutdown
type Server struct {
    httpServer *http.Server
    logger     *log.Logger
}

// NewServer creates a new server
func NewServer(addr string, handler http.Handler) *Server {
    return &Server{
        httpServer: &http.Server{
            Addr:         addr,
            Handler:      handler,
            ReadTimeout:  15 * time.Second,
            WriteTimeout: 15 * time.Second,
            IdleTimeout:  60 * time.Second,
        },
        logger: log.New(os.Stdout, "[server] ", log.LstdFlags),
    }
}

// Start starts the server and handles graceful shutdown
func (s *Server) Start() error {
    // Channel to listen for interrupt signals
    stop := make(chan os.Signal, 1)
    signal.Notify(stop, os.Interrupt, syscall.SIGTERM, syscall.SIGINT)

    // Channel to listen for server errors
    serverErrors := make(chan error, 1)

    // Start server in goroutine
    go func() {
        s.logger.Printf("Starting server on %s", s.httpServer.Addr)
        if err := s.httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
            serverErrors <- err
        }
    }()

    // Wait for interrupt signal or server error
    select {
    case err := <-serverErrors:
        return fmt.Errorf("server failed to start: %w", err)
    case sig := <-stop:
        s.logger.Printf("Received signal: %v", sig)
    }

    // Graceful shutdown
    return s.Shutdown()
}

// Shutdown gracefully shuts down the server
func (s *Server) Shutdown() error {
    s.logger.Println("Shutting down server...")

    // Create context with timeout
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Attempt graceful shutdown
    if err := s.httpServer.Shutdown(ctx); err != nil {
        return fmt.Errorf("server shutdown failed: %w", err)
    }

    s.logger.Println("Server stopped gracefully")
    return nil
}

// Example handler
func createHandler() http.Handler {
    mux := http.NewServeMux()

    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        // Simulate slow request
        time.Sleep(2 * time.Second)
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("OK"))
    })

    mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        w.Write([]byte("healthy"))
    })

    return mux
}

func main() {
    server := NewServer(":8080", createHandler())
    if err := server.Start(); err != nil {
        log.Fatalf("Failed to run server: %v", err)
    }
}
```

### Application with Multiple Components

```go
package main

import (
    "context"
    "fmt"
    "log"
    "os"
    "os/signal"
    "sync"
    "syscall"
    "time"
)

// Component represents a service component that can be started and stopped
type Component interface {
    Start(ctx context.Context) error
    Stop(ctx context.Context) error
    Name() string
}

// DatabaseComponent simulates a database connection
type DatabaseComponent struct {
    name   string
    logger *log.Logger
}

func NewDatabaseComponent(name string) *DatabaseComponent {
    return &DatabaseComponent{
        name:   name,
        logger: log.New(os.Stdout, fmt.Sprintf("[%s] ", name), log.LstdFlags),
    }
}

func (d *DatabaseComponent) Start(ctx context.Context) error {
    d.logger.Println("Starting database connection...")
    time.Sleep(100 * time.Millisecond) // Simulate connection time
    d.logger.Println("Database connected")
    return nil
}

func (d *DatabaseComponent) Stop(ctx context.Context) error {
    d.logger.Println("Closing database connection...")
    time.Sleep(100 * time.Millisecond) // Simulate cleanup
    d.logger.Println("Database connection closed")
    return nil
}

func (d *DatabaseComponent) Name() string {
    return d.name
}

// CacheComponent simulates a cache service
type CacheComponent struct {
    name   string
    logger *log.Logger
}

func NewCacheComponent(name string) *CacheComponent {
    return &CacheComponent{
        name:   name,
        logger: log.New(os.Stdout, fmt.Sprintf("[%s] ", name), log.LstdFlags),
    }
}

func (c *CacheComponent) Start(ctx context.Context) error {
    c.logger.Println("Starting cache...")
    time.Sleep(50 * time.Millisecond)
    c.logger.Println("Cache started")
    return nil
}

func (c *CacheComponent) Stop(ctx context.Context) error {
    c.logger.Println("Stopping cache...")
    time.Sleep(50 * time.Millisecond)
    c.logger.Println("Cache stopped")
    return nil
}

func (c *CacheComponent) Name() string {
    return c.name
}

// Application manages multiple components
type Application struct {
    components []Component
    logger     *log.Logger
}

func NewApplication() *Application {
    return &Application{
        components: make([]Component, 0),
        logger:     log.New(os.Stdout, "[app] ", log.LstdFlags),
    }
}

// AddComponent adds a component to the application
func (a *Application) AddComponent(c Component) {
    a.components = append(a.components, c)
}

// Start starts all components
func (a *Application) Start(ctx context.Context) error {
    a.logger.Println("Starting application...")

    for _, component := range a.components {
        if err := component.Start(ctx); err != nil {
            return fmt.Errorf("failed to start %s: %w", component.Name(), err)
        }
    }

    a.logger.Println("Application started successfully")
    return nil
}

// Stop stops all components in reverse order
func (a *Application) Stop(ctx context.Context) error {
    a.logger.Println("Stopping application...")

    var wg sync.WaitGroup
    errors := make(chan error, len(a.components))

    // Stop components in reverse order (last started, first stopped)
    for i := len(a.components) - 1; i >= 0; i-- {
        component := a.components[i]
        wg.Add(1)

        go func(c Component) {
            defer wg.Done()
            if err := c.Stop(ctx); err != nil {
                errors <- fmt.Errorf("failed to stop %s: %w", c.Name(), err)
            }
        }(component)
    }

    wg.Wait()
    close(errors)

    // Collect any errors
    var shutdownErrors []error
    for err := range errors {
        shutdownErrors = append(shutdownErrors, err)
    }

    if len(shutdownErrors) > 0 {
        return fmt.Errorf("shutdown errors: %v", shutdownErrors)
    }

    a.logger.Println("Application stopped successfully")
    return nil
}

// Run runs the application with graceful shutdown
func (a *Application) Run() error {
    ctx := context.Background()

    // Start all components
    if err := a.Start(ctx); err != nil {
        return err
    }

    // Wait for interrupt signal
    stop := make(chan os.Signal, 1)
    signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

    <-stop
    a.logger.Println("Received shutdown signal")

    // Create shutdown context with timeout
    shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    // Stop all components
    return a.Stop(shutdownCtx)
}

func ExampleApplication() {
    app := NewApplication()
    app.AddComponent(NewDatabaseComponent("postgres"))
    app.AddComponent(NewCacheComponent("redis"))

    if err := app.Run(); err != nil {
        log.Fatalf("Application error: %v", err)
    }
}
```

---
