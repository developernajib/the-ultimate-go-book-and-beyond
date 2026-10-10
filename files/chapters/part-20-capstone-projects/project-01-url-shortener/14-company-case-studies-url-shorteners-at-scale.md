## Company Case Studies: URL Shorteners at Scale

The best way to learn production engineering is to study how real companies solve the same problems at massive scale. The case studies below show how Bitly, Rebrandly, Twitter, and AWS each take a different approach to URL shortening based on their unique requirements. Pay attention to the architectural trade-offs each company makes: Bitly optimizes for analytics, Twitter optimizes for throughput, Rebrandly optimizes for custom domains, and AWS optimizes for security.

### Bitly: Enterprise URL Shortening

Bitly processes billions of links with sub-millisecond redirects:

```go
// Bitly-style URL shortener with analytics pipeline
package bitly

import (
    "context"
    "crypto/sha256"
    "encoding/base62"
    "sync"
    "time"

    "github.com/redis/go-redis/v9"
    "github.com/segmentio/kafka-go"
)

// LinkService handles URL shortening with real-time analytics
type LinkService struct {
    redis        *redis.ClusterClient
    kafkaWriter  *kafka.Writer
    cache        *sync.Map
    hashRing     *ConsistentHashRing
}

// Link represents a shortened URL with metadata
type Link struct {
    ID           string    `json:"id"`
    ShortCode    string    `json:"short_code"`
    OriginalURL  string    `json:"original_url"`
    CustomAlias  string    `json:"custom_alias,omitempty"`
    CreatedAt    time.Time `json:"created_at"`
    ExpiresAt    *time.Time `json:"expires_at,omitempty"`
    ClickCount   int64     `json:"click_count"`
    Tags         []string  `json:"tags,omitempty"`
    CampaignID   string    `json:"campaign_id,omitempty"`
    UserID       string    `json:"user_id"`
    DeepLinkData *DeepLink `json:"deep_link,omitempty"`
}

// DeepLink for mobile app routing
type DeepLink struct {
    IOSScheme     string `json:"ios_scheme"`
    AndroidScheme string `json:"android_scheme"`
    FallbackURL   string `json:"fallback_url"`
}

// ClickEvent for analytics pipeline
type ClickEvent struct {
    LinkID      string            `json:"link_id"`
    ShortCode   string            `json:"short_code"`
    Timestamp   time.Time         `json:"timestamp"`
    IP          string            `json:"ip"`
    UserAgent   string            `json:"user_agent"`
    Referer     string            `json:"referer"`
    Country     string            `json:"country"`
    City        string            `json:"city"`
    Device      string            `json:"device"`
    Browser     string            `json:"browser"`
    OS          string            `json:"os"`
    UTMParams   map[string]string `json:"utm_params,omitempty"`
}

// Shorten creates a shortened URL with enterprise features
func (s *LinkService) Shorten(ctx context.Context, req *ShortenRequest) (*Link, error) {
    // Generate unique short code
    var shortCode string
    if req.CustomAlias != "" {
        // Validate custom alias availability
        exists, err := s.redis.Exists(ctx, "alias:"+req.CustomAlias).Result()
        if err != nil {
            return nil, err
        }
        if exists > 0 {
            return nil, ErrAliasExists
        }
        shortCode = req.CustomAlias
    } else {
        shortCode = s.generateShortCode(req.URL)
    }

    link := &Link{
        ID:          generateUUID(),
        ShortCode:   shortCode,
        OriginalURL: req.URL,
        CustomAlias: req.CustomAlias,
        CreatedAt:   time.Now(),
        UserID:      req.UserID,
        Tags:        req.Tags,
        CampaignID:  req.CampaignID,
        DeepLinkData: req.DeepLink,
    }

    if req.TTL > 0 {
        expiresAt := time.Now().Add(req.TTL)
        link.ExpiresAt = &expiresAt
    }

    // Store in Redis cluster with automatic sharding
    pipe := s.redis.Pipeline()

    // Main link data
    pipe.HSet(ctx, "link:"+shortCode, map[string]any{
        "url":        link.OriginalURL,
        "created_at": link.CreatedAt.Unix(),
        "user_id":    link.UserID,
    })

    if link.ExpiresAt != nil {
        pipe.ExpireAt(ctx, "link:"+shortCode, *link.ExpiresAt)
    }

    // Alias mapping
    pipe.Set(ctx, "alias:"+shortCode, link.ID, 0)

    // User's links index
    pipe.SAdd(ctx, "user:"+link.UserID+":links", shortCode)

    _, err := pipe.Exec(ctx)
    if err != nil {
        return nil, err
    }

    // Cache locally for hot links
    s.cache.Store(shortCode, link.OriginalURL)

    return link, nil
}

// Resolve performs sub-millisecond URL resolution
func (s *LinkService) Resolve(ctx context.Context, shortCode string) (string, error) {
    // L1: Local cache (sub-100μs)
    if url, ok := s.cache.Load(shortCode); ok {
        return url.(string), nil
    }

    // L2: Redis cluster
    url, err := s.redis.HGet(ctx, "link:"+shortCode, "url").Result()
    if err != nil {
        if err == redis.Nil {
            return "", ErrLinkNotFound
        }
        return "", err
    }

    // Populate local cache for hot links
    s.cache.Store(shortCode, url)

    return url, nil
}

// RecordClick asynchronously records click analytics
func (s *LinkService) RecordClick(ctx context.Context, event *ClickEvent) error {
    data, err := json.Marshal(event)
    if err != nil {
        return err
    }

    // Publish to Kafka for async processing
    return s.kafkaWriter.WriteMessages(ctx, kafka.Message{
        Key:   []byte(event.ShortCode),
        Value: data,
        Time:  event.Timestamp,
    })
}

func (s *LinkService) generateShortCode(url string) string {
    hash := sha256.Sum256([]byte(url + time.Now().String()))
    return base62.EncodeToString(hash[:])[:7]
}
```

### TinyURL/Rebrandly: Custom Domain Shortening

Support for branded domains with SSL:

```go
// Custom domain URL shortening like Rebrandly
package rebrandly

import (
    "context"
    "crypto/tls"
    "net/http"
    "sync"

    "golang.org/x/crypto/acme/autocert"
)

// DomainService manages custom branded domains
type DomainService struct {
    certManager *autocert.Manager
    domains     map[string]*CustomDomain
    mu          sync.RWMutex
}

// CustomDomain represents a branded domain
type CustomDomain struct {
    Domain      string `json:"domain"`
    WorkspaceID string `json:"workspace_id"`
    Verified    bool   `json:"verified"`
    SSL         bool   `json:"ssl"`
    RootRedirect string `json:"root_redirect"`
    NotFoundURL string `json:"not_found_url"`
}

// NewDomainService creates a domain service with auto SSL
func NewDomainService() *DomainService {
    s := &DomainService{
        domains: make(map[string]*CustomDomain),
    }

    s.certManager = &autocert.Manager{
        Prompt:     autocert.AcceptTOS,
        HostPolicy: s.hostPolicy,
        Cache:      autocert.DirCache("/var/certs"),
    }

    return s
}

// hostPolicy validates that we should provision certs for this domain
func (s *DomainService) hostPolicy(ctx context.Context, host string) error {
    s.mu.RLock()
    defer s.mu.RUnlock()

    domain, exists := s.domains[host]
    if !exists || !domain.Verified {
        return fmt.Errorf("domain not authorized: %s", host)
    }

    return nil
}

// AddDomain adds a custom domain with DNS verification
func (s *DomainService) AddDomain(ctx context.Context, domain *CustomDomain) error {
    // Generate DNS verification record
    verificationRecord := generateVerificationRecord(domain.Domain)

    // Store pending domain
    s.mu.Lock()
    s.domains[domain.Domain] = domain
    s.mu.Unlock()

    return nil
}

// VerifyDomain checks DNS records for domain verification
func (s *DomainService) VerifyDomain(ctx context.Context, domainName string) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    domain, exists := s.domains[domainName]
    if !exists {
        return ErrDomainNotFound
    }

    // Check DNS TXT record
    records, err := net.LookupTXT("_rebrandly-verify." + domainName)
    if err != nil {
        return fmt.Errorf("DNS lookup failed: %w", err)
    }

    expectedRecord := generateVerificationRecord(domainName)
    for _, record := range records {
        if record == expectedRecord {
            domain.Verified = true
            return nil
        }
    }

    return ErrDomainNotVerified
}

// GetTLSConfig returns TLS config with auto-provisioned certificates
func (s *DomainService) GetTLSConfig() *tls.Config {
    return s.certManager.TLSConfig()
}
```

### Twitter/X: High-Throughput URL Shortening

Twitter's t.co processes billions of clicks:

```go
// Twitter t.co style URL shortener
package tco

import (
    "context"
    "sync"
    "sync/atomic"
    "time"

    "github.com/cespare/xxhash/v2"
)

// HighThroughputShortener handles millions of requests per second
type HighThroughputShortener struct {
    shards      []*shard
    numShards   int
    bloomFilter *BloomFilter
    counter     atomic.Uint64
}

type shard struct {
    mu    sync.RWMutex
    links map[string]string // shortCode -> originalURL
}

// NewHighThroughputShortener creates a sharded URL shortener
func NewHighThroughputShortener(numShards int) *HighThroughputShortener {
    s := &HighThroughputShortener{
        shards:      make([]*shard, numShards),
        numShards:   numShards,
        bloomFilter: NewBloomFilter(1_000_000_000, 0.01), // 1B entries, 1% FPR
    }

    for i := 0; i < numShards; i++ {
        s.shards[i] = &shard{
            links: make(map[string]string),
        }
    }

    return s
}

// Shorten creates a unique short code with minimal locking
func (s *HighThroughputShortener) Shorten(ctx context.Context, url string) (string, error) {
    // Fast path: check if URL already exists via bloom filter
    if s.bloomFilter.MayContain([]byte(url)) {
        // Slow path: verify actual existence
        if shortCode, exists := s.findExisting(url); exists {
            return shortCode, nil
        }
    }

    // Generate new short code
    shortCode := s.generateShortCode()
    shard := s.getShard(shortCode)

    shard.mu.Lock()
    shard.links[shortCode] = url
    shard.mu.Unlock()

    s.bloomFilter.Add([]byte(url))

    return shortCode, nil
}

// Resolve looks up URL with minimal lock contention
func (s *HighThroughputShortener) Resolve(ctx context.Context, shortCode string) (string, error) {
    shard := s.getShard(shortCode)

    shard.mu.RLock()
    url, exists := shard.links[shortCode]
    shard.mu.RUnlock()

    if !exists {
        return "", ErrNotFound
    }

    return url, nil
}

func (s *HighThroughputShortener) getShard(key string) *shard {
    hash := xxhash.Sum64String(key)
    return s.shards[hash%uint64(s.numShards)]
}

func (s *HighThroughputShortener) generateShortCode() string {
    // Base62 encoding of atomic counter for guaranteed uniqueness
    counter := s.counter.Add(1)
    return base62Encode(counter)
}
```

### AWS S3: Presigned URL Shortening

Secure short links for private content:

```go
// Presigned URL shortener for secure S3 access
package presigned

import (
    "context"
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "time"

    "github.com/aws/aws-sdk-go-v2/service/s3"
)

// SecureShortener creates short links for presigned URLs
type SecureShortener struct {
    s3Client    *s3.Client
    linkStore   LinkStore
    signingKey  []byte
}

// SecureLink represents a short link with access control
type SecureLink struct {
    ShortCode     string        `json:"short_code"`
    Bucket        string        `json:"bucket"`
    Key           string        `json:"key"`
    ExpiresAt     time.Time     `json:"expires_at"`
    MaxDownloads  int           `json:"max_downloads"`
    DownloadCount int           `json:"download_count"`
    Password      string        `json:"password,omitempty"`
    AllowedIPs    []string      `json:"allowed_ips,omitempty"`
    Signature     string        `json:"signature"`
}

// CreateSecureLink generates a short link with access controls
func (s *SecureShortener) CreateSecureLink(ctx context.Context, req *SecureLinkRequest) (*SecureLink, error) {
    link := &SecureLink{
        ShortCode:    generateSecureCode(),
        Bucket:       req.Bucket,
        Key:          req.Key,
        ExpiresAt:    time.Now().Add(req.TTL),
        MaxDownloads: req.MaxDownloads,
        AllowedIPs:   req.AllowedIPs,
    }

    if req.Password != "" {
        link.Password = hashPassword(req.Password)
    }

    // Sign the link for integrity verification
    link.Signature = s.signLink(link)

    // Store link metadata
    if err := s.linkStore.Save(ctx, link); err != nil {
        return nil, err
    }

    return link, nil
}

// Resolve validates and returns presigned S3 URL
func (s *SecureShortener) Resolve(ctx context.Context, shortCode, password, clientIP string) (string, error) {
    link, err := s.linkStore.Get(ctx, shortCode)
    if err != nil {
        return "", err
    }

    // Verify signature
    if !s.verifySignature(link) {
        return "", ErrInvalidSignature
    }

    // Check expiration
    if time.Now().After(link.ExpiresAt) {
        return "", ErrLinkExpired
    }

    // Check download count
    if link.MaxDownloads > 0 && link.DownloadCount >= link.MaxDownloads {
        return "", ErrMaxDownloadsReached
    }

    // Verify password if required
    if link.Password != "" && !verifyPassword(password, link.Password) {
        return "", ErrInvalidPassword
    }

    // Check IP allowlist
    if len(link.AllowedIPs) > 0 && !isIPAllowed(clientIP, link.AllowedIPs) {
        return "", ErrIPNotAllowed
    }

    // Generate presigned URL
    presigner := s3.NewPresignClient(s.s3Client)
    presignedURL, err := presigner.PresignGetObject(ctx, &s3.GetObjectInput{
        Bucket: &link.Bucket,
        Key:    &link.Key,
    }, s3.WithPresignExpires(15*time.Minute))

    if err != nil {
        return "", err
    }

    // Increment download count
    s.linkStore.IncrementDownloads(ctx, shortCode)

    return presignedURL.URL, nil
}

func (s *SecureShortener) signLink(link *SecureLink) string {
    data := fmt.Sprintf("%s:%s:%s:%d", link.ShortCode, link.Bucket, link.Key, link.ExpiresAt.Unix())
    mac := hmac.New(sha256.New, s.signingKey)
    mac.Write([]byte(data))
    return hex.EncodeToString(mac.Sum(nil))
}
```

### Key Takeaways from Industry Leaders

| Company | Key Innovation | Scale |
|---------|---------------|-------|
| Bitly | Real-time analytics pipeline, deep linking | 10B+ clicks/month |
| Rebrandly | Custom branded domains with auto SSL | Millions of domains |
| Twitter t.co | Sharded architecture, bloom filters | Billions of clicks/day |
| AWS | Presigned URL integration, access controls | Enterprise security |

---

### Junior → FAANG: Reading Case Studies as Interview Preparation

The four companies in this chapter each solved the URL shortener problem differently because their constraints differed. Bitly optimized for analytics richness because that is their product differentiation. Twitter optimized for throughput and anti-spam because t.co handles billions of daily clicks from a social context where link abuse is common. AWS optimized for security integration because their customers are enterprises with compliance requirements.

Reading case studies this way, through the lens of constraints rather than solutions, is a skill that helps in system design interviews. When an interviewer presents a scenario, the first question is not "what technology do I use" but "what are the specific constraints I need to satisfy?" Answering that question out loud before proposing a design shows systems thinking.

Bloom filters (used by Twitter t.co for spam detection) are a commonly tested data structure in FAANG interviews. Know what they do (probabilistic set membership with no false negatives and controlled false positive rate), when to use them (pre-filter before an expensive lookup), and their limitations (cannot delete elements in a basic bloom filter, require careful sizing to control false positive rate).

### Senior @ FAANG: Case Studies as Benchmarks for Your Own ADRs

At senior level, case studies are not inspiration. They are benchmarks. When reviewing a design, a senior engineer asks: "which company's constraints most closely match ours, and what did they decide?" That comparison anchors architectural decisions in real-world evidence rather than theoretical preference.

The Twitter t.co sharded architecture is instructive for any high-throughput service. Sharding by short code prefix (or consistent hash of the code) distributes write and read load across shards, but requires a routing layer that knows which shard to contact for a given code. The operational complexity of shard rebalancing (when a shard is hot or when you need to add capacity) is significant. Twitter solved this by treating each shard as an independent service with its own operational runbook. That organizational structure, aligning team ownership with service boundaries at the shard level, is a staff-level architecture decision.

AWS presigned URL integration shows that a URL shortener can be extended into an access control primitive. A presigned URL is short-lived, cryptographically bound to a specific resource, and can enforce expiration and IP restriction. That design is the foundation of zero-trust data access patterns. At FAANG, similar patterns appear in content delivery (CDN signed URLs), mobile app deep links (signed with HMAC for integrity), and audit logging (where the log URL is signed to prevent tampering). Recognizing the common pattern across domains is a staff-level capability.

---
