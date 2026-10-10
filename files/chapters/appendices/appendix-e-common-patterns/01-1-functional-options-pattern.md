## 1. Functional Options Pattern

The Functional Options pattern provides a clean, extensible API for configuring structs with optional parameters.

### Basic Implementation

Define an `Option` type as a function that modifies your struct, then accept variadic options in your constructor. Callers pick only the options they need, and adding new options does not break existing call sites.

```go
package server

import (
    "time"
)

// Server represents an HTTP server
type Server struct {
    host         string
    port         int
    timeout      time.Duration
    maxConns     int
    enableTLS    bool
    certFile     string
    keyFile      string
}

// Option is a function that configures a Server
type Option func(*Server)

// WithPort sets the server port
func WithPort(port int) Option {
    return func(s *Server) {
        s.port = port
    }
}

// WithTimeout sets the connection timeout
func WithTimeout(timeout time.Duration) Option {
    return func(s *Server) {
        s.timeout = timeout
    }
}

// WithMaxConnections sets maximum concurrent connections
func WithMaxConnections(max int) Option {
    return func(s *Server) {
        s.maxConns = max
    }
}

// WithTLS enables TLS with certificate files
func WithTLS(certFile, keyFile string) Option {
    return func(s *Server) {
        s.enableTLS = true
        s.certFile = certFile
        s.keyFile = keyFile
    }
}

// NewServer creates a server with default values and applies options
func NewServer(host string, opts ...Option) *Server {
    // Set defaults
    s := &Server{
        host:     host,
        port:     8080,
        timeout:  30 * time.Second,
        maxConns: 100,
    }

    // Apply options
    for _, opt := range opts {
        opt(s)
    }

    return s
}

// Usage example
func Example() {
    // Minimal configuration
    s1 := NewServer("localhost")

    // Custom configuration
    s2 := NewServer("0.0.0.0",
        WithPort(443),
        WithTimeout(60*time.Second),
        WithMaxConnections(1000),
        WithTLS("/path/to/cert.pem", "/path/to/key.pem"),
    )

    _, _ = s1, s2
}
```

### Advanced: Options with Validation

```go
package database

import (
    "errors"
    "time"
)

type DB struct {
    dsn             string
    maxOpenConns    int
    maxIdleConns    int
    connMaxLifetime time.Duration
    readOnly        bool
}

type Option func(*DB) error

// WithMaxOpenConns sets maximum open connections
func WithMaxOpenConns(n int) Option {
    return func(db *DB) error {
        if n < 1 {
            return errors.New("max open connections must be >= 1")
        }
        db.maxOpenConns = n
        return nil
    }
}

// WithMaxIdleConns sets maximum idle connections
func WithMaxIdleConns(n int) Option {
    return func(db *DB) error {
        if n < 0 {
            return errors.New("max idle connections must be >= 0")
        }
        db.maxIdleConns = n
        return nil
    }
}

// WithConnMaxLifetime sets connection lifetime
func WithConnMaxLifetime(d time.Duration) Option {
    return func(db *DB) error {
        if d < 0 {
            return errors.New("connection lifetime must be >= 0")
        }
        db.connMaxLifetime = d
        return nil
    }
}

// WithReadOnly sets read-only mode
func WithReadOnly() Option {
    return func(db *DB) error {
        db.readOnly = true
        return nil
    }
}

// NewDB creates a database connection with options
func NewDB(dsn string, opts ...Option) (*DB, error) {
    db := &DB{
        dsn:             dsn,
        maxOpenConns:    25,
        maxIdleConns:    5,
        connMaxLifetime: 5 * time.Minute,
    }

    for _, opt := range opts {
        if err := opt(db); err != nil {
            return nil, err
        }
    }

    // Validate configuration
    if db.maxIdleConns > db.maxOpenConns {
        return nil, errors.New("max idle conns cannot exceed max open conns")
    }

    return db, nil
}
```

---
