## Exercises with Complete Solutions

### Exercise 1: Build a URL Shortener API

Create a URL shortener service with:
- POST /shorten - Create short URL
- GET /{code} - Redirect to original URL
- GET /stats/{code} - Get click statistics

**Complete Solution:**

```go
// internal/shortener/shortener.go
package shortener

import (
    "context"
    "crypto/rand"
    "encoding/base64"
    "errors"
    "net/url"
    "sync"
    "time"
)

var (
    ErrURLNotFound = errors.New("URL not found")
    ErrInvalidURL  = errors.New("invalid URL")
)

type URLEntry struct {
    Code        string    `json:"code"`
    OriginalURL string    `json:"original_url"`
    ShortURL    string    `json:"short_url"`
    CreatedAt   time.Time `json:"created_at"`
    Clicks      int64     `json:"clicks"`
    LastClicked *time.Time `json:"last_clicked,omitempty"`
}

type Service struct {
    mu       sync.RWMutex
    urls     map[string]*URLEntry
    baseURL  string
    codeLen  int
}

func NewService(baseURL string) *Service {
    return &Service{
        urls:    make(map[string]*URLEntry),
        baseURL: baseURL,
        codeLen: 6,
    }
}

func (s *Service) Shorten(ctx context.Context, originalURL string) (*URLEntry, error) {
    if !isValidURL(originalURL) {
        return nil, ErrInvalidURL
    }

    code := s.generateCode()

    entry := &URLEntry{
        Code:        code,
        OriginalURL: originalURL,
        ShortURL:    s.baseURL + "/" + code,
        CreatedAt:   time.Now(),
    }

    s.mu.Lock()
    s.urls[code] = entry
    s.mu.Unlock()

    return entry, nil
}

func (s *Service) Resolve(ctx context.Context, code string) (string, error) {
    s.mu.Lock()
    defer s.mu.Unlock()

    entry, ok := s.urls[code]
    if !ok {
        return "", ErrURLNotFound
    }

    // Update statistics
    entry.Clicks++
    now := time.Now()
    entry.LastClicked = &now

    return entry.OriginalURL, nil
}

func (s *Service) GetStats(ctx context.Context, code string) (*URLEntry, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    entry, ok := s.urls[code]
    if !ok {
        return nil, ErrURLNotFound
    }

    return entry, nil
}

func (s *Service) generateCode() string {
    b := make([]byte, s.codeLen)
    rand.Read(b)
    code := base64.URLEncoding.EncodeToString(b)[:s.codeLen]

    // Ensure uniqueness
    s.mu.RLock()
    _, exists := s.urls[code]
    s.mu.RUnlock()

    if exists {
        return s.generateCode()
    }
    return code
}

func isValidURL(u string) bool {
    parsed, err := url.Parse(u)
    return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}
```

The handler layer translates HTTP requests into service calls and maps errors to status codes. Each route handler follows the same pattern: decode the request, call the service, and encode the response.

```go
// internal/shortener/handler.go
package shortener

import (
    "encoding/json"
    "errors"
    "net/http"

    "github.com/go-chi/chi/v5"
)

type Handler struct {
    service *Service
}

func NewHandler(service *Service) *Handler {
    return &Handler{service: service}
}

func (h *Handler) RegisterRoutes(r chi.Router) {
    r.Post("/shorten", h.Shorten)
    r.Get("/{code}", h.Redirect)
    r.Get("/stats/{code}", h.Stats)
}

type ShortenRequest struct {
    URL string `json:"url"`
}

func (h *Handler) Shorten(w http.ResponseWriter, r *http.Request) {
    var req ShortenRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    entry, err := h.service.Shorten(r.Context(), req.URL)
    if err != nil {
        if errors.Is(err, ErrInvalidURL) {
            http.Error(w, "Invalid URL", http.StatusBadRequest)
            return
        }
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(entry)
}

func (h *Handler) Redirect(w http.ResponseWriter, r *http.Request) {
    code := chi.URLParam(r, "code")

    originalURL, err := h.service.Resolve(r.Context(), code)
    if err != nil {
        if errors.Is(err, ErrURLNotFound) {
            http.Error(w, "URL not found", http.StatusNotFound)
            return
        }
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    http.Redirect(w, r, originalURL, http.StatusMovedPermanently)
}

func (h *Handler) Stats(w http.ResponseWriter, r *http.Request) {
    code := chi.URLParam(r, "code")

    entry, err := h.service.GetStats(r.Context(), code)
    if err != nil {
        if errors.Is(err, ErrURLNotFound) {
            http.Error(w, "URL not found", http.StatusNotFound)
            return
        }
        http.Error(w, "Internal error", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(entry)
}
```

The main package wires the service and handler together, attaches middleware, and starts the server.

```go
// cmd/shortener/main.go
package main

import (
    "log"
    "net/http"

    "github.com/go-chi/chi/v5"
    "github.com/go-chi/chi/v5/middleware"

    "myapp/internal/shortener"
)

func main() {
    service := shortener.NewService("http://localhost:8080")
    handler := shortener.NewHandler(service)

    r := chi.NewRouter()
    r.Use(middleware.Logger)
    r.Use(middleware.Recoverer)

    handler.RegisterRoutes(r)

    log.Println("Server starting on :8080")
    log.Fatal(http.ListenAndServe(":8080", r))
}
```

### Exercise 2: Build a Webhook Delivery System

Create a webhook system that:
- Registers webhook endpoints
- Delivers events with retries
- Tracks delivery status

**Complete Solution:**

```go
// internal/webhook/types.go
package webhook

import (
    "time"

    "github.com/google/uuid"
)

type Webhook struct {
    ID        uuid.UUID         `json:"id"`
    URL       string            `json:"url"`
    Secret    string            `json:"-"`
    Events    []string          `json:"events"`
    Active    bool              `json:"active"`
    CreatedAt time.Time         `json:"created_at"`
}

type WebhookEvent struct {
    ID          uuid.UUID   `json:"id"`
    WebhookID   uuid.UUID   `json:"webhook_id"`
    EventType   string      `json:"event_type"`
    Payload     any `json:"payload"`
    CreatedAt   time.Time   `json:"created_at"`
}

type Delivery struct {
    ID            uuid.UUID      `json:"id"`
    WebhookID     uuid.UUID      `json:"webhook_id"`
    EventID       uuid.UUID      `json:"event_id"`
    Status        DeliveryStatus `json:"status"`
    Attempts      int            `json:"attempts"`
    LastAttemptAt *time.Time     `json:"last_attempt_at,omitempty"`
    NextRetryAt   *time.Time     `json:"next_retry_at,omitempty"`
    ResponseCode  *int           `json:"response_code,omitempty"`
    ResponseBody  *string        `json:"response_body,omitempty"`
    Error         *string        `json:"error,omitempty"`
    CreatedAt     time.Time      `json:"created_at"`
}

type DeliveryStatus string

const (
    StatusPending   DeliveryStatus = "pending"
    StatusDelivered DeliveryStatus = "delivered"
    StatusFailed    DeliveryStatus = "failed"
    StatusRetrying  DeliveryStatus = "retrying"
)
```

The service layer handles webhook registration, event dispatching, and delivery with exponential backoff retries. Each delivery attempt is tracked with status, response code, and error details. The HMAC-SHA256 signature lets receivers verify that payloads were not tampered with in transit.

```go
// internal/webhook/service.go
package webhook

import (
    "bytes"
    "context"
    "crypto/hmac"
    "crypto/rand"
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "sync"
    "time"

    "github.com/google/uuid"
)

type Service struct {
    mu         sync.RWMutex
    webhooks   map[uuid.UUID]*Webhook
    deliveries map[uuid.UUID]*Delivery

    client     *http.Client
    maxRetries int
    retryDelays []time.Duration
}

func NewService() *Service {
    return &Service{
        webhooks:   make(map[uuid.UUID]*Webhook),
        deliveries: make(map[uuid.UUID]*Delivery),
        client: &http.Client{
            Timeout: 30 * time.Second,
        },
        maxRetries: 5,
        retryDelays: []time.Duration{
            1 * time.Minute,
            5 * time.Minute,
            30 * time.Minute,
            2 * time.Hour,
            24 * time.Hour,
        },
    }
}

func (s *Service) Register(ctx context.Context, url string, events []string) (*Webhook, error) {
    webhook := &Webhook{
        ID:        uuid.New(),
        URL:       url,
        Secret:    generateSecret(),
        Events:    events,
        Active:    true,
        CreatedAt: time.Now(),
    }

    s.mu.Lock()
    s.webhooks[webhook.ID] = webhook
    s.mu.Unlock()

    return webhook, nil
}

func (s *Service) Dispatch(ctx context.Context, eventType string, payload any) error {
    s.mu.RLock()
    defer s.mu.RUnlock()

    for _, webhook := range s.webhooks {
        if !webhook.Active || !containsEvent(webhook.Events, eventType) {
            continue
        }

        event := &WebhookEvent{
            ID:        uuid.New(),
            WebhookID: webhook.ID,
            EventType: eventType,
            Payload:   payload,
            CreatedAt: time.Now(),
        }

        // Queue delivery
        go s.deliver(webhook, event)
    }

    return nil
}

func (s *Service) deliver(webhook *Webhook, event *WebhookEvent) {
    delivery := &Delivery{
        ID:        uuid.New(),
        WebhookID: webhook.ID,
        EventID:   event.ID,
        Status:    StatusPending,
        CreatedAt: time.Now(),
    }

    s.mu.Lock()
    s.deliveries[delivery.ID] = delivery
    s.mu.Unlock()

    for attempt := 0; attempt <= s.maxRetries; attempt++ {
        delivery.Attempts = attempt + 1
        now := time.Now()
        delivery.LastAttemptAt = &now

        if attempt > 0 {
            delivery.Status = StatusRetrying
            time.Sleep(s.retryDelays[attempt-1])
        }

        err := s.attemptDelivery(webhook, event, delivery)
        if err == nil {
            delivery.Status = StatusDelivered
            return
        }

        errStr := err.Error()
        delivery.Error = &errStr
    }

    delivery.Status = StatusFailed
}

func (s *Service) attemptDelivery(webhook *Webhook, event *WebhookEvent, delivery *Delivery) error {
    body, err := json.Marshal(map[string]any{
        "id":         event.ID,
        "event_type": event.EventType,
        "payload":    event.Payload,
        "created_at": event.CreatedAt,
    })
    if err != nil {
        return err
    }

    req, err := http.NewRequest("POST", webhook.URL, bytes.NewReader(body))
    if err != nil {
        return err
    }

    // Set headers
    timestamp := time.Now().Unix()
    signature := computeSignature(webhook.Secret, body, timestamp)

    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("X-Webhook-ID", webhook.ID.String())
    req.Header.Set("X-Webhook-Timestamp", fmt.Sprintf("%d", timestamp))
    req.Header.Set("X-Webhook-Signature", signature)

    resp, err := s.client.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()

    delivery.ResponseCode = &resp.StatusCode

    respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
    respBodyStr := string(respBody)
    delivery.ResponseBody = &respBodyStr

    if resp.StatusCode >= 200 && resp.StatusCode < 300 {
        return nil
    }

    return fmt.Errorf("webhook returned status %d", resp.StatusCode)
}

func (s *Service) GetDeliveries(ctx context.Context, webhookID uuid.UUID) ([]*Delivery, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    var deliveries []*Delivery
    for _, d := range s.deliveries {
        if d.WebhookID == webhookID {
            deliveries = append(deliveries, d)
        }
    }
    return deliveries, nil
}

func generateSecret() string {
    b := make([]byte, 32)
    rand.Read(b)
    return hex.EncodeToString(b)
}

func computeSignature(secret string, body []byte, timestamp int64) string {
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write([]byte(fmt.Sprintf("%d.", timestamp)))
    mac.Write(body)
    return hex.EncodeToString(mac.Sum(nil))
}

func containsEvent(events []string, event string) bool {
    for _, e := range events {
        if e == event || e == "*" {
            return true
        }
    }
    return false
}
```

The HTTP handler exposes endpoints for registering webhooks, listing deliveries, and dispatching events. The webhook secret is returned only on creation so the receiver can store it for signature verification.

```go
// internal/webhook/handler.go
package webhook

import (
    "encoding/json"
    "net/http"

    "github.com/go-chi/chi/v5"
    "github.com/google/uuid"
)

type Handler struct {
    service *Service
}

func NewHandler(service *Service) *Handler {
    return &Handler{service: service}
}

func (h *Handler) RegisterRoutes(r chi.Router) {
    r.Post("/webhooks", h.Create)
    r.Get("/webhooks/{id}/deliveries", h.ListDeliveries)
    r.Post("/events", h.DispatchEvent)
}

type CreateWebhookRequest struct {
    URL    string   `json:"url"`
    Events []string `json:"events"`
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
    var req CreateWebhookRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    webhook, err := h.service.Register(r.Context(), req.URL, req.Events)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    // Include secret in response (only shown once)
    response := map[string]any{
        "id":         webhook.ID,
        "url":        webhook.URL,
        "secret":     webhook.Secret, // Only returned on creation!
        "events":     webhook.Events,
        "created_at": webhook.CreatedAt,
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(response)
}

func (h *Handler) ListDeliveries(w http.ResponseWriter, r *http.Request) {
    idStr := chi.URLParam(r, "id")
    id, err := uuid.Parse(idStr)
    if err != nil {
        http.Error(w, "Invalid webhook ID", http.StatusBadRequest)
        return
    }

    deliveries, err := h.service.GetDeliveries(r.Context(), id)
    if err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]any{"deliveries": deliveries})
}

type DispatchEventRequest struct {
    EventType string      `json:"event_type"`
    Payload   any `json:"payload"`
}

func (h *Handler) DispatchEvent(w http.ResponseWriter, r *http.Request) {
    var req DispatchEventRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    if err := h.service.Dispatch(r.Context(), req.EventType, req.Payload); err != nil {
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }

    w.WriteHeader(http.StatusAccepted)
    json.NewEncoder(w).Encode(map[string]string{"status": "accepted"})
}
```

### Junior to FAANG: Extensions That Turn Exercises Into Portfolio Pieces

For the URL shortener, the 150-line version above is the starting point. The portfolio version adds Postgres persistence (in-memory is fine for a demo and a lie for production), a Redis cache for hot codes, a `pgx` connection pool, OTEL tracing, Prometheus metrics, structured slog logging, a graceful-shutdown flow with `context.NotifyContext`, and a Dockerfile. Ship that on GitHub with a README showing latency numbers under `hey -z 30s -c 50`. That is an offer-generating portfolio.

For the webhook system, the gaps that reveal inexperience. No persistence (a pod restart loses every pending delivery). No outbox pattern (events can be dispatched without the originating transaction committing). Retries run in goroutines that die with the process. No idempotency on the receiver side (receivers may process the same event twice). The `sync.Map` approach does not scale. Each of these is a learning opportunity. Fix them one at a time.

Interview framing. Expect "walk me through your URL shortener project." The good answer covers the database schema (short_code primary key, original_url, created_at, click_count, indexed on short_code), the cache strategy (cache-aside with 1-hour TTL), the short-code generation (base62 of sequential ID vs random, collision handling), and the click-counting scheme (synchronous DB update is a write hotspot, prefer Redis INCR with periodic flush to DB).

### Senior at FAANG: What Production Versions of These Exercises Actually Look Like

URL shortener at FAANG scale (bit.ly, TinyURL, firebase dynamic links). Sharded by short code prefix. Write path writes to the shard, read path reads from cache first then shard. Click counting via Kafka topic consumed by a batch aggregator, not per-click DB writes. Code generation via snowflake ID (no coordination needed, monotonically increasing across generators) encoded as base62. Abuse detection on write path (malware domain blocklist, rate limits per account). Custom domain support via DNS CNAME and TLS cert provisioning. Analytics with geographic and referrer breakdown, terabytes of event data in BigQuery or Snowflake. A three-engineer team can own this for years.

Webhook delivery at FAANG scale (Stripe, GitHub, Shopify). Persistent queue (Kafka, SQS, or a relational outbox). Worker pool with horizontal scaling, per-endpoint concurrency limits to prevent one slow receiver from blocking others. Exponential backoff with jitter, retry caps at 24 hours typical. Circuit breaker per receiver endpoint (disable after N consecutive failures, notify owner, auto-reenable on manual action). HMAC signing with key rotation support. Replay UI for customers to resend failed events. Audit log for every delivery attempt, 90-day retention. Dashboards per tenant showing delivery rate, latency, failure reasons. This is a 10-engineer product team for a company like Stripe, not a side-project.

Outbox pattern. The non-negotiable production requirement. When you create an order AND want to deliver a webhook, you must commit both atomically. Two options. (1) Write the event to a DB table in the same transaction as the order, a separate dispatcher polls the table and delivers. (2) CDC (change data capture) from the orders table via Debezium into Kafka. Never dispatch from a goroutine in the same process that performed the transaction, a pod crash drops the event. This is the most common bug in hand-rolled webhook systems.

Idempotency on both sides. The webhook sender must deduplicate (do not dispatch the same event twice after a crash). The receiver must deduplicate (handle receiving the same event twice). The sender sends `X-Event-ID` as UUID, the receiver stores processed IDs for 24 hours. Document this contract in every public webhook spec.

Security envelope. HMAC signature over `timestamp.body` prevents tampering and replay. Timestamp must be within 5 minutes to prevent replay. Signature includes timestamp so removing it breaks the sig. Rotate signing keys via `v1=` and `v2=` headers during rotation. All of this belongs in platform library, not per-service.

Observability for delivery systems. SLIs, delivery success rate, delivery latency p50/p99, queue depth, retry rate. SLOs, 99.9 percent deliverable within 30 seconds, 100 percent within 24 hours for 4xx-returning endpoints. Alert on queue-depth growth faster than drain rate (incident signal). Dashboard per customer showing their webhook health so support can diagnose without opening your internals.

Staff-level ADR for webhook platform. Build vs buy (Svix, Hookdeck, AWS EventBridge). Buy for early-stage, build when volume crosses 100k events/day or differentiation becomes product feature. Typical break-even is 18 to 24 months of engineering cost vs vendor cost.

Multi-year roadmap for these exercise-products. Quarter 1, MVP with in-memory. Quarter 2, persistence and basic retry. Quarter 3, observability and customer UI. Quarter 4, security hardening, rotation, audit log. Year 2, custom domains, abuse detection, analytics. Year 3, cross-region replication, compliance features (SOC 2, HIPAA). Year 4, platformization for internal teams, API for self-service provisioning.

---
