## 18.16 Exercises with Solutions

### Exercise 1: Test a Rate Limiter

**Problem:** Implement tests for a token bucket rate limiter.

```go
type RateLimiter struct {
    tokens     float64
    maxTokens  float64
    refillRate float64 // tokens per second
    lastRefill time.Time
    mu         sync.Mutex
    now        func() time.Time
}

func NewRateLimiter(maxTokens, refillRate float64) *RateLimiter {
    return &RateLimiter{
        tokens:     maxTokens,
        maxTokens:  maxTokens,
        refillRate: refillRate,
        lastRefill: time.Now(),
        now:        time.Now,
    }
}

func (r *RateLimiter) Allow() bool {
    r.mu.Lock()
    defer r.mu.Unlock()

    r.refill()

    if r.tokens >= 1 {
        r.tokens--
        return true
    }
    return false
}

func (r *RateLimiter) refill() {
    now := r.now()
    elapsed := now.Sub(r.lastRefill).Seconds()
    r.tokens = math.Min(r.maxTokens, r.tokens+elapsed*r.refillRate)
    r.lastRefill = now
}
```

**Solution:**

```go
func TestRateLimiter(t *testing.T) {
    t.Run("allows requests within limit", func(t *testing.T) {
        limiter := NewRateLimiter(5, 1)

        for i := 0; i < 5; i++ {
            if !limiter.Allow() {
                t.Errorf("Request %d should be allowed", i)
            }
        }
    })

    t.Run("blocks requests over limit", func(t *testing.T) {
        limiter := NewRateLimiter(3, 1)

        // Exhaust tokens
        for i := 0; i < 3; i++ {
            limiter.Allow()
        }

        if limiter.Allow() {
            t.Error("Request should be blocked")
        }
    })

    t.Run("refills tokens over time", func(t *testing.T) {
        currentTime := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)

        limiter := NewRateLimiter(5, 10) // 10 tokens/second
        limiter.now = func() time.Time { return currentTime }
        limiter.lastRefill = currentTime

        // Exhaust tokens
        for i := 0; i < 5; i++ {
            limiter.Allow()
        }

        // Advance time by 500ms (should add 5 tokens)
        currentTime = currentTime.Add(500 * time.Millisecond)

        // Should allow 5 more requests
        for i := 0; i < 5; i++ {
            if !limiter.Allow() {
                t.Errorf("Request %d should be allowed after refill", i)
            }
        }
    })

    t.Run("concurrent access is safe", func(t *testing.T) {
        limiter := NewRateLimiter(100, 100)

        var wg sync.WaitGroup
        allowed := int64(0)

        for i := 0; i < 200; i++ {
            wg.Add(1)
            go func() {
                defer wg.Done()
                if limiter.Allow() {
                    atomic.AddInt64(&allowed, 1)
                }
            }()
        }

        wg.Wait()

        // Should allow roughly 100 requests
        if allowed > 110 || allowed < 90 {
            t.Errorf("Expected ~100 allowed, got %d", allowed)
        }
    })
}
```

### Exercise 2: Integration Test with Testcontainers

**Problem:** Write integration tests for a Redis cache using testcontainers.

**Solution:**

```go
//go:build integration

package cache

import (
    "context"
    "fmt"
    "testing"
    "time"

    "github.com/redis/go-redis/v9"
    "github.com/testcontainers/testcontainers-go"
    "github.com/testcontainers/testcontainers-go/wait"
)

func setupRedis(t *testing.T) *redis.Client {
    t.Helper()

    ctx := context.Background()

    req := testcontainers.ContainerRequest{
        Image:        "redis:7",
        ExposedPorts: []string{"6379/tcp"},
        WaitingFor:   wait.ForLog("Ready to accept connections"),
    }

    container, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
        ContainerRequest: req,
        Started:          true,
    })
    if err != nil {
        t.Fatalf("Failed to start Redis container: %v", err)
    }

    t.Cleanup(func() {
        container.Terminate(ctx)
    })

    host, _ := container.Host(ctx)
    port, _ := container.MappedPort(ctx, "6379")

    client := redis.NewClient(&redis.Options{
        Addr: fmt.Sprintf("%s:%s", host, port.Port()),
    })

    // Wait for Redis to be ready
    for i := 0; i < 30; i++ {
        if err := client.Ping(ctx).Err(); err == nil {
            break
        }
        time.Sleep(100 * time.Millisecond)
    }

    return client
}

func TestRedisCache_SetGet(t *testing.T) {
    client := setupRedis(t)
    cache := NewRedisCache(client)
    ctx := context.Background()

    // Test Set
    err := cache.Set(ctx, "key1", "value1", time.Minute)
    if err != nil {
        t.Fatalf("Set failed: %v", err)
    }

    // Test Get
    value, err := cache.Get(ctx, "key1")
    if err != nil {
        t.Fatalf("Get failed: %v", err)
    }
    if value != "value1" {
        t.Errorf("Get() = %s; want value1", value)
    }
}

func TestRedisCache_Expiration(t *testing.T) {
    client := setupRedis(t)
    cache := NewRedisCache(client)
    ctx := context.Background()

    // Set with short expiration
    err := cache.Set(ctx, "expiring", "value", 100*time.Millisecond)
    if err != nil {
        t.Fatal(err)
    }

    // Should exist immediately
    _, err = cache.Get(ctx, "expiring")
    if err != nil {
        t.Error("Key should exist immediately after set")
    }

    // Wait for expiration
    time.Sleep(200 * time.Millisecond)

    // Should be gone
    _, err = cache.Get(ctx, "expiring")
    if err != ErrNotFound {
        t.Error("Key should be expired")
    }
}

func TestRedisCache_Delete(t *testing.T) {
    client := setupRedis(t)
    cache := NewRedisCache(client)
    ctx := context.Background()

    cache.Set(ctx, "to_delete", "value", time.Minute)

    err := cache.Delete(ctx, "to_delete")
    if err != nil {
        t.Fatalf("Delete failed: %v", err)
    }

    _, err = cache.Get(ctx, "to_delete")
    if err != ErrNotFound {
        t.Error("Key should be deleted")
    }
}
```

### Exercise 3: Fuzzing a JSON Parser

**Problem:** Write fuzz tests for a custom JSON validator.

**Solution:**

```go
package validator

import (
    "encoding/json"
    "testing"
)

// Validator validates JSON structure against a schema
type Validator struct {
    schema Schema
}

type Schema struct {
    Required []string
    Types    map[string]string
}

func (v *Validator) Validate(data []byte) error {
    var obj map[string]any
    if err := json.Unmarshal(data, &obj); err != nil {
        return err
    }

    for _, field := range v.schema.Required {
        if _, ok := obj[field]; !ok {
            return fmt.Errorf("missing required field: %s", field)
        }
    }

    for field, expectedType := range v.schema.Types {
        if val, ok := obj[field]; ok {
            actualType := getType(val)
            if actualType != expectedType {
                return fmt.Errorf("field %s: expected %s, got %s",
                    field, expectedType, actualType)
            }
        }
    }

    return nil
}

func getType(v any) string {
    switch v.(type) {
    case string:
        return "string"
    case float64:
        return "number"
    case bool:
        return "boolean"
    case nil:
        return "null"
    case []any:
        return "array"
    case map[string]any:
        return "object"
    default:
        return "unknown"
    }
}

// Fuzz test
func FuzzValidator(f *testing.F) {
    v := &Validator{
        schema: Schema{
            Required: []string{"name"},
            Types: map[string]string{
                "name": "string",
                "age":  "number",
            },
        },
    }

    // Seed corpus with valid and invalid examples
    f.Add([]byte(`{"name": "Alice"}`))
    f.Add([]byte(`{"name": "Bob", "age": 30}`))
    f.Add([]byte(`{}`))
    f.Add([]byte(`{"name": 123}`))
    f.Add([]byte(`[]`))
    f.Add([]byte(`null`))
    f.Add([]byte(`"string"`))
    f.Add([]byte(`invalid json`))

    f.Fuzz(func(t *testing.T, data []byte) {
        // Validator should not panic on any input
        err := v.Validate(data)

        // If input is valid JSON object with required fields, no error
        var obj map[string]any
        if json.Unmarshal(data, &obj) == nil {
            if _, hasName := obj["name"]; hasName {
                if nameStr, ok := obj["name"].(string); ok && nameStr != "" {
                    // Valid object with name string should pass
                    if err != nil && err.Error() != "" {
                        // Check it's an expected error
                        if age, hasAge := obj["age"]; hasAge {
                            if _, isNum := age.(float64); !isNum {
                                // Age wrong type is expected error
                                return
                            }
                        }
                    }
                }
            }
        }
    })
}

// Property-based test
func FuzzValidatorInvariant(f *testing.F) {
    f.Add([]byte(`{"name":"x"}`))

    f.Fuzz(func(t *testing.T, data []byte) {
        v := &Validator{
            schema: Schema{
                Required: []string{"name"},
                Types:    map[string]string{"name": "string"},
            },
        }

        err1 := v.Validate(data)

        // Invariant: validating same data twice gives same result
        err2 := v.Validate(data)

        if (err1 == nil) != (err2 == nil) {
            t.Error("Validation not deterministic")
        }
    })
}
```

### Senior at FAANG Track

4. **Test-suite audit.** For one production service, measure: total wall-clock time, flake rate over the past month, coverage percentage, percentage of tests that are integration vs unit. Propose a plan to improve each metric.

5. **testing/synctest adoption.** Find tests that use `time.Sleep` or real timer waits. Convert to `testing/synctest`. Measure the speedup.

6. **Flake quarantine system.** Build or adopt a system that detects flaky tests automatically and quarantines them. Track flake rate as a team metric.

### Staff / Principal Track

7. **Org-wide test infrastructure.** Build the org's shared test helpers: database setup, HTTP client builders, assertion helpers, clock interface. Drive adoption across services.

8. **CI test-time SLO.** Set a wall-clock target for CI test runs (e.g., PRs under 10 minutes to green). Measure against it. Investigate regressions immediately.

9. **Coverage-quality program.** Move beyond line-coverage percentage. Define "meaningful coverage" for critical paths. Track coverage of error paths separately. Require tests for every incident postmortem fix.

10. **Test-quality review discipline.** Train the senior pool on reviewing tests for quality (behavior vs implementation, error-path coverage, flakiness resistance). Apply consistently. Measure the bug rate before and after.

---
