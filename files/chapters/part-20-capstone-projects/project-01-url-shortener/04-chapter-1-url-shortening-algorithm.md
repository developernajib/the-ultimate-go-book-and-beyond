## Chapter 1: URL Shortening Algorithm

The heart of any URL shortener is the algorithm that converts a long URL into a short, unique code. In this chapter, you will learn how Base62 encoding works, how to generate short codes using different strategies, and how to handle the inevitable case where two URLs produce the same code. Understanding these fundamentals is critical because every other part of the system depends on fast, collision-free code generation.

### 1.1 Base62 Encoding

We'll use Base62 encoding (0-9, a-z, A-Z) to create short codes. This gives us 62^7 ≈ 3.5 trillion unique URLs with 7-character codes.

```go
// pkg/shortener/base62.go
package shortener

import (
	"math"
	"strings"
)

const (
	// Base62 character set (62 characters)
	base62Chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	base        = 62
)

// Encode converts a uint64 to a Base62 string
func Encode(num uint64) string {
	if num == 0 {
		return string(base62Chars[0])
	}

	var result strings.Builder
	for num > 0 {
		remainder := num % base
		result.WriteByte(base62Chars[remainder])
		num = num / base
	}

	// Reverse the string (since we built it backwards)
	encoded := result.String()
	return reverse(encoded)
}

// Decode converts a Base62 string to uint64
func Decode(encoded string) (uint64, error) {
	var num uint64
	for _, char := range encoded {
		pos := strings.IndexRune(base62Chars, char)
		if pos == -1 {
			return 0, ErrInvalidBase62Character
		}
		num = num*uint64(base) + uint64(pos) // Horner's method: avoid math.Pow
	}

	return num, nil
}

// reverse reverses a string
func reverse(s string) string {
	runes := []rune(s)
	for i, j := 0, len(runes)-1; i < j; i, j = i+1, j-1 {
		runes[i], runes[j] = runes[j], runes[i]
	}
	return string(runes)
}
```

### 1.2 Short Code Generation

We'll use multiple strategies for generating short codes:

1. **Counter-based**: Auto-incrementing ID encoded to Base62
2. **Hash-based**: MD5 hash of URL → take first 7 Base62 chars
3. **Custom alias**: User-provided short code (if available)

```go
// pkg/shortener/generator.go
package shortener

import (
	"crypto/md5"
	"encoding/binary"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var (
	ErrInvalidAlias            = errors.New("invalid alias: must be 3-20 alphanumeric characters")
	ErrInvalidBase62Character  = errors.New("invalid base62 character")
	ErrAliasAlreadyExists      = errors.New("alias already exists")
)

// Generator handles short code generation
type Generator struct {
	minLength int
	maxLength int
}

// NewGenerator creates a new code generator
func NewGenerator() *Generator {
	return &Generator{
		minLength: 6,
		maxLength: 10,
	}
}

// GenerateFromID creates a short code from an auto-incrementing ID
// This is deterministic and collision-free
func (g *Generator) GenerateFromID(id uint64) string {
	encoded := Encode(id)

	// Pad to minimum length if needed
	if len(encoded) < g.minLength {
		padding := strings.Repeat("0", g.minLength-len(encoded))
		return padding + encoded
	}

	return encoded
}

// GenerateFromURL creates a short code by hashing the URL
// This may have collisions but is consistent for the same URL
func (g *Generator) GenerateFromURL(url string) string {
	hash := md5.Sum([]byte(url))

	// Take first 8 bytes and convert to uint64
	num := binary.BigEndian.Uint64(hash[:8])

	encoded := Encode(num)

	// Take first 7 characters
	if len(encoded) > 7 {
		return encoded[:7]
	}

	return encoded
}

// ValidateCustomAlias validates a user-provided alias
func (g *Generator) ValidateCustomAlias(alias string) error {
	if len(alias) < 3 || len(alias) > 20 {
		return ErrInvalidAlias
	}

	// Only allow alphanumeric, hyphens, and underscores
	matched, _ := regexp.MatchString(`^[a-zA-Z0-9_-]+$`, alias)
	if !matched {
		return ErrInvalidAlias
	}

	// Reserved words that shouldn't be used as aliases
	reserved := map[string]bool{
		"api": true, "admin": true, "dashboard": true,
		"stats": true, "health": true, "metrics": true,
	}

	if reserved[strings.ToLower(alias)] {
		return fmt.Errorf("%w: alias is reserved", ErrInvalidAlias)
	}

	return nil
}
```

### 1.3 Collision Handling

Even with Base62, collisions can occur (especially with hash-based generation). We implement retry logic:

```go
// pkg/shortener/collision.go
package shortener

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
)

const maxRetries = 5

// CollisionResolver handles collision detection and resolution
type CollisionResolver struct {
	generator *Generator
	store     URLStore // Interface to check if code exists
}

// URLStore interface for checking code existence
type URLStore interface {
	CodeExists(ctx context.Context, code string) (bool, error)
}

// NewCollisionResolver creates a collision resolver
func NewCollisionResolver(store URLStore) *CollisionResolver {
	return &CollisionResolver{
		generator: NewGenerator(),
		store:     store,
	}
}

// ResolveCollision attempts to generate a unique code
func (r *CollisionResolver) ResolveCollision(ctx context.Context, baseCode string) (string, error) {
	for attempt := 0; attempt < maxRetries; attempt++ {
		// On first attempt, try the base code
		candidateCode := baseCode
		if attempt > 0 {
			// Add random suffix for subsequent attempts
			candidateCode = r.addRandomSuffix(baseCode)
		}

		exists, err := r.store.CodeExists(ctx, candidateCode)
		if err != nil {
			return "", fmt.Errorf("checking code existence: %w", err)
		}

		if !exists {
			return candidateCode, nil
		}
	}

	return "", fmt.Errorf("failed to resolve collision after %d attempts", maxRetries)
}

// addRandomSuffix adds a random character to the code
func (r *CollisionResolver) addRandomSuffix(code string) string {
	// Generate random number between 0-61
	n, _ := rand.Int(rand.Reader, big.NewInt(62))
	randomChar := base62Chars[n.Int64()]
	return code + string(randomChar)
}
```

### 1.4 Complete Shortener Service

Now let's tie it all together:

```go
// internal/service/shortener.go
package service

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"time"

	"github.com/yourusername/goshort/internal/models"
	"github.com/yourusername/goshort/pkg/shortener"
)

var (
	ErrInvalidURL     = errors.New("invalid URL")
	ErrURLTooLong     = errors.New("URL exceeds maximum length")
	ErrExpiredURL     = errors.New("URL has expired")
	ErrURLNotFound    = errors.New("URL not found")
	ErrRateLimitExceeded = errors.New("rate limit exceeded")
)

const (
	maxURLLength = 2048
)

// ShortenerService handles URL shortening operations
type ShortenerService struct {
	generator  *shortener.Generator
	resolver   *shortener.CollisionResolver
	repository URLRepository
	cache      CacheService
	analytics  AnalyticsService
	rateLimiter RateLimiter
}

// URLRepository defines database operations
type URLRepository interface {
	Create(ctx context.Context, url *models.URL) error
	GetByCode(ctx context.Context, code string) (*models.URL, error)
	GetByLongURL(ctx context.Context, longURL string) (*models.URL, error)
	CodeExists(ctx context.Context, code string) (bool, error)
	IncrementClicks(ctx context.Context, code string) error
}

// CacheService defines cache operations
type CacheService interface {
	Get(ctx context.Context, key string) (*models.URL, error)
	Set(ctx context.Context, key string, url *models.URL, ttl time.Duration) error
	Delete(ctx context.Context, key string) error
}

// AnalyticsService defines analytics operations
type AnalyticsService interface {
	RecordClick(ctx context.Context, event *models.ClickEvent) error
}

// RateLimiter defines rate limiting operations
type RateLimiter interface {
	Allow(ctx context.Context, identifier string) (bool, error)
}

// ShortenRequest represents a URL shortening request
type ShortenRequest struct {
	LongURL    string
	CustomAlias string
	ExpiresAt  *time.Time
	UserID     *int64 // nil for anonymous users
}

// ShortenResponse represents the shortening result
type ShortenResponse struct {
	ShortCode  string
	ShortURL   string
	LongURL    string
	CreatedAt  time.Time
	ExpiresAt  *time.Time
}

// NewShortenerService creates a new shortener service
func NewShortenerService(
	repo URLRepository,
	cache CacheService,
	analytics AnalyticsService,
	rateLimiter RateLimiter,
) *ShortenerService {
	gen := shortener.NewGenerator()
	return &ShortenerService{
		generator:   gen,
		resolver:    shortener.NewCollisionResolver(repo),
		repository:  repo,
		cache:       cache,
		analytics:   analytics,
		rateLimiter: rateLimiter,
	}
}

// Shorten creates a short URL
func (s *ShortenerService) Shorten(ctx context.Context, req *ShortenRequest) (*ShortenResponse, error) {
	// Validate URL
	if err := s.validateURL(req.LongURL); err != nil {
		return nil, err
	}

	// Check if URL already exists (optional: for deduplication)
	existing, err := s.repository.GetByLongURL(ctx, req.LongURL)
	if err == nil && existing != nil && req.CustomAlias == "" {
		// Return existing short URL (idempotent operation)
		return s.buildResponse(existing), nil
	}

	// Generate short code
	var shortCode string
	if req.CustomAlias != "" {
		// Use custom alias
		if err := s.generator.ValidateCustomAlias(req.CustomAlias); err != nil {
			return nil, err
		}

		exists, err := s.repository.CodeExists(ctx, req.CustomAlias)
		if err != nil {
			return nil, fmt.Errorf("checking alias: %w", err)
		}
		if exists {
			return nil, shortener.ErrAliasAlreadyExists
		}

		shortCode = req.CustomAlias
	} else {
		// Generate from hash and resolve collisions
		baseCode := s.generator.GenerateFromURL(req.LongURL)
		shortCode, err = s.resolver.ResolveCollision(ctx, baseCode)
		if err != nil {
			return nil, fmt.Errorf("generating short code: %w", err)
		}
	}

	// Create URL record
	urlRecord := &models.URL{
		ShortCode: shortCode,
		LongURL:   req.LongURL,
		CreatedAt: time.Now(),
		ExpiresAt: req.ExpiresAt,
		UserID:    req.UserID,
		Clicks:    0,
		Active:    true,
	}

	if err := s.repository.Create(ctx, urlRecord); err != nil {
		return nil, fmt.Errorf("storing URL: %w", err)
	}

	// Warm the cache
	_ = s.cache.Set(ctx, shortCode, urlRecord, 1*time.Hour)

	return s.buildResponse(urlRecord), nil
}

// GetURL retrieves the original URL by short code
func (s *ShortenerService) GetURL(ctx context.Context, code string) (*models.URL, error) {
	// Try cache first
	cached, err := s.cache.Get(ctx, code)
	if err == nil && cached != nil {
		return cached, nil
	}

	// Cache miss - query database
	urlRecord, err := s.repository.GetByCode(ctx, code)
	if err != nil {
		return nil, ErrURLNotFound
	}

	// Check expiration
	if urlRecord.ExpiresAt != nil && time.Now().After(*urlRecord.ExpiresAt) {
		return nil, ErrExpiredURL
	}

	if !urlRecord.Active {
		return nil, ErrURLNotFound
	}

	// Update cache
	_ = s.cache.Set(ctx, code, urlRecord, 1*time.Hour)

	return urlRecord, nil
}

// RecordClick records a click and returns the URL
func (s *ShortenerService) RecordClick(ctx context.Context, code string, event *models.ClickEvent) (*models.URL, error) {
	urlRecord, err := s.GetURL(ctx, code)
	if err != nil {
		return nil, err
	}

	// Increment counter asynchronously (fire and forget)
	go func() {
		_ = s.repository.IncrementClicks(context.Background(), code)
	}()

	// Record analytics event asynchronously
	event.ShortCode = code
	event.Timestamp = time.Now()
	go func() {
		_ = s.analytics.RecordClick(context.Background(), event)
	}()

	return urlRecord, nil
}

// validateURL validates the long URL
func (s *ShortenerService) validateURL(longURL string) error {
	if len(longURL) > maxURLLength {
		return ErrURLTooLong
	}

	parsedURL, err := url.Parse(longURL)
	if err != nil {
		return ErrInvalidURL
	}

	// Must have a scheme
	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return ErrInvalidURL
	}

	// Must have a host
	if parsedURL.Host == "" {
		return ErrInvalidURL
	}

	return nil
}

// buildResponse creates a ShortenResponse
func (s *ShortenerService) buildResponse(url *models.URL) *ShortenResponse {
	return &ShortenResponse{
		ShortCode: url.ShortCode,
		ShortURL:  fmt.Sprintf("https://goshort.io/%s", url.ShortCode),
		LongURL:   url.LongURL,
		CreatedAt: url.CreatedAt,
		ExpiresAt: url.ExpiresAt,
	}
}
```

---

### Junior → FAANG: Understanding the Algorithm Before the Interview

Interviewers frequently ask "walk me through your URL shortening algorithm." The right answer includes three elements: how you generate a code (hash or counter-based), how you encode it (Base62 gives a compact representation), and how you handle collisions (retry with a different salt or use a pre-generated pool).

Before your interview, be able to explain why 7 characters in Base62 gives 3.5 trillion unique codes, and why that is sufficient for a realistic URL shortener workload. Quantitative reasoning signals engineering maturity.

Hash-based generation (MD5 or SHA256 of the URL, then take the first N base62 characters) is simple but produces collisions under high write volume. Counter-based generation (auto-increment ID, then base62-encode it) avoids collisions but exposes sequential IDs, which allows competitors to enumerate your database. Know both approaches and be ready to discuss the tradeoff.

### Senior @ FAANG: Algorithm Selection as an Architectural Decision

At senior level, algorithm selection is inseparable from scalability and security requirements. Counter-based encoding with a global auto-increment is correct for a single-node system. At FAANG scale with multiple write nodes, a global counter becomes a bottleneck. The standard solution is range-based ID allocation: each application node claims a range of IDs from a central coordinator and generates codes within that range locally. That eliminates the coordinator from the critical path for most writes.

Security matters here in a non-obvious way. Sequential codes allow user enumeration: a competitor can iterate through adjacent codes to discover all URLs created in a time window. For an enterprise product, this is a compliance violation. The mitigation is to apply a deterministic permutation to the counter before base62 encoding, preserving uniqueness while eliminating sequentiality. The ADR for this decision should document the threat model that motivates the permutation.

Collision probability under hash-based generation deserves a quantitative ADR entry. By the birthday paradox, with a 7-character Base62 space (3.5 trillion codes), you expect the first collision around 1.9 million insertions, assuming uniform hash distribution. That is a real operational threshold: once a service approaches 1 million stored URLs, collision handling transitions from theoretical to operational. The senior engineer designs the retry logic and monitors collision rate as a service metric.

Pre-generation pools (generate a batch of valid codes offline, store in a pool table, hand out on demand) are used in production systems where write latency predictability matters more than storage efficiency. The tradeoff is operational complexity: the pool must be refilled asynchronously, and a depleted pool is a service-affecting condition that requires its own alert. Documenting that operational dependency is part of the architecture work, not an afterthought.

---
