export default `## 10.3 Functional Options Pattern

The functional options pattern is widely used in Go for configuring structs without constructor parameter explosion.

### The Problem

When a constructor needs many optional parameters, the standard approaches all have drawbacks. Long parameter lists are hard to read and order-dependent. Config structs hide which fields are required versus optional. Setter methods leave the object in a potentially invalid state between calls:

\`\`\`go
// Problem 1: Many parameters
func NewServer(host string, port int, timeout time.Duration,
    maxConn int, tls *tls.Config, logger *log.Logger) *Server {
    // ...
}

// Problem 2: Config struct
type ServerConfig struct {
    Host    string
    Port    int
    Timeout time.Duration
    // 20 more fields...
}

// Caller doesn't know which fields are required
server := NewServer(ServerConfig{
    Host: "localhost",
    // Did I miss required fields?
})

// Problem 3: Setters
server := NewServer()
server.SetHost("localhost")
server.SetPort(8080)
// Object may be in invalid state between calls
\`\`\`

### The Solution: Functional Options

The functional options pattern represents each optional configuration as a function that modifies an options struct. This avoids complex builder chains while remaining extensible and self-documenting at the call site.

\`\`\`go
type Server struct {
    host       string
    port       int
    timeout    time.Duration
    maxConn    int
    tls        *tls.Config
    logger     *slog.Logger
    middleware []Middleware
}

// Option is a function that configures Server
type Option func(*Server)

// Option functions
func WithPort(port int) Option {
    return func(s *Server) {
        s.port = port
    }
}

func WithTimeout(d time.Duration) Option {
    return func(s *Server) {
        s.timeout = d
    }
}

func WithMaxConnections(n int) Option {
    return func(s *Server) {
        s.maxConn = n
    }
}

func WithTLS(cfg *tls.Config) Option {
    return func(s *Server) {
        s.tls = cfg
    }
}

func WithLogger(logger *slog.Logger) Option {
    return func(s *Server) {
        s.logger = logger
    }
}

func WithMiddleware(mw ...Middleware) Option {
    return func(s *Server) {
        s.middleware = append(s.middleware, mw...)
    }
}

// Constructor with options
func NewServer(host string, opts ...Option) *Server {
    // Set defaults
    s := &Server{
        host:    host,
        port:    8080,
        timeout: 30 * time.Second,
        maxConn: 100,
        logger:  slog.Default(),
    }

    // Apply options
    for _, opt := range opts {
        opt(s)
    }

    return s
}

// Usage - self-documenting!
server := NewServer("localhost",
    WithPort(9000),
    WithTimeout(60*time.Second),
    WithMaxConnections(500),
    WithTLS(tlsConfig),
    WithMiddleware(loggingMiddleware, authMiddleware),
)
\`\`\`

### Options with Validation

Option functions can validate their arguments before applying them. One approach stores a configuration error on the struct, which the constructor checks after applying each option. This catches invalid values early without requiring callers to handle errors at each \`With\` call:

\`\`\`go
func WithPort(port int) Option {
    return func(s *Server) {
        if port < 1 || port > 65535 {
            // Option sets error that's checked later
            s.configErr = fmt.Errorf("invalid port: %d", port)
            return
        }
        s.port = port
    }
}

func WithTimeout(d time.Duration) Option {
    return func(s *Server) {
        if d < 0 {
            s.configErr = errors.New("timeout cannot be negative")
            return
        }
        s.timeout = d
    }
}

// Constructor returns error if validation failed
func NewServer(host string, opts ...Option) (*Server, error) {
    s := &Server{
        host:    host,
        port:    8080,
        timeout: 30 * time.Second,
    }

    for _, opt := range opts {
        opt(s)
        if s.configErr != nil {
            return nil, s.configErr
        }
    }

    return s, nil
}
\`\`\`

### Options That Return Errors

A cleaner alternative changes the \`Option\` type signature to return an error directly. This eliminates the need for a \`configErr\` field on the struct and makes validation failures explicit at the type level:

\`\`\`go
type Option func(*Server) error

func WithPort(port int) Option {
    return func(s *Server) error {
        if port < 1 || port > 65535 {
            return fmt.Errorf("invalid port: %d", port)
        }
        s.port = port
        return nil
    }
}

func NewServer(host string, opts ...Option) (*Server, error) {
    s := &Server{host: host, port: 8080}

    for _, opt := range opts {
        if err := opt(s); err != nil {
            return nil, err
        }
    }

    return s, nil
}
\`\`\`

### Grouping Related Options

When several options are logically related (such as TLS certificate, key, and minimum version), you can bundle them into a small struct and pass that struct to a single option function. This keeps the call site organized and avoids a proliferation of tightly coupled \`With\` functions:

\`\`\`go
// TLS options group
type TLSOptions struct {
    CertFile string
    KeyFile  string
    MinVersion uint16
}

func WithTLSConfig(opts TLSOptions) Option {
    return func(s *Server) {
        cert, err := tls.LoadX509KeyPair(opts.CertFile, opts.KeyFile)
        if err != nil {
            s.configErr = fmt.Errorf("load TLS cert: %w", err)
            return
        }
        s.tls = &tls.Config{
            Certificates: []tls.Certificate{cert},
            MinVersion:   opts.MinVersion,
        }
    }
}

// Usage
server := NewServer("localhost",
    WithPort(443),
    WithTLSConfig(TLSOptions{
        CertFile:   "cert.pem",
        KeyFile:    "key.pem",
        MinVersion: tls.VersionTLS12,
    }),
)
\`\`\`

### Real-World Examples

Major Go libraries adopted this pattern because it scales well as APIs grow. gRPC, Uber's Zap logger, and the AWS SDK all use variations of functional options for their constructors:

\`\`\`go
// gRPC
server := grpc.NewServer(
    grpc.MaxRecvMsgSize(1024*1024*10),
    grpc.UnaryInterceptor(loggingInterceptor),
    grpc.StreamInterceptor(streamInterceptor),
)

// Zap logger
logger, _ := zap.NewProduction(
    zap.AddCaller(),
    zap.AddStacktrace(zap.ErrorLevel),
    zap.Fields(zap.String("service", "api")),
)

// AWS SDK
client := s3.NewFromConfig(cfg,
    func(o *s3.Options) {
        o.Region = "us-west-2"
        o.UsePathStyle = true
    },
)
\`\`\`

### When Functional Options Are Overkill

For a constructor with one or two optional parameters, functional options is more machinery than the problem requires. A simple \`NewServer(addr string, opts ServerOpts)\` with an optional struct parameter is cleaner for small option sets. Reach for functional options when the option set is open-ended, expected to grow, or needs per-option validation.

### The Interface-Based Option Type (Uber Variant)

A widely-adopted variant promotes \`Option\` from a plain function to an interface. This lets internal options and public options coexist with different apply semantics, and lets a package expose read-only access to configured state via methods on the option type. The cost is more boilerplate. The benefit is that the same pattern scales to larger internal-options surfaces.

\`\`\`go
type Option interface {
    apply(*Server) error
}

type optionFunc func(*Server) error
func (f optionFunc) apply(s *Server) error { return f(s) }

func WithPort(p int) Option {
    return optionFunc(func(s *Server) error {
        if p < 1 || p > 65535 { return fmt.Errorf("invalid port %d", p) }
        s.port = p
        return nil
    })
}
\`\`\`

Pick one style per package. Mixing function-based and interface-based option types in the same API surface is a review finding.

### Staff Lens: The Cost of Five Different Option Styles

Over a three-year Go codebase, the team accretes option patterns: one package uses \`func(*Server)\`, another uses \`func(*Server) error\`, a third uses the interface variant, a fourth uses a plain config struct, and a fifth uses fluent builders. A new engineer cannot predict which shape a given constructor uses. Each constructor requires a trip to the source. The staff deliverable is to pick one and enforce it. The canonical Go team choice is \`func(*Config)\` with validation happening inside the constructor, unless there is a specific reason the interface variant is needed. Write this down. When a reviewer flags a PR that uses a different style, the doc is the reference, not the reviewer's opinion. Consistency compounds. Inconsistency costs reviewer minutes forever.

### Generics and Typed Options (Go 1.18+)

With generics, you can express option types that apply to a family of constructors:

\`\`\`go
type Option[T any] func(*T) error

func WithTimeout[T Timeoutable](d time.Duration) Option[T] { ... }
\`\`\`

This is useful for a package that exports multiple related types (client, server, worker) that share option shapes. Keep it optional: if the package has one type, do not parameterise the option for no reason. The generic version is cleaner when it unifies four sibling constructors. It is overkill when it unifies one.

### Principal Lens: Options as API Commitments

Every exported \`WithX\` function is a commitment. Callers pass it. Removing it is a breaking change. Changing its semantics silently is worse. Treat the set of \`WithX\` functions on a public constructor the same way you treat the method set of an interface. Deprecation needs a window, removal needs a major version, replacement needs a migration path. The principal-level instinct: before adding a \`WithX\` that exposes an internal implementation detail, ask whether the detail will still exist in three years. If the option exposes "use the Redis cache", and the system may move to Memcached, the option is overfit to today's implementation. Broader options (\`WithCache(c Cache)\`) age better than narrow ones (\`WithRedisCluster(c *redis.Cluster)\`).

---
`;
