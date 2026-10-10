## Exercises with Complete Solutions

### Exercise 1: Custom Alias with Collision Handling

Implement custom alias support where users can choose their own short URLs. The solution must validate aliases against a reserved-word list (preventing users from claiming paths like `/api` or `/admin`), enforce length and character constraints, and handle the race condition where two users attempt to claim the same alias simultaneously by relying on a database unique constraint as the final arbiter.

```go
// exercise_custom_alias.go
package urlshortener

import (
    "context"
    "database/sql"
    "errors"
    "regexp"
    "strings"
    "time"
)

var (
    ErrAliasExists    = errors.New("alias already exists")
    ErrInvalidAlias   = errors.New("invalid alias format")
    ErrReservedAlias  = errors.New("alias is reserved")
)

// AliasValidator validates custom aliases
type AliasValidator struct {
    reservedWords map[string]bool
    aliasPattern  *regexp.Regexp
    minLength     int
    maxLength     int
}

func NewAliasValidator() *AliasValidator {
    return &AliasValidator{
        reservedWords: map[string]bool{
            "api": true, "admin": true, "login": true,
            "signup": true, "help": true, "about": true,
            "terms": true, "privacy": true, "dashboard": true,
        },
        aliasPattern: regexp.MustCompile(`^[a-zA-Z0-9_-]+$`),
        minLength:    3,
        maxLength:    30,
    }
}

func (v *AliasValidator) Validate(alias string) error {
    alias = strings.ToLower(strings.TrimSpace(alias))

    if len(alias) < v.minLength {
        return ErrInvalidAlias
    }
    if len(alias) > v.maxLength {
        return ErrInvalidAlias
    }
    if !v.aliasPattern.MatchString(alias) {
        return ErrInvalidAlias
    }
    if v.reservedWords[alias] {
        return ErrReservedAlias
    }

    return nil
}

// CustomAliasService handles custom alias URLs
type CustomAliasService struct {
    db        *sql.DB
    validator *AliasValidator
    generator IDGenerator
}

type CreateCustomURLRequest struct {
    LongURL     string
    CustomAlias string
    UserID      string
    ExpiresAt   *time.Time
}

func (s *CustomAliasService) CreateWithAlias(ctx context.Context, req CreateCustomURLRequest) (*ShortURL, error) {
    // 1. Validate alias if provided
    var shortCode string
    isCustom := false

    if req.CustomAlias != "" {
        // Normalize ONCE at the top. Checking existence with the
        // raw-case alias while inserting the lowercased form would
        // let "MyAlias" pass the pre-check even though "myalias"
        // already exists.
        alias := strings.ToLower(strings.TrimSpace(req.CustomAlias))

        if err := s.validator.Validate(alias); err != nil {
            return nil, err
        }

        // Check if alias exists
        exists, err := s.aliasExists(ctx, alias)
        if err != nil {
            return nil, err
        }
        if exists {
            return nil, ErrAliasExists
        }

        shortCode = alias
        isCustom = true
    } else {
        // Generate random short code
        var err error
        shortCode, err = s.generateUniqueCode(ctx)
        if err != nil {
            return nil, err
        }
    }

    // 2. Create URL entry
    url := &ShortURL{
        ShortCode: shortCode,
        LongURL:   req.LongURL,
        UserID:    req.UserID,
        IsCustom:  isCustom,
        CreatedAt: time.Now(),
        ExpiresAt: req.ExpiresAt,
    }

    // 3. Insert with conflict handling
    _, err := s.db.ExecContext(ctx, `
        INSERT INTO urls (short_code, long_url, user_id, is_custom, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `, url.ShortCode, url.LongURL, url.UserID, url.IsCustom, url.CreatedAt, url.ExpiresAt)

    if err != nil {
        // Handle race condition - alias taken between check and insert
        if isDuplicateKeyError(err) {
            return nil, ErrAliasExists
        }
        return nil, err
    }

    return url, nil
}

func (s *CustomAliasService) aliasExists(ctx context.Context, alias string) (bool, error) {
    var count int
    err := s.db.QueryRowContext(ctx,
        "SELECT COUNT(*) FROM urls WHERE short_code = ?", alias,
    ).Scan(&count)
    return count > 0, err
}

func (s *CustomAliasService) generateUniqueCode(ctx context.Context) (string, error) {
    for i := 0; i < 10; i++ {
        code := s.generator.Generate()
        exists, err := s.aliasExists(ctx, code)
        if err != nil {
            return "", err
        }
        if !exists {
            return code, nil
        }
    }
    return "", errors.New("failed to generate unique code")
}

func isDuplicateKeyError(err error) bool {
    return strings.Contains(err.Error(), "duplicate key") ||
           strings.Contains(err.Error(), "UNIQUE constraint")
}

type ShortURL struct {
    ShortCode string
    LongURL   string
    UserID    string
    IsCustom  bool
    CreatedAt time.Time
    ExpiresAt *time.Time
}

type IDGenerator interface {
    Generate() string
}
```

### Exercise 2: Rate Limiter for URL Creation

Implement per-user rate limiting for URL creation to prevent abuse. The rate limiter uses a Redis-backed sliding window counter with different hourly limits for anonymous users (10), authenticated users (100), and premium users (10,000). A Lua script performs the check-and-increment atomically on the Redis server, eliminating the TOCTOU race that would exist with separate GET and INCR commands.

```go
// exercise_rate_limiter.go
package urlshortener

import (
    "context"
    "fmt"
    "time"

    "github.com/redis/go-redis/v9"
)

// RateLimiter implements token bucket rate limiting
type RateLimiter struct {
    redis *redis.Client

    // Default limits
    anonymousLimit int64 // URLs per hour for anonymous users
    userLimit      int64 // URLs per hour for authenticated users
    premiumLimit   int64 // URLs per hour for premium users
}

func NewRateLimiter(redis *redis.Client) *RateLimiter {
    return &RateLimiter{
        redis:          redis,
        anonymousLimit: 10,
        userLimit:      100,
        premiumLimit:   10000,
    }
}

// RateLimitResult contains rate limit information
type RateLimitResult struct {
    Allowed   bool
    Remaining int64
    ResetAt   time.Time
    Limit     int64
}

// Check checks if a request is allowed
func (rl *RateLimiter) Check(ctx context.Context, identifier string, userType string) (*RateLimitResult, error) {
    limit := rl.getLimit(userType)
    key := fmt.Sprintf("ratelimit:%s:%s", userType, identifier)

    // Lua script for atomic check-and-increment
    script := redis.NewScript(`
        local key = KEYS[1]
        local limit = tonumber(ARGV[1])
        local window = tonumber(ARGV[2])
        local now = tonumber(ARGV[3])

        -- Get current count
        local count = tonumber(redis.call('GET', key) or '0')

        if count >= limit then
            local ttl = redis.call('TTL', key)
            return {0, limit - count, ttl}
        end

        -- Increment and set expiry
        local new_count = redis.call('INCR', key)
        if new_count == 1 then
            redis.call('EXPIRE', key, window)
        end

        local ttl = redis.call('TTL', key)
        return {1, limit - new_count, ttl}
    `)

    result, err := script.Run(ctx, rl.redis,
        []string{key},
        limit,
        3600, // 1 hour window
        time.Now().Unix(),
    ).Slice()

    if err != nil {
        return nil, fmt.Errorf("rate limit check failed: %w", err)
    }

    allowed := result[0].(int64) == 1
    remaining := result[1].(int64)
    ttl := result[2].(int64)

    return &RateLimitResult{
        Allowed:   allowed,
        Remaining: max(0, remaining),
        ResetAt:   time.Now().Add(time.Duration(ttl) * time.Second),
        Limit:     limit,
    }, nil
}

func (rl *RateLimiter) getLimit(userType string) int64 {
    switch userType {
    case "premium":
        return rl.premiumLimit
    case "user":
        return rl.userLimit
    default:
        return rl.anonymousLimit
    }
}

// Note: Uses builtin max() available since Go 1.21

// RateLimitedURLService wraps URL service with rate limiting
type RateLimitedURLService struct {
    service     *URLService
    rateLimiter *RateLimiter
}

func (s *RateLimitedURLService) CreateShortURL(ctx context.Context, req *CreateURLRequest) (*ShortURL, error) {
    // Determine identifier and user type
    identifier := req.UserID
    userType := "user"

    if identifier == "" {
        identifier = req.IPAddress
        userType = "anonymous"
    } else if req.IsPremium {
        userType = "premium"
    }

    // Check rate limit
    result, err := s.rateLimiter.Check(ctx, identifier, userType)
    if err != nil {
        return nil, err
    }

    if !result.Allowed {
        return nil, &RateLimitError{
            Remaining: result.Remaining,
            ResetAt:   result.ResetAt,
            Limit:     result.Limit,
        }
    }

    // Create URL
    return s.service.CreateShortURL(ctx, req)
}

type RateLimitError struct {
    Remaining int64
    ResetAt   time.Time
    Limit     int64
}

func (e *RateLimitError) Error() string {
    return fmt.Sprintf("rate limit exceeded: %d/%d, resets at %s",
        e.Limit-e.Remaining, e.Limit, e.ResetAt.Format(time.RFC3339))
}

type CreateURLRequest struct {
    LongURL   string
    UserID    string
    IPAddress string
    IsPremium bool
}

type URLService struct{}
func (s *URLService) CreateShortURL(ctx context.Context, req *CreateURLRequest) (*ShortURL, error) {
    return nil, nil
}
```

---

### Junior → FAANG: Building from Exercises to Production Fluency

The two exercises in this section cover real production problems. Working through them is more valuable than reading about them because implementation forces you to confront the details that descriptions gloss over.

**Exercise 1 (custom alias) teaches TOCTOU race handling.** The solution pattern is: validate the alias format, do a pre-check (`aliasExists`), then attempt the insert with a unique constraint. The pre-check is a performance optimization to avoid an unnecessary write. The unique constraint is the authoritative safety net. Relying on the pre-check alone creates a race condition: two concurrent requests for the same alias both pass the pre-check and then both attempt the insert. One succeeds, one fails with a duplicate key error. The `isDuplicateKeyError` function converts that database error into a typed `ErrAliasExists` that the handler can map to an HTTP 409. Practice this pattern: validate, pre-check, attempt, handle constraint violation.

**Exercise 2 (rate limiter) teaches atomic Lua scripting.** The Redis Lua script in the solution performs check-and-increment atomically. The critical insight: `GET` followed by `INCR` in Go code has a TOCTOU race. A Lua script executes atomically on the Redis server and no other command can interleave. The script also sets the expiry on the first increment (`if new_count == 1 then EXPIRE`), which is important: if you always call `EXPIRE`, you reset the window on every request, making the rate limit ineffective. Only set the expiry when the key is first created.

**Extend the exercises beyond what is written.** After implementing both exercises, try: adding a test for the alias race condition using two concurrent goroutines, adding a test for the rate limiter that fires 200 concurrent goroutines and asserts exactly 100 are allowed, and adding an in-memory fallback to the rate limiter that activates when Redis returns an error. These extensions take the exercises from "understand the pattern" to "understand the failure modes."

---

### Senior @ FAANG: Exercise Analysis as Design Review Practice

At L6/L7, you are frequently asked to review code written by junior engineers and identify correctness gaps, performance problems, and missing production concerns. The exercises in this section are good practice material for that skill.

**Exercise 1 review: what is missing from the custom alias implementation.** The `CreateWithAlias` function correctly handles the collision race by relying on the database unique constraint. However, it is missing: (1) a uniqueness guarantee across case variants at the database level (a case-insensitive unique index, or storing only the normalized form as the code now does, otherwise data imported from elsewhere can violate the invariant), (2) a limit on the maximum number of custom aliases per user (without this, a single user can exhaust the namespace), (3) an audit log of alias creation (who created this alias and when, which matters for abuse investigation), and (4) a mechanism to reclaim abandoned aliases (aliases that were created but the associated URL was deleted). A senior review identifies all four gaps.

**Exercise 2 review: what is missing from the rate limiter implementation.** The rate limiter correctly uses a Lua script for atomicity. However, it is missing: (1) a test for the case where Redis is unavailable (the current implementation returns an error which would block all URL creation), (2) the `X-RateLimit-*` response headers that well-behaved APIs return to clients so they can implement proactive rate limit awareness, (3) a monitoring metric for the rate limiter decision (allowed, denied, error) so that you can alert on abnormal denial rates, and (4) the distinction between "rate limited" (HTTP 429, temporary) and "quota exhausted" (HTTP 402 or 403, requires plan upgrade). A senior code review surfaces these gaps as required changes, not suggestions.

**The real production concern both exercises miss: observability.** Neither exercise emits structured logs or metrics for its decisions. In production, you need to know: what fraction of alias creation requests are denied (alias taken), what fraction are denied (reserved word), what fraction of rate limit checks are denied, and what the Redis error rate is. Without these metrics, you cannot distinguish "our rate limiting is working" from "our rate limiting is broken and silently allowing everything." Adding a `metrics.Counter` or `prometheus.CounterVec` to each decision point in both exercises would be a required change in a FAANG production service.
