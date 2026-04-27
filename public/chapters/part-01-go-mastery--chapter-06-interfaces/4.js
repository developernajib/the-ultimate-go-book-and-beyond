export default `## 6.3 Interface Composition

Small interfaces compose into larger ones. This is one of Go's most powerful features.

### Embedding Interfaces

Interface embedding composes multiple interfaces into a single, broader interface. This allows building layered abstractions from small, focused interfaces, following the interface segregation principle.

\`\`\`go
type Reader interface {
    Read([]byte) (int, error)
}

type Writer interface {
    Write([]byte) (int, error)
}

type Closer interface {
    Close() error
}

// Composed interfaces
type ReadWriter interface {
    Reader
    Writer
}

type ReadWriteCloser interface {
    Reader
    Writer
    Closer
}
\`\`\`

A type satisfies \`ReadWriteCloser\` if it has \`Read\`, \`Write\`, and \`Close\` methods.

### Interface Segregation Principle

Each function should depend on the narrowest interface that covers its actual needs. A function that only reads should not accept an interface that also requires write and delete methods. Splitting broad interfaces into single-purpose ones reduces coupling and makes testing straightforward.

\`\`\`go
// Too broad
type DataStore interface {
    Read(key string) ([]byte, error)
    Write(key string, value []byte) error
    Delete(key string) error
    List() ([]string, error)
    Backup() error
    Restore(backup []byte) error
}

// Better: segregated
type Reader interface {
    Read(key string) ([]byte, error)
}

type Writer interface {
    Write(key string, value []byte) error
}

type Deleter interface {
    Delete(key string) error
}

type Lister interface {
    List() ([]string, error)
}

// Functions accept only what they need
func copyData(r Reader, w Writer) error {
    // Only needs read and write capabilities
}
\`\`\`

### Netflix's Interface Composition

Netflix's Go services use composed interfaces extensively:

\`\`\`go
// Base interfaces
type Getter interface {
    Get(ctx context.Context, key string) ([]byte, error)
}

type Setter interface {
    Set(ctx context.Context, key string, value []byte, ttl time.Duration) error
}

type Deleter interface {
    Delete(ctx context.Context, key string) error
}

type Healthchecker interface {
    HealthCheck(ctx context.Context) error
}

// Composed interfaces for different use cases
type Cache interface {
    Getter
    Setter
    Deleter
}

type ReadOnlyCache interface {
    Getter
    Healthchecker
}

type CacheWithHealth interface {
    Cache
    Healthchecker
}

// Implementation satisfies all relevant interfaces
type RedisCache struct {
    client *redis.Client
}

func (r *RedisCache) Get(ctx context.Context, key string) ([]byte, error) {
    return r.client.Get(ctx, key).Bytes()
}

func (r *RedisCache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
    return r.client.Set(ctx, key, value, ttl).Err()
}

func (r *RedisCache) Delete(ctx context.Context, key string) error {
    return r.client.Del(ctx, key).Err()
}

func (r *RedisCache) HealthCheck(ctx context.Context) error {
    return r.client.Ping(ctx).Err()
}

// Compile-time interface guards
var (
    _ Cache           = (*RedisCache)(nil)
    _ CacheWithHealth = (*RedisCache)(nil)
)
\`\`\`

### Why Interface Composition Is the Default

The pattern of building large interfaces out of small ones is the idiomatic Go answer to "what interface should my function take?". Three reasons:

1. **Flexibility for the consumer.** A function that takes \`io.Reader\` accepts files, network connections, byte buffers, gzip streams, and test fixtures. A function that takes \`*os.File\` accepts only files.
2. **Easy faking in tests.** One-method interfaces are trivial to fake.
3. **Evolution without breaking.** Adding a method to a composed interface (e.g. upgrading \`Cache\` to \`CacheWithHealth\`) lets callers opt into the new capability without forcing existing callers to update.

### Code-Review Lens (Senior Track)

Two patterns to flag:

1. **A single interface with ten methods.** Split. Use composition for the few consumers that need everything.
2. **Missing compile-time guard (\`var _ Iface = (*Type)(nil)\`).** For public implementations, the guard documents intent and catches signature drift at compile time. Add it.

### Staff Lens: Composition as a Versioning Strategy

Composition is the Go answer to interface versioning without breaking callers. Consider a shared \`Cache\` interface consumed by fifty services. The team needs to add a \`Stats() CacheStats\` method for observability. Adding it to \`Cache\` breaks every implementer. The composition-driven alternative:

\`\`\`go
type Cache interface { // unchanged
    Getter
    Setter
    Deleter
}

type CacheWithStats interface { // new, additive
    Cache
    Stats() CacheStats
}
\`\`\`

Consumers that need stats upgrade their parameter type to \`CacheWithStats\` at their own pace. Implementers add \`Stats()\` at their own pace. The two migrations decouple. The platform team writes one RFC, ships the new interface, and existing services keep compiling. This is how interface evolution scales past the small-team boundary where "just add a method and fix the breakage" stops working.

The companion discipline: when the new interface gains wide adoption and the old one is obsolete, schedule a deprecation and a removal. Interface-accretion without pruning is the platform anti-pattern that leaves a package with fifteen \`FooWithX\`, \`FooWithY\`, \`FooWithXAndY\` interfaces years later. Ship the deprecation with the first wave of the new interface so the cleanup is planned, not forgotten.

### Optional Capabilities via Runtime Composition Checks

A sibling pattern to static composition: check at runtime whether a value implements an extension interface. The stdlib does this frequently (\`net/http.Hijacker\`, \`io.ReaderFrom\`, \`io.WriterTo\`).

\`\`\`go
func CopyFast(dst Writer, src Reader) (int64, error) {
    if rf, ok := dst.(io.ReaderFrom); ok {
        return rf.ReadFrom(src)
    }
    if wt, ok := src.(io.WriterTo); ok {
        return wt.WriteTo(dst)
    }
    return genericCopy(dst, src)
}
\`\`\`

This is the pattern when a fast path is available on some implementations but not all. The interface design stays small for everyone. Implementers with the capability opt in by satisfying the extra interface. At staff level, this is the right escape hatch for "but we need this one method on some of the implementations". Do not widen the base interface. Add an optional extension interface and a runtime check.

---
`;
