## 35.1 Getting Started

### Connection Setup

The `go-redis/v9` client connects to Redis through `redis.NewClient`, which accepts an `Options` struct specifying the server address, password, and database number. Creating the client does not immediately open a connection. The connection pool establishes connections lazily on the first command. Call `Ping` after creation to verify connectivity and fail fast during application startup.

```go
package main

import (
    "context"
    "log"
    "time"

    "github.com/redis/go-redis/v9"
)

func main() {
    ctx := context.Background()

    // Basic connection
    rdb := redis.NewClient(&redis.Options{
        Addr:     "localhost:6379",
        Password: "",
        DB:       0,
    })

    // Verify connection
    if err := rdb.Ping(ctx).Err(); err != nil {
        log.Fatal(err)
    }

    defer rdb.Close()
}
```

### Advanced Connection Options

For production use, you need to configure timeouts, connection pool sizing, and retry behavior. `DialTimeout` controls how long the client waits to establish a TCP connection. `ReadTimeout` and `WriteTimeout` set per-command deadlines. `PoolSize` limits the maximum number of concurrent connections, and `MinIdleConns` keeps warm connections ready so that burst traffic does not wait for TCP handshakes. The `MaxRetries` setting controls automatic retry on transient failures like network blips.

The `go-redis` library also provides dedicated clients for Redis Cluster and Sentinel deployments. Use `NewClusterClient` when your data is sharded across multiple Redis nodes, and `NewFailoverClient` when you run a Sentinel-managed primary/replica pair for automatic failover. All three constructors connect identically to Valkey 7.2+ servers. The client has no knowledge of the upstream fork. For ElastiCache for Valkey or Memorystore for Valkey, supply the provider's cluster endpoint in `Addrs` and use TLS via `TLSConfig`.

**Picking a client.** `go-redis/v9` is the default choice: mature, idiomatic, well-documented, and covers 100% of the command surface. The alternative is `github.com/redis/rueidis`, which uses RESP3 and opportunistically pipelines commands issued concurrently from multiple goroutines onto a single connection. Published benchmarks show rueidis roughly 10x faster than go-redis under high parallelism and with sharply lower allocations, plus optional client-side caching (CSC) that can eliminate round-trips entirely on cache hits. The cost is a less familiar API and a smaller ecosystem of wrappers. Default to `go-redis` unless you have a measured throughput or GC pressure problem that rueidis solves.

```go
func setupRedis() *redis.Client {
    return redis.NewClient(&redis.Options{
        Addr:         "localhost:6379",
        Password:     "",
        DB:           0,
        DialTimeout:  5 * time.Second,
        ReadTimeout:  3 * time.Second,
        WriteTimeout: 3 * time.Second,
        PoolSize:     10,
        MinIdleConns: 5,
        MaxRetries:   3,
    })
}

// Cluster connection
func setupCluster() *redis.ClusterClient {
    return redis.NewClusterClient(&redis.ClusterOptions{
        Addrs: []string{
            "localhost:7000",
            "localhost:7001",
            "localhost:7002",
        },
        Password:     "",
        PoolSize:     10,
        MinIdleConns: 5,
    })
}

// Sentinel (high availability)
func setupSentinel() *redis.Client {
    return redis.NewFailoverClient(&redis.FailoverOptions{
        MasterName:    "mymaster",
        SentinelAddrs: []string{"localhost:26379", "localhost:26380"},
        Password:      "",
        DB:            0,
    })
}
```

### Junior → FAANG: what "getting started" leaves out and why it bites on day one

The snippet above will connect to Redis on localhost and return success. On a production host it will fail in five different ways that the snippet does not prepare you for, and each one is a learning milestone.

First, the context is `context.Background()` for illustration. In any real handler the context must flow from the caller and carry a deadline. `rdb.Ping(ctx).Err()` with a background context will wait `ReadTimeout` seconds on a dead server. `rdb.Ping(r.Context()).Err()` inside an HTTP handler inherits the request deadline, which is what you want. Any Redis call without a derived context is a code-review reject.

Second, the password is empty. On localhost that is fine. On any shared environment the password either comes from an environment variable loaded via a secret manager (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager) or from an IAM-auth token that you refresh every 15 minutes. Hardcoding a Redis password, even in a config file, is the kind of mistake that shows up in SAST scans and gets your PR rejected.

Third, the TLS config is missing. Managed Valkey at AWS, GCP, and Oracle defaults to TLS in transit. You must pass a `TLSConfig: &tls.Config{MinVersion: tls.VersionTLS13}` to connect. Without it you get a cryptic "EOF" error on the first command, not a helpful "TLS required" message, because Redis simply closes the socket.

Fourth, the pool size of 10 is a toy default. A correct pool size is a function of your workload concurrency and your per-command latency. Use the rule of thumb `PoolSize = max(10, 2 * GOMAXPROCS)` for general workloads and size up only after measuring pool saturation. Setting it too high wastes memory on both sides and can exhaust Redis's `maxclients` limit (default 10000). Setting it too low causes pool-wait latency that shows up as spooky p99 spikes.

Fifth, `MaxRetries: 3` is dangerous without context. go-redis retries idempotent commands automatically, but it cannot know whether your Lua script is idempotent. If you `EVAL` a script that does `INCR`, a retry on transient timeout can double-increment. For scripts and pipelines that are not idempotent, set `MaxRetries: -1` on that specific call path or wrap with application-level deduplication.

Worked example for a first-job ticket. "Add Redis to the user-service." The junior PR sets `Addr`, `Password`, `PoolSize`, calls `Ping` in `main`. The FAANG PR does all of that plus: loads password from Secrets Manager, sets TLS 1.3, derives per-request context with deadline, wires OpenTelemetry spans via `redisotel.InstrumentTracing(rdb)`, adds a Prometheus hook for command latency histograms, and includes a canary test that intentionally disconnects the TCP socket to verify the reconnection path works. That PR takes a day. The junior PR takes an hour and ships a latent outage.

### Senior @ FAANG: the getting-started ADR, client selection, and the 2026 RESP3 migration

At staff level the question "how do we connect to Redis" is an organization-wide ADR. The individual `NewClient` call is the last thing you write.

**Client selection with numbers.** In 2026 the three serious Go clients are go-redis/v9 (the actively maintained v9 line), rueidis v1.0, and mediocregopher/radix/v4 (still maintained but losing mindshare). go-redis is the safe default. rueidis is the performance option. The rueidis performance claim is not marketing: independent benchmarks (Redis Ltd.'s own, the benchmark in the rueidis README, and the one in the Valkey project) consistently show rueidis at 3x to 10x the throughput of go-redis on concurrent workloads, with roughly 90 percent fewer allocations, because rueidis pipelines concurrent commands from multiple goroutines onto a single RESP3 connection without user intervention. go-redis has supported RESP3 since v9.0 and defaults to it, but does not auto-pipeline across goroutines. The ADR pattern that has stuck at Uber, Shopify, and several banks: rueidis for tier-1 services where p99 Redis latency is in the request budget (auth, feature flags, rate limiting, session lookup, timeline reads), go-redis for tier-2 and batch (background jobs, admin tools, migrations). Do not let individual teams choose. Enforce the choice via a monorepo lint rule or a shared library wrapper, because mixing clients doubles on-call surface and client-side bugs (hung connections, leaked goroutines, retry-storm on failover) are expensive to debug.

**Pool sizing that is actually right.** The first-principles formula is: `PoolSize >= max concurrent in-flight commands`. For an HTTP service handling 1000 QPS with a median Redis latency of 1ms, concurrency is ~1 so a pool of 10 is fine. For a service doing 10000 QPS with 5ms latency, concurrency is 50 so you need at least 50 and probably 100 with headroom. Measure `rdb.PoolStats()` and alert when `TotalConns == PoolSize` for more than 30 seconds. Managed Valkey sets `maxclients` at the server, usually 65000, and each client across the fleet consumes slots, so pool size times replica count times client count must stay under that limit. At 500 Kubernetes pods with PoolSize 100 and two replicas per client, you are already at 100000 possible connections. Plan accordingly.

**Timeouts, deadlines, and the latency budget.** Rule set that has held up: `DialTimeout: 500ms` (TCP handshake plus TLS plus AUTH should be well under this on a warm DNS), `ReadTimeout: 200ms` (per-command, must be shorter than your upstream request timeout), `WriteTimeout: 200ms`, `PoolTimeout: 100ms` (wait for a free connection, fail fast if the pool is saturated), `ConnMaxIdleTime: 5m` (below load-balancer idle timeout, which is 60 seconds on AWS NLB and 10 minutes on GCP), `ConnMaxLifetime: 30m` (force connection rotation so that ACL and IAM token changes propagate). These are starting points, not dogma. Tune against your SLO.

**Retry policy and the idempotency matrix.** go-redis default is 3 retries with exponential backoff 8ms to 512ms. This is safe for reads and for commands that go-redis knows are idempotent (GET, HGET, EXISTS, etc.) but unsafe for custom Lua or for pipelines. For rueidis the default is also retry on transient errors but the pipelining semantics mean a retry replays the full in-flight batch, which you must consider in script design. Write a one-page idempotency matrix for your service: every Redis call path is tagged idempotent (safe to retry), idempotent-with-token (safe if a client-generated token deduplicates at the server, e.g., `SET key value NX` for locks), or non-idempotent (must not retry, e.g., `INCR` for critical counters, use application-level deduplication). This document goes into the service's design doc and is reviewed quarterly.

**Observability plumbing on day one.** `redisotel.InstrumentTracing(rdb)` adds OpenTelemetry spans per command. `redisotel.InstrumentMetrics(rdb)` adds latency histograms, pool stats, and error counters. rueidis has equivalent hooks via `rueidisotel`. Wire both into your service mesh's trace export so that a slow Redis call shows up in the same trace as the HTTP handler that invoked it. The single biggest productivity win when debugging Redis latency in production is being able to jump from a slow trace span to the SLOWLOG entry on the server side. The prefix-governance document from earlier is what lets you tag every command with an owner so that a p99 regression can be routed to the right team in under a minute.

**RESP3 migration in 2026.** Most orgs are still on RESP2 for historical reasons. RESP3 unlocks three things you cannot get on RESP2: server-assisted client-side caching with broadcast invalidation, richer reply types (maps, sets, doubles, booleans as first-class), and out-of-band push messages that do not interfere with pipelining. go-redis v9 negotiates RESP3 by default - set `Protocol: 2` in Options to force RESP2. rueidis requires RESP3 unconditionally. The migration is low risk (the server supports both) but requires verification that all your Lua scripts and custom command handlers tolerate the new reply shapes. Plan a dual-running period where RESP2 and RESP3 clients both hit the same server and compare metrics before declaring RESP3 the default.

**IAM and ACL integration.** AWS ElastiCache for Valkey supports IAM auth as of late 2024: the client exchanges an AWS STS token for a short-lived Redis auth token every 15 minutes. go-redis exposes this via `CredentialsProvider` (v9.5+). rueidis supports it via `AuthCredentialsFn`. For self-hosted Valkey or Redis, use ACL users scoped to prefixes per the prefix-governance document. The ADR must name: which auth mechanism per environment (IAM in AWS, Workload Identity in GCP, static password plus mTLS on-prem), how tokens rotate, and what happens when rotation fails (service degrades to read-only, triggers page, does not hard-fail). This is the difference between a cache tier that survives a credential-rotation day and one that takes down the site.

---
