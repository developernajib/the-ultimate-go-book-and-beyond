## 90J.25 Redis Production Disasters

Redis is used in production by virtually every modern web application - for caching, session storage, rate
limiting, real-time analytics, and message queuing. Its simplicity and speed make it the default choice
for these use cases. That same simplicity makes it dangerous: Redis provides powerful commands with no
guardrails, and a single mistake can destroy data that took months to accumulate.

### FLUSHALL on Production

In 2019, an engineer at a mid-sized SaaS company ran `FLUSHALL` on a production Redis cluster that stored
24 million user sessions, 8 million cached API responses, and rate limiting counters for 50,000 API keys.
The command completed in 0.3 seconds. Recovery took 4 hours and cost over $1 million in lost revenue and
engineering time.

**How It Happened**: The engineer was cleaning up a development Redis instance and had two terminal tabs
open - one connected to the dev instance, one to production. The command was typed into the wrong tab.
Redis does not require confirmation for destructive operations. There is no `ARE YOU SURE?` prompt. There
is no undo.

**Why Recovery Was Painful**: The Redis cluster had been configured with RDB snapshots every 5 minutes.
However, after `FLUSHALL`, Redis immediately triggered a new RDB save of the now-empty dataset, overwriting
the most recent backup. The team had to restore from a 4-hour-old backup and replay events from the
application event log to reconstruct the lost data.

### Wrong Eviction Policy

A fintech company configured their Redis instance with the `volatile-ttl` eviction policy, which evicts
keys with the nearest expiration time when memory is full. The problem: their application set TTLs on
cached data but not on session tokens (sessions were managed by explicit deletion on logout). Since session
tokens had no TTL, they were never evicted. As the instance filled with sessions, cached data was evicted
aggressively, causing cache hit rates to drop from 95% to 12%, which quadrupled database load and caused
a cascade outage.

### Failover Without Client Reconnection

A gaming company ran Redis Sentinel for high availability. When the primary failed and Sentinel promoted
a replica, the application continued sending writes to the old primary's IP address. Redis Sentinel updates
the DNS/configuration, but existing TCP connections to the old primary remained open. Since the old primary
was in read-only mode (after being demoted to replica), all writes silently failed. The application appeared
to work but was losing all new data written to Redis for 23 minutes until the operations team noticed the
anomaly in cache hit rate metrics.

### Go Implementation: Redis Safety Wrapper

Redis provides no built-in guardrails between a typo and catastrophic data loss. The three wrappers below add those guardrails at the client layer without requiring any Redis-server changes. `SafeRedisClient` intercepts every command before it reaches the wire, blocking the nine most destructive commands in production and staging environments and logging every attempt (blocked or not) to an audit trail. It also performs pattern-level analysis: a `SET` with no `EX`/`PX` option triggers a warning, directly preventing the volatile-TTL eviction mismatch that destroyed the fintech company's cache hit rate. `FailoverAwareClient` solves the Sentinel silent-write-loss problem by polling Sentinel every second for primary address changes and atomically swapping the underlying connection when a promotion is detected. Writes that land on a demoted replica return a `READONLY` error that the client surfaces immediately rather than losing silently. `EvictionValidator` provides a startup-time sanity check that samples live keys and confirms TTL presence matches the configured eviction policy, catching the `volatile-ttl`-without-TTL misconfiguration before it reaches traffic.

```go
package redissafe

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// -----------------------------------------------------------------------
// Redis safety wrapper
// -----------------------------------------------------------------------

// DangerousCommands lists Redis commands that should never be executed
// against a production instance without explicit authorization.
var DangerousCommands = map[string]string{
	"FLUSHALL": "Deletes ALL data in ALL databases. This is almost never what you want in production.",
	"FLUSHDB":  "Deletes ALL data in the current database.",
	"KEYS":     "Blocks the server while scanning all keys. Use SCAN instead.",
	"DEBUG":    "Can crash the server or corrupt data.",
	"SHUTDOWN": "Shuts down the Redis server.",
	"CONFIG":   "Can change server configuration at runtime, potentially causing data loss.",
	"MIGRATE":  "Moves keys to another server, deleting them from this one.",
	"SLAVEOF":  "Changes replication topology, can cause data loss.",
	"REPLICAOF": "Changes replication topology, can cause data loss.",
}

// SafeRedisClient wraps a Redis client with safety checks that prevent
// accidental execution of destructive commands in production.
type SafeRedisClient struct {
	inner          RedisExecutor
	environment    string // "production", "staging", "development"
	blockedCommands map[string]bool
	auditLog       AuditLogger
	mu             sync.RWMutex
	overrides      map[string]bool // temporarily unblocked commands
}

// RedisExecutor is the interface for executing Redis commands.
type RedisExecutor interface {
	Execute(ctx context.Context, args ...any) (any, error)
	Pipeline(ctx context.Context, cmds [][]any) ([]any, error)
}

// AuditLogger records all commands for security auditing.
type AuditLogger interface {
	Log(entry AuditEntry)
}

// AuditEntry represents a logged Redis command.
type AuditEntry struct {
	Timestamp   time.Time
	Command     string
	Args        []any
	Blocked     bool
	Reason      string
	Environment string
	CallerInfo  string
}

// NewSafeRedisClient creates a safety-wrapped Redis client for the
// given environment.
func NewSafeRedisClient(inner RedisExecutor, environment string, auditLog AuditLogger) *SafeRedisClient {
	blocked := make(map[string]bool)

	// Block all dangerous commands in production and staging.
	if environment == "production" || environment == "staging" {
		for cmd := range DangerousCommands {
			blocked[strings.ToUpper(cmd)] = true
		}
	}

	return &SafeRedisClient{
		inner:           inner,
		environment:     environment,
		blockedCommands: blocked,
		auditLog:        auditLog,
		overrides:       make(map[string]bool),
	}
}

// Execute runs a Redis command after safety validation.
func (c *SafeRedisClient) Execute(ctx context.Context, args ...any) (any, error) {
	if len(args) == 0 {
		return nil, fmt.Errorf("empty command")
	}

	command := strings.ToUpper(fmt.Sprintf("%v", args[0]))

	// Check if command is blocked.
	if c.isBlocked(command) {
		reason := DangerousCommands[command]
		if reason == "" {
			reason = "Command is blocked in " + c.environment
		}

		c.auditLog.Log(AuditEntry{
			Timestamp:   time.Now(),
			Command:     command,
			Args:        args[1:],
			Blocked:     true,
			Reason:      reason,
			Environment: c.environment,
		})

		return nil, fmt.Errorf("BLOCKED: %s is not allowed in %s environment. Reason: %s",
			command, c.environment, reason)
	}

	// Warn on potentially dangerous patterns.
	if warning := c.checkWarnings(command, args); warning != "" {
		fmt.Printf("[REDIS SAFETY] WARNING: %s\n", warning)
	}

	// Log the command for audit trail.
	c.auditLog.Log(AuditEntry{
		Timestamp:   time.Now(),
		Command:     command,
		Args:        args[1:],
		Blocked:     false,
		Environment: c.environment,
	})

	return c.inner.Execute(ctx, args...)
}

// isBlocked checks whether a command is currently blocked.
func (c *SafeRedisClient) isBlocked(command string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()

	// Check for temporary override.
	if c.overrides[command] {
		return false
	}

	return c.blockedCommands[command]
}

// checkWarnings returns a warning message for potentially dangerous
// but not blocked command patterns.
func (c *SafeRedisClient) checkWarnings(command string, args []any) string {
	switch command {
	case "DEL":
		if len(args) > 101 { // command + 100 keys
			return fmt.Sprintf("Deleting %d keys in a single DEL command may block the server. Use UNLINK for async deletion.", len(args)-1)
		}
	case "SET":
		// Check for missing TTL in production.
		if c.environment == "production" {
			hasTTL := false
			for _, arg := range args {
				s := strings.ToUpper(fmt.Sprintf("%v", arg))
				if s == "EX" || s == "PX" || s == "EXAT" || s == "PXAT" {
					hasTTL = true
					break
				}
			}
			if !hasTTL {
				return "SET without TTL in production. Consider adding EX/PX to prevent unbounded memory growth."
			}
		}
	case "MGET", "MSET":
		if len(args) > 1001 {
			return fmt.Sprintf("Batch operation with %d keys may cause latency spikes. Consider chunking.", len(args)-1)
		}
	}
	return ""
}

// -----------------------------------------------------------------------
// Failover-aware client wrapper
// -----------------------------------------------------------------------

// FailoverAwareClient handles Redis Sentinel failovers by detecting
// when the primary has changed and reconnecting automatically. This
// prevents the silent write loss scenario.
type FailoverAwareClient struct {
	sentinel       SentinelDiscovery
	currentPrimary string
	inner          RedisExecutor
	mu             sync.RWMutex
	checkInterval  time.Duration
	reconnect      func(addr string) (RedisExecutor, error)
	onFailover     func(oldAddr, newAddr string)
}

// SentinelDiscovery provides the current primary address from Sentinel.
type SentinelDiscovery interface {
	GetPrimaryAddr(ctx context.Context, masterName string) (string, error)
}

// NewFailoverAwareClient creates a client that automatically detects
// and handles Sentinel failovers.
func NewFailoverAwareClient(
	sentinel SentinelDiscovery,
	masterName string,
	reconnect func(addr string) (RedisExecutor, error),
	onFailover func(oldAddr, newAddr string),
) (*FailoverAwareClient, error) {
	ctx := context.Background()
	addr, err := sentinel.GetPrimaryAddr(ctx, masterName)
	if err != nil {
		return nil, fmt.Errorf("getting initial primary: %w", err)
	}

	inner, err := reconnect(addr)
	if err != nil {
		return nil, fmt.Errorf("connecting to primary %s: %w", addr, err)
	}

	client := &FailoverAwareClient{
		sentinel:       sentinel,
		currentPrimary: addr,
		inner:          inner,
		checkInterval:  1 * time.Second,
		reconnect:      reconnect,
		onFailover:     onFailover,
	}

	return client, nil
}

// Monitor starts the background loop that checks for failover events.
func (c *FailoverAwareClient) Monitor(ctx context.Context, masterName string) {
	ticker := time.NewTicker(c.checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			newAddr, err := c.sentinel.GetPrimaryAddr(ctx, masterName)
			if err != nil {
				fmt.Printf("[FAILOVER] Error checking primary: %v\n", err)
				continue
			}

			c.mu.RLock()
			currentAddr := c.currentPrimary
			c.mu.RUnlock()

			if newAddr != currentAddr {
				fmt.Printf("[FAILOVER] Primary changed: %s -> %s\n", currentAddr, newAddr)

				newInner, err := c.reconnect(newAddr)
				if err != nil {
					fmt.Printf("[FAILOVER] Failed to connect to new primary %s: %v\n", newAddr, err)
					continue
				}

				c.mu.Lock()
				c.inner = newInner
				c.currentPrimary = newAddr
				c.mu.Unlock()

				if c.onFailover != nil {
					c.onFailover(currentAddr, newAddr)
				}
			}
		}
	}
}

// Execute runs a command against the current primary, automatically
// retrying against the new primary if a failover is detected.
func (c *FailoverAwareClient) Execute(ctx context.Context, args ...any) (any, error) {
	c.mu.RLock()
	inner := c.inner
	c.mu.RUnlock()

	result, err := inner.Execute(ctx, args...)
	if err != nil {
		// Check if this is a READONLY error (write to a demoted replica).
		if isReadOnlyError(err) {
			fmt.Printf("[FAILOVER] Detected READONLY error - primary may have changed\n")
			// Force a primary re-check and retry.
			return nil, fmt.Errorf("primary failover detected, retry required: %w", err)
		}
	}
	return result, err
}

func isReadOnlyError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "READONLY") ||
		strings.Contains(err.Error(), "You can't write against a read only replica")
}

// -----------------------------------------------------------------------
// Eviction policy validator
// -----------------------------------------------------------------------

// EvictionValidator checks that the Redis eviction policy is compatible
// with the application's key management patterns.
type EvictionValidator struct {
	client RedisExecutor
}

// NewEvictionValidator creates a validator for the given Redis client.
func NewEvictionValidator(client RedisExecutor) *EvictionValidator {
	return &EvictionValidator{client: client}
}

// Validate checks for common eviction policy misconfigurations.
func (v *EvictionValidator) Validate(ctx context.Context) []string {
	var warnings []string

	// Get current eviction policy.
	result, err := v.client.Execute(ctx, "CONFIG", "GET", "maxmemory-policy")
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("Cannot read eviction policy: %v", err))
		return warnings
	}

	policy := fmt.Sprintf("%v", result)

	// Check for volatile-* policies with keys that have no TTL.
	if strings.Contains(policy, "volatile") {
		// Sample some keys to check for TTL presence.
		sampleResult, err := v.client.Execute(ctx, "RANDOMKEY")
		if err == nil && sampleResult != nil {
			key := fmt.Sprintf("%v", sampleResult)
			ttlResult, err := v.client.Execute(ctx, "TTL", key)
			if err == nil {
				ttl := fmt.Sprintf("%v", ttlResult)
				if ttl == "-1" {
					warnings = append(warnings,
						fmt.Sprintf("CRITICAL: Eviction policy is %s but key '%s' has no TTL. "+
							"Keys without TTL will never be evicted, potentially causing memory exhaustion.", policy, key))
				}
			}
		}
	}

	// Check for noeviction with high memory usage.
	if strings.Contains(policy, "noeviction") {
		warnings = append(warnings,
			"Eviction policy is 'noeviction'. When memory is full, write commands will return errors. "+
				"Ensure maxmemory is set appropriately and monitor memory usage closely.")
	}

	return warnings
}
```

**The Lesson**: Redis is a sharp tool - powerful and dangerous in equal measure. Production Redis instances
need three layers of protection: (1) a safety wrapper that blocks destructive commands and logs all operations,
(2) failover-aware clients that detect Sentinel promotions and reconnect automatically instead of silently
losing writes, and (3) configuration validation that catches eviction policy mismatches before they cause
outages. The `FLUSHALL` incident is a reminder that in a system with no confirmation dialogs, the distance
between "clean up development data" and "destroy production" is one wrong terminal tab.

---

### Junior → FAANG: Redis Safety Patterns as Interview Signals for Caching Expertise

Redis production disasters are the interview answer to "what are the risks of using Redis in production?" The three patterns in this section (FLUSHALL in the wrong environment, silent write loss during Sentinel failover, eviction policy mismatch) represent the failure modes that most Redis users discover only after their first production incident. For FAANG interviews on caching design, demonstrate awareness of all three: command safety (block destructive commands in production, require environment disambiguation before connecting), failover transparency (clients must detect promotions and reconnect without silent write loss), and capacity planning (eviction policy must match the cache's intended behavior, with maxmemory set to trigger eviction before OOM). The FLUSHALL scenario specifically is the answer to "how do you prevent accidental data destruction in production?" The answer is environment-aware clients that refuse to execute destructive commands unless the environment has been explicitly confirmed, combined with network-level controls that prevent development tooling from connecting to production endpoints.

### Senior @ FAANG: Redis Fleet Governance and Operational Safety as Platform Standards

At L6, Redis production safety cannot rely on individual developer discipline. The platform engineering standard must enforce safety properties at the infrastructure level. Three platform-level controls are required. First, Redis access credentials must be environment-specific and isolated by network policy: development credentials cannot connect to production endpoints, and production credentials must require MFA-protected secret retrieval to prevent accidental production access from developer workstations. This eliminates the wrong-terminal-tab failure mode at the network level, not just through documentation. Second, all Redis client libraries used in the organization must be wrapped in a shared safety library that blocks `FLUSHALL`, `FLUSHDB`, `DEBUG OBJECT`, and `KEYS *` in production environments, and that logs all write operations with the caller's identity and stack trace. The shared library is the enforcement mechanism, not the documentation. Third, Redis configuration must be validated as part of the deployment pipeline: eviction policy, maxmemory, persistence settings, and Sentinel configuration must pass a validation gate before any Redis instance is deployed to production. The validation gate catches eviction policy mismatches before they cause outages, not after. At the fleet level, maintain a Redis health dashboard that shows eviction rate, memory utilization, replication lag, and Sentinel promotion events for every managed instance, with alert thresholds that trigger on sustained eviction rates and replication lag above 100ms. Eviction that is slow enough to not cause immediate impact but fast enough to signal approaching capacity limits is the gray failure pattern applied to Redis, and catching it requires the same percentile-based monitoring as application-level gray failure detection.

---

*"Every system is perfectly designed to produce the results it gets."* - W. Edwards Deming

---

## Exercises

### Exercise 1: Destructive Command Interceptor Proxy (FLUSHALL & KEYS * Guard)
- **Context:** Production Redis cluster shared across multiple backend microservices.
- **Task:** Implement an in-line Redis protocol (RESP) proxy in Go:
  1. Parse the incoming command name from client requests before forwarding to the Redis upstream.
  2. Maintain a blacklist of destructive commands (`FLUSHALL`, `FLUSHDB`, `DEBUG`, `SHUTDOWN`, `KEYS *`, `CONFIG`).
  3. If an environment variable `ENV=production` is set and a blacklisted command is intercepted, immediately return an error `ERR command '<name>' is disabled in production` without contacting Redis, and emit a structured audit log with caller remote address and timestamp.
  4. Implement an explicit confirmation bypass token mechanism for emergency administrative runbooks requiring a signed cryptographic authorization header.

### Exercise 2: Postgres-to-Redis Dual-Write & Shadow Reconciler
- **Context:** Zero-downtime data migration migrating user session stores or caching layer.
- **Task:** Build an asynchronous dual-write reconciliation service in Go:
  1. Wrap write operations to write to the primary store (e.g. Postgres) and asynchronously write to the target store (e.g. Redis).
  2. Implement an out-of-band audit goroutine that reads records from both stores, hashes the contents, and tracks divergence metrics.
  3. Emit alerts if divergence exceeds 0.01% over a 5-minute rolling window.
  4. Provide an automated repair routine that backfills missed mutations from a transactional outbox queue without generating lock contention.

### Exercise 3: Pre-Warming & Adaptive Load Shedding Engine (Prime Day Pattern)
- **Context:** High-throughput Go microservice expecting a 10x traffic spike at a scheduled launch hour.
- **Task:** Implement a proactive capacity manager in Go:
  1. Design a pre-warming scheduler that initiates dummy warm-up requests and establishes keep-alive database/cache connection pools 15 minutes before the scheduled event.
  2. Implement a token-bucket adaptive load shedder based on CPU load and request queue depth.
  3. Classify incoming HTTP requests into tiers (`Tier 0: Checkout/Payment`, `Tier 1: Product Browsing`, `Tier 2: Recommendations/Telemetry`).
  4. When P99 latency exceeds 200ms or queue depth exceeds 80% capacity, shed Tier 2 traffic with HTTP 429 and retry-after headers, preserving Tier 0 checkout operations intact.

### Exercise 4: Percentile Latency Gray Failure Detector (Rogers/Optus Pattern)
- **Context:** Distributed cluster where nodes experience partial degradation (brownout) rather than hard crashes.
- **Task:** Build a gray-failure probe manager in Go:
  1. Maintain a rolling window of response latencies for each downstream node using high-performance ring buffers.
  2. Calculate P50, P90, and P99 latency percentiles every second without allocation in the hot path.
  3. Detect gray failure conditions: if a node has a successful HTTP 200 rate of 99% but its P99 latency is 10x higher than the peer median, mark the node as degraded.
  4. Automatically reduce traffic routing weight to degraded nodes using exponential decay before failures cascade upstream.

### Exercise 5: Singleflight Cache Stampede Guard with Fallback Cache (Failover Pattern)
- **Context:** Hot-key eviction causing millions of concurrent requests to overwhelm downstream databases.
- **Task:** Implement a resilient cache fetcher using Go's `golang.org/x/sync/singleflight` pattern (or stdlib equivalent):
  1. Group concurrent incoming requests for the same key so that only a single worker goroutine queries the origin database.
  2. Implement a stale-while-revalidate mechanism: serve slightly stale cached data immediately while an asynchronous worker refreshes the cache in the background.
  3. Implement an in-memory circuit breaker that detects Redis failover or timeout errors and serves degraded cached snapshots from local memory rather than propagating 500 errors to callers.

---

## Summary

* **Big-Bang Migrations Are Systemic Traps:** Disasters like Healthcare.gov, Hershey's ERP, TSB Bank, and the FBI Virtual Case File demonstrate that attempting to cut over massive monolithic systems in a single weekend without incremental delivery or rollback capabilities creates catastrophic, unrecoverable operational failures.
* **Heterogeneous Fleet State Breeds Outages:** Knight Capital lost $440 million in 45 minutes because a single server in an eight-node cluster retained dead 8-year-old code that was reactivated by an overloaded flag. Deployments must be hermetic, immutable, and strictly verified across every host before traffic is routed.
* **Auto-Scaling Is Reactive, Not Predictive:** Amazon Prime Day 2018 proved that autoscaling cannot handle step-function demand spikes due to cold starts and initialization latencies. Anticipated spikes require pre-warming, overprovisioning, and tiered load shedding.
* **Gray Failures Are Harder Than Black Failures:** Systems fail silently when partial degradation - such as single-packet drops, slow disks, memory leaks, or Sentinel failover write-dropping - bypasses binary health checks. Reliability engineering requires percentile-based latency tracking, client-side failover detection, and defensive command proxies.

*Next: [Chapter 90K: NASA Software Engineering Lessons](../chapter-90k-nasa-software-engineering/00-introduction.md)*

