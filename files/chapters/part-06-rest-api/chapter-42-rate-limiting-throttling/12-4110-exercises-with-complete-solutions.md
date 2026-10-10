## 42.10 Exercises with Complete Solutions

### Exercise 1: Build a Quota-Based Rate Limiter with Daily/Monthly Limits

**Requirements:**
- Track daily and monthly request quotas per user
- Support different quota tiers (free, pro, enterprise)
- Implement quota rollover (or not, based on tier)
- Provide quota usage API for users to check their limits
- Send warnings at 80% and 100% usage

**Solution:**

```go
// ... imports omitted for brevity (context, encoding/json, fmt, net/http, strconv, sync, time, github.com/redis/go-redis/v9)

// QuotaLimiter manages daily and monthly quotas
type QuotaLimiter struct {
    client    *redis.Client
    tiers     map[string]TierQuota
    notifier  QuotaNotifier
    mu        sync.RWMutex
}

// TierQuota defines quota limits for a tier
type TierQuota struct {
    Name           string
    DailyLimit     int
    MonthlyLimit   int
    AllowRollover  bool // Can unused daily quota roll over?
    WarningPercent float64 // When to warn (e.g., 0.8 = 80%)
}

// QuotaUsage represents current quota status
type QuotaUsage struct {
    UserID        string    `json:"user_id"`
    Tier          string    `json:"tier"`
    Daily         UsageInfo `json:"daily"`
    Monthly       UsageInfo `json:"monthly"`
    WarningLevel  string    `json:"warning_level,omitempty"` // "none", "warning", "exceeded"
}

type UsageInfo struct {
    Used      int       `json:"used"`
    Limit     int       `json:"limit"`
    Remaining int       `json:"remaining"`
    ResetAt   time.Time `json:"reset_at"`
    Percent   float64   `json:"percent_used"`
}

// QuotaNotifier sends notifications when quotas are approached
type QuotaNotifier interface {
    NotifyQuotaWarning(ctx context.Context, userID string, quotaType string, percent float64) error
    NotifyQuotaExceeded(ctx context.Context, userID string, quotaType string) error
}

func NewQuotaLimiter(client *redis.Client, notifier QuotaNotifier) *QuotaLimiter {
    return &QuotaLimiter{
        client:   client,
        notifier: notifier,
        tiers: map[string]TierQuota{
            "free": {
                Name:           "Free",
                DailyLimit:     1000,
                MonthlyLimit:   10000,
                AllowRollover:  false,
                WarningPercent: 0.8,
            },
            "pro": {
                Name:           "Pro",
                DailyLimit:     10000,
                MonthlyLimit:   100000,
                AllowRollover:  true,
                WarningPercent: 0.9,
            },
            "enterprise": {
                Name:           "Enterprise",
                DailyLimit:     100000,
                MonthlyLimit:   1000000,
                AllowRollover:  true,
                WarningPercent: 0.95,
            },
        },
    }
}

// SetTier updates or adds a tier configuration
func (q *QuotaLimiter) SetTier(name string, tier TierQuota) {
    q.mu.Lock()
    defer q.mu.Unlock()
    q.tiers[name] = tier
}

// Allow checks if a request is allowed and updates quota
func (q *QuotaLimiter) Allow(ctx context.Context, userID, tier string) (*QuotaResult, error) {
    return q.AllowN(ctx, userID, tier, 1)
}

// AllowN checks if n requests are allowed
func (q *QuotaLimiter) AllowN(ctx context.Context, userID, tier string, n int) (*QuotaResult, error) {
    q.mu.RLock()
    tierQuota, ok := q.tiers[tier]
    q.mu.RUnlock()

    if !ok {
        tierQuota = q.tiers["free"] // Default to free tier
    }

    now := time.Now().UTC()
    dailyKey := fmt.Sprintf("quota:daily:%s:%s", userID, now.Format("2006-01-02"))
    monthlyKey := fmt.Sprintf("quota:monthly:%s:%s", userID, now.Format("2006-01"))

    // Calculate reset times
    dailyReset := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC)
    monthlyReset := time.Date(now.Year(), now.Month()+1, 1, 0, 0, 0, 0, time.UTC)

    // Lua script for atomic quota check and update
    script := redis.NewScript(`
        local daily_key = KEYS[1]
        local monthly_key = KEYS[2]
        local count = tonumber(ARGV[1])
        local daily_limit = tonumber(ARGV[2])
        local monthly_limit = tonumber(ARGV[3])
        local daily_ttl = tonumber(ARGV[4])
        local monthly_ttl = tonumber(ARGV[5])

        -- Get current usage
        local daily_used = tonumber(redis.call('GET', daily_key) or '0')
        local monthly_used = tonumber(redis.call('GET', monthly_key) or '0')

        -- Check limits
        local daily_remaining = daily_limit - daily_used
        local monthly_remaining = monthly_limit - monthly_used

        if daily_remaining < count then
            return {0, daily_used, monthly_used, 1} -- Daily exceeded
        end

        if monthly_remaining < count then
            return {0, daily_used, monthly_used, 2} -- Monthly exceeded
        end

        -- Increment usage
        local new_daily = redis.call('INCRBY', daily_key, count)
        local ttl = redis.call('TTL', daily_key)
        if ttl == -1 then
            redis.call('EXPIRE', daily_key, daily_ttl)
        end

        local new_monthly = redis.call('INCRBY', monthly_key, count)
        ttl = redis.call('TTL', monthly_key)
        if ttl == -1 then
            redis.call('EXPIRE', monthly_key, monthly_ttl)
        end

        return {1, new_daily, new_monthly, 0} -- Success
    `)

    dailyTTL := int(time.Until(dailyReset).Seconds())
    monthlyTTL := int(time.Until(monthlyReset).Seconds())

    result, err := script.Run(ctx, q.client,
        []string{dailyKey, monthlyKey},
        n,
        tierQuota.DailyLimit,
        tierQuota.MonthlyLimit,
        dailyTTL,
        monthlyTTL,
    ).Slice()

    if err != nil {
        // Fail open on Redis errors
        return &QuotaResult{Allowed: true}, nil
    }

    allowed := result[0].(int64) == 1
    dailyUsed := int(result[1].(int64))
    monthlyUsed := int(result[2].(int64))
    exceedType := int(result[3].(int64))

    quotaResult := &QuotaResult{
        Allowed: allowed,
        Usage: QuotaUsage{
            UserID: userID,
            Tier:   tier,
            Daily: UsageInfo{
                Used:      dailyUsed,
                Limit:     tierQuota.DailyLimit,
                Remaining: tierQuota.DailyLimit - dailyUsed,
                ResetAt:   dailyReset,
                Percent:   float64(dailyUsed) / float64(tierQuota.DailyLimit),
            },
            Monthly: UsageInfo{
                Used:      monthlyUsed,
                Limit:     tierQuota.MonthlyLimit,
                Remaining: tierQuota.MonthlyLimit - monthlyUsed,
                ResetAt:   monthlyReset,
                Percent:   float64(monthlyUsed) / float64(tierQuota.MonthlyLimit),
            },
        },
    }

    if !allowed {
        if exceedType == 1 {
            quotaResult.ExceededType = "daily"
        } else {
            quotaResult.ExceededType = "monthly"
        }
    }

    // Check for warnings
    quotaResult.Usage.WarningLevel = "none"

    dailyPercent := quotaResult.Usage.Daily.Percent
    monthlyPercent := quotaResult.Usage.Monthly.Percent

    if dailyPercent >= 1.0 || monthlyPercent >= 1.0 {
        quotaResult.Usage.WarningLevel = "exceeded"
    } else if dailyPercent >= tierQuota.WarningPercent || monthlyPercent >= tierQuota.WarningPercent {
        quotaResult.Usage.WarningLevel = "warning"
    }

    // Send notifications asynchronously
    go q.sendNotifications(ctx, userID, quotaResult, tierQuota)

    return quotaResult, nil
}

func (q *QuotaLimiter) sendNotifications(ctx context.Context, userID string, result *QuotaResult, tier TierQuota) {
    if q.notifier == nil {
        return
    }

    // Check daily warning
    if result.Usage.Daily.Percent >= tier.WarningPercent && result.Usage.Daily.Percent < 1.0 {
        // Check if we already sent this warning today
        warnKey := fmt.Sprintf("quota:warned:daily:%s:%s", userID, time.Now().Format("2006-01-02"))
        set, _ := q.client.SetNX(ctx, warnKey, 1, 24*time.Hour).Result()
        if set {
            q.notifier.NotifyQuotaWarning(ctx, userID, "daily", result.Usage.Daily.Percent)
        }
    }

    // Check daily exceeded
    if result.Usage.Daily.Percent >= 1.0 {
        warnKey := fmt.Sprintf("quota:exceeded:daily:%s:%s", userID, time.Now().Format("2006-01-02"))
        set, _ := q.client.SetNX(ctx, warnKey, 1, 24*time.Hour).Result()
        if set {
            q.notifier.NotifyQuotaExceeded(ctx, userID, "daily")
        }
    }

    // Similar for monthly...
}

// GetUsage returns current quota usage without consuming
func (q *QuotaLimiter) GetUsage(ctx context.Context, userID, tier string) (*QuotaUsage, error) {
    q.mu.RLock()
    tierQuota, ok := q.tiers[tier]
    q.mu.RUnlock()

    if !ok {
        tierQuota = q.tiers["free"]
    }

    now := time.Now().UTC()
    dailyKey := fmt.Sprintf("quota:daily:%s:%s", userID, now.Format("2006-01-02"))
    monthlyKey := fmt.Sprintf("quota:monthly:%s:%s", userID, now.Format("2006-01"))

    results, err := q.client.MGet(ctx, dailyKey, monthlyKey).Result()
    if err != nil {
        return nil, err
    }

    dailyUsed := 0
    if results[0] != nil {
        dailyUsed, _ = strconv.Atoi(results[0].(string))
    }

    monthlyUsed := 0
    if results[1] != nil {
        monthlyUsed, _ = strconv.Atoi(results[1].(string))
    }

    dailyReset := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, time.UTC)
    monthlyReset := time.Date(now.Year(), now.Month()+1, 1, 0, 0, 0, 0, time.UTC)

    usage := &QuotaUsage{
        UserID: userID,
        Tier:   tier,
        Daily: UsageInfo{
            Used:      dailyUsed,
            Limit:     tierQuota.DailyLimit,
            Remaining: tierQuota.DailyLimit - dailyUsed,
            ResetAt:   dailyReset,
            Percent:   float64(dailyUsed) / float64(tierQuota.DailyLimit),
        },
        Monthly: UsageInfo{
            Used:      monthlyUsed,
            Limit:     tierQuota.MonthlyLimit,
            Remaining: tierQuota.MonthlyLimit - monthlyUsed,
            ResetAt:   monthlyReset,
            Percent:   float64(monthlyUsed) / float64(tierQuota.MonthlyLimit),
        },
    }

    usage.WarningLevel = "none"
    if usage.Daily.Percent >= 1.0 || usage.Monthly.Percent >= 1.0 {
        usage.WarningLevel = "exceeded"
    } else if usage.Daily.Percent >= tierQuota.WarningPercent || usage.Monthly.Percent >= tierQuota.WarningPercent {
        usage.WarningLevel = "warning"
    }

    return usage, nil
}

type QuotaResult struct {
    Allowed      bool
    Usage        QuotaUsage
    ExceededType string // "daily" or "monthly"
}

// Middleware for HTTP handlers
func (q *QuotaLimiter) Middleware() func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            ctx := r.Context()

            // Get user from context (set by auth middleware)
            user := GetUser(ctx)
            if user == nil {
                next.ServeHTTP(w, r)
                return
            }

            result, err := q.Allow(ctx, user.ID, user.Tier)
            if err != nil {
                http.Error(w, "Internal error", http.StatusInternalServerError)
                return
            }

            // Set quota headers
            w.Header().Set("X-Quota-Daily-Limit", strconv.Itoa(result.Usage.Daily.Limit))
            w.Header().Set("X-Quota-Daily-Remaining", strconv.Itoa(result.Usage.Daily.Remaining))
            w.Header().Set("X-Quota-Daily-Reset", result.Usage.Daily.ResetAt.Format(time.RFC3339))
            w.Header().Set("X-Quota-Monthly-Limit", strconv.Itoa(result.Usage.Monthly.Limit))
            w.Header().Set("X-Quota-Monthly-Remaining", strconv.Itoa(result.Usage.Monthly.Remaining))
            w.Header().Set("X-Quota-Monthly-Reset", result.Usage.Monthly.ResetAt.Format(time.RFC3339))

            if !result.Allowed {
                w.Header().Set("Content-Type", "application/json")
                w.WriteHeader(http.StatusTooManyRequests)

                response := map[string]any{
                    "error":         "quota_exceeded",
                    "exceeded_type": result.ExceededType,
                    "usage":         result.Usage,
                    "upgrade_url":   "https://example.com/pricing",
                }

                if result.ExceededType == "daily" {
                    w.Header().Set("Retry-After", strconv.Itoa(int(time.Until(result.Usage.Daily.ResetAt).Seconds())))
                    response["retry_after"] = result.Usage.Daily.ResetAt.Format(time.RFC3339)
                } else {
                    w.Header().Set("Retry-After", strconv.Itoa(int(time.Until(result.Usage.Monthly.ResetAt).Seconds())))
                    response["retry_after"] = result.Usage.Monthly.ResetAt.Format(time.RFC3339)
                }

                json.NewEncoder(w).Encode(response)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// API endpoint to get usage
func (q *QuotaLimiter) UsageHandler() http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        user := GetUser(r.Context())
        if user == nil {
            http.Error(w, "Unauthorized", http.StatusUnauthorized)
            return
        }

        usage, err := q.GetUsage(r.Context(), user.ID, user.Tier)
        if err != nil {
            http.Error(w, "Internal error", http.StatusInternalServerError)
            return
        }

        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(usage)
    }
}

// User helper (would be set by auth middleware)
type User struct {
    ID   string
    Tier string
}

func GetUser(ctx context.Context) *User {
    if user, ok := ctx.Value("user").(*User); ok {
        return user
    }
    return nil
}
```

### Exercise 2: Build a Rate Limiting Dashboard with Prometheus Metrics

**Requirements:**
- Export rate limiting metrics to Prometheus
- Track: requests allowed, rejected, latency, bucket usage
- Per-endpoint, per-tier, per-user metrics
- Alert rules for high rejection rates
- Grafana dashboard configuration

**Solution:**

```go
// ... imports omitted for brevity (context, net/http, strconv, time, prometheus/client_golang)

// RateLimitMetrics exports Prometheus metrics for rate limiting
type RateLimitMetrics struct {
    // Counters
    requestsTotal      *prometheus.CounterVec
    requestsAllowed    *prometheus.CounterVec
    requestsRejected   *prometheus.CounterVec

    // Histograms
    checkLatency       *prometheus.HistogramVec
    remainingBudget    *prometheus.HistogramVec

    // Gauges
    currentRate        *prometheus.GaugeVec
    activeLimiters     prometheus.Gauge
    redisHealth        prometheus.Gauge
}

func NewRateLimitMetrics(namespace string) *RateLimitMetrics {
    m := &RateLimitMetrics{
        requestsTotal: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Namespace: namespace,
                Name:      "ratelimit_requests_total",
                Help:      "Total number of requests checked against rate limiter",
            },
            []string{"endpoint", "tier", "method"},
        ),

        requestsAllowed: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Namespace: namespace,
                Name:      "ratelimit_requests_allowed_total",
                Help:      "Total number of requests allowed by rate limiter",
            },
            []string{"endpoint", "tier", "method"},
        ),

        requestsRejected: promauto.NewCounterVec(
            prometheus.CounterOpts{
                Namespace: namespace,
                Name:      "ratelimit_requests_rejected_total",
                Help:      "Total number of requests rejected by rate limiter",
            },
            []string{"endpoint", "tier", "method", "reason"},
        ),

        checkLatency: promauto.NewHistogramVec(
            prometheus.HistogramOpts{
                Namespace: namespace,
                Name:      "ratelimit_check_duration_seconds",
                Help:      "Time spent checking rate limits",
                Buckets:   []float64{.0001, .0005, .001, .005, .01, .025, .05, .1},
            },
            []string{"backend"}, // "memory", "redis"
        ),

        remainingBudget: promauto.NewHistogramVec(
            prometheus.HistogramOpts{
                Namespace: namespace,
                Name:      "ratelimit_remaining_budget",
                Help:      "Remaining budget after rate limit check",
                Buckets:   []float64{0, 1, 5, 10, 25, 50, 100, 250, 500, 1000},
            },
            []string{"tier"},
        ),

        currentRate: promauto.NewGaugeVec(
            prometheus.GaugeOpts{
                Namespace: namespace,
                Name:      "ratelimit_current_rate",
                Help:      "Current rate limit (for adaptive limiters)",
            },
            []string{"tier", "endpoint"},
        ),

        activeLimiters: promauto.NewGauge(
            prometheus.GaugeOpts{
                Namespace: namespace,
                Name:      "ratelimit_active_limiters",
                Help:      "Number of active rate limiter instances",
            },
        ),

        redisHealth: promauto.NewGauge(
            prometheus.GaugeOpts{
                Namespace: namespace,
                Name:      "ratelimit_redis_health",
                Help:      "Health of Redis connection (1 = healthy, 0 = unhealthy)",
            },
        ),
    }

    return m
}

// RecordRequest records a rate limit check
func (m *RateLimitMetrics) RecordRequest(endpoint, tier, method string, allowed bool, remaining int, latency time.Duration, reason string) {
    labels := prometheus.Labels{
        "endpoint": endpoint,
        "tier":     tier,
        "method":   method,
    }

    m.requestsTotal.With(labels).Inc()

    if allowed {
        m.requestsAllowed.With(labels).Inc()
    } else {
        rejectLabels := prometheus.Labels{
            "endpoint": endpoint,
            "tier":     tier,
            "method":   method,
            "reason":   reason, // "rate_exceeded", "quota_exceeded", "circuit_open"
        }
        m.requestsRejected.With(rejectLabels).Inc()
    }

    m.remainingBudget.WithLabelValues(tier).Observe(float64(remaining))
}

// RecordLatency records rate limit check latency
func (m *RateLimitMetrics) RecordLatency(backend string, duration time.Duration) {
    m.checkLatency.WithLabelValues(backend).Observe(duration.Seconds())
}

// SetCurrentRate sets the current rate for adaptive limiters
func (m *RateLimitMetrics) SetCurrentRate(tier, endpoint string, rate float64) {
    m.currentRate.WithLabelValues(tier, endpoint).Set(rate)
}

// SetRedisHealth sets Redis health status
func (m *RateLimitMetrics) SetRedisHealth(healthy bool) {
    if healthy {
        m.redisHealth.Set(1)
    } else {
        m.redisHealth.Set(0)
    }
}

// InstrumentedRateLimiter wraps a rate limiter with metrics
type InstrumentedRateLimiter struct {
    limiter RateLimiter
    metrics *RateLimitMetrics
    backend string
}

func NewInstrumentedRateLimiter(limiter RateLimiter, metrics *RateLimitMetrics, backend string) *InstrumentedRateLimiter {
    return &InstrumentedRateLimiter{
        limiter: limiter,
        metrics: metrics,
        backend: backend,
    }
}

func (i *InstrumentedRateLimiter) Allow(ctx context.Context, key, endpoint, tier, method string) (bool, int, time.Time) {
    start := time.Now()

    allowed, remaining, reset := i.limiter.Allow(ctx, key)

    latency := time.Since(start)
    i.metrics.RecordLatency(i.backend, latency)

    reason := ""
    if !allowed {
        reason = "rate_exceeded"
    }

    i.metrics.RecordRequest(endpoint, tier, method, allowed, remaining, latency, reason)

    return allowed, remaining, reset
}

// Middleware with metrics
func InstrumentedMiddleware(limiter *InstrumentedRateLimiter, metrics *RateLimitMetrics) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            user := GetUser(r.Context())
            tier := "anonymous"
            key := getClientIP(r)

            if user != nil {
                tier = user.Tier
                key = user.ID
            }

            // r.Pattern is the matched route template (Go 1.23+). Keying on
            // r.URL.Path gives /users/1 and /users/2 separate buckets, so an
            // attacker walking IDs is never limited.
            endpoint := r.Pattern
            if endpoint == "" {
                endpoint = r.Method + " " + r.URL.Path
            }
            method := r.Method

            allowed, remaining, reset := limiter.Allow(r.Context(), key, endpoint, tier, method)

            // IETF draft headers: t is seconds REMAINING, not a timestamp.
            resetIn := max(int(time.Until(reset).Seconds()), 0)
            w.Header().Set("RateLimit",
                fmt.Sprintf("%q;r=%d;t=%d", tier, max(remaining, 0), resetIn))

            if !allowed {
                w.Header().Set("Retry-After", strconv.Itoa(max(resetIn, 1)))
                http.Error(w, "Rate limit exceeded", http.StatusTooManyRequests)
                return
            }

            next.ServeHTTP(w, r)
        })
    }
}

// Handler exposes metrics endpoint
func MetricsHandler() http.Handler {
    return promhttp.Handler()
}

// Prometheus alert rules (prometheus/rules.yml)
const AlertRulesYAML = `
groups:
  - name: ratelimit_alerts
    rules:
      # High rejection rate alert
      - alert: HighRateLimitRejectionRate
        expr: |
          (
            sum(rate(ratelimit_requests_rejected_total[5m])) by (tier)
            /
            sum(rate(ratelimit_requests_total[5m])) by (tier)
          ) > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High rate limit rejection rate for tier {{ $labels.tier }}"
          description: "More than 10% of requests are being rate limited for {{ $labels.tier }} tier"

      # Redis unhealthy alert
      - alert: RateLimitRedisUnhealthy
        expr: ratelimit_redis_health == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Rate limit Redis is unhealthy"
          description: "Redis used for rate limiting is not responding"

      # High latency alert
      - alert: RateLimitHighLatency
        expr: |
          histogram_quantile(0.99,
            sum(rate(ratelimit_check_duration_seconds_bucket[5m])) by (le, backend)
          ) > 0.01
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High rate limit check latency"
          description: "P99 rate limit check latency is above 10ms"

      # Endpoint under attack (sudden spike in rejections)
      - alert: PossibleAttackDetected
        expr: |
          sum(rate(ratelimit_requests_rejected_total[1m])) by (endpoint)
          >
          sum(rate(ratelimit_requests_rejected_total[1h] offset 1d)) by (endpoint) * 10
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Possible attack on {{ $labels.endpoint }}"
          description: "Rate limit rejections are 10x higher than same time yesterday"
`

// Grafana dashboard JSON
const GrafanaDashboardJSON = `
{
  "title": "Rate Limiting Dashboard",
  "panels": [
    {
      "title": "Requests Rate",
      "type": "graph",
      "targets": [
        {
          "expr": "sum(rate(ratelimit_requests_total[5m])) by (tier)",
          "legendFormat": "{{tier}} - Total"
        },
        {
          "expr": "sum(rate(ratelimit_requests_allowed_total[5m])) by (tier)",
          "legendFormat": "{{tier}} - Allowed"
        },
        {
          "expr": "sum(rate(ratelimit_requests_rejected_total[5m])) by (tier)",
          "legendFormat": "{{tier}} - Rejected"
        }
      ]
    },
    {
      "title": "Rejection Rate by Tier",
      "type": "gauge",
      "targets": [
        {
          "expr": "sum(rate(ratelimit_requests_rejected_total[5m])) by (tier) / sum(rate(ratelimit_requests_total[5m])) by (tier) * 100",
          "legendFormat": "{{tier}}"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "thresholds": {
            "steps": [
              {"color": "green", "value": 0},
              {"color": "yellow", "value": 5},
              {"color": "red", "value": 10}
            ]
          },
          "unit": "percent",
          "max": 100
        }
      }
    },
    {
      "title": "Rate Limit Check Latency",
      "type": "heatmap",
      "targets": [
        {
          "expr": "sum(rate(ratelimit_check_duration_seconds_bucket[5m])) by (le)",
          "format": "heatmap"
        }
      ]
    },
    {
      "title": "Remaining Budget Distribution",
      "type": "histogram",
      "targets": [
        {
          "expr": "sum(rate(ratelimit_remaining_budget_bucket[5m])) by (le, tier)",
          "legendFormat": "{{tier}}"
        }
      ]
    },
    {
      "title": "Top Rejected Endpoints",
      "type": "table",
      "targets": [
        {
          "expr": "topk(10, sum(rate(ratelimit_requests_rejected_total[1h])) by (endpoint))",
          "format": "table"
        }
      ]
    },
    {
      "title": "Redis Health",
      "type": "stat",
      "targets": [
        {
          "expr": "ratelimit_redis_health"
        }
      ],
      "fieldConfig": {
        "defaults": {
          "mappings": [
            {"type": "value", "options": {"0": {"text": "Unhealthy", "color": "red"}}},
            {"type": "value", "options": {"1": {"text": "Healthy", "color": "green"}}}
          ]
        }
      }
    },
    {
      "title": "Current Adaptive Rate",
      "type": "graph",
      "targets": [
        {
          "expr": "ratelimit_current_rate",
          "legendFormat": "{{tier}} - {{endpoint}}"
        }
      ]
    },
    {
      "title": "Rejection Reasons",
      "type": "piechart",
      "targets": [
        {
          "expr": "sum(rate(ratelimit_requests_rejected_total[1h])) by (reason)",
          "legendFormat": "{{reason}}"
        }
      ]
    }
  ]
}
`

// Full setup example
func SetupRateLimitingWithMetrics() http.Handler {
    // Create metrics
    metrics := NewRateLimitMetrics("myapp")

    // Create rate limiter
    limiter := NewTokenBucketLimiter(100, 1000)
    instrumented := NewInstrumentedRateLimiter(limiter, metrics, "memory")

    // Create router
    mux := http.NewServeMux()

    // Apply middleware
    handler := InstrumentedMiddleware(instrumented, metrics)(
        http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            w.Write([]byte("OK"))
        }),
    )

    mux.Handle("/api/", handler)
    mux.Handle("/metrics", MetricsHandler())

    return mux
}

// RateLimiter interface for the instrumented wrapper
type RateLimiter interface {
    Allow(ctx context.Context, key string) (allowed bool, remaining int, reset time.Time)
}

// Helper functions
func getClientIP(r *http.Request) string {
    // Implementation from earlier
    return r.RemoteAddr
}
```

### Junior → FAANG: Getting Full Credit on Rate Limiting Exercises

These exercises are not just about making tests pass. FAANG coding screens use exercises like these to observe your engineering judgment before, during, and after you write code. Here is how to earn full credit at each stage.

**Before you write a line:**

State your design out loud. "I will use a token bucket backed by a `sync.Mutex`-protected struct. The refill happens lazily on each `Allow()` call rather than with a ticker goroutine, so there is no goroutine leak and no timer drift." That one sentence signals senior thinking to an interviewer even if your implementation has minor bugs.

**Common mistakes in exercise 1 (token bucket):**

- Using `int` for `tokens` instead of `float64`. A refill rate of 0.5 tokens per second means after 500ms you have 0.5 tokens. Integer truncation to zero breaks the math entirely.
- Calling `time.Sleep` in the test instead of writing a clock interface. A `ClockFunc` with `func() time.Time` injected into the struct lets you fast-forward time in tests without sleeping. Any FAANG senior will ding you for `time.Sleep` in a unit test.
- Not testing the concurrent case. Exercise 1 says "thread-safe." Write a test that fires 20 goroutines simultaneously and uses `sync.WaitGroup` plus an `atomic.Int32` to count 200s vs 429s.

**Common mistakes in exercise 2 (Redis sliding window):**

- Forgetting to set `EXPIRE` inside the Lua script. If `ZADD` succeeds but `EXPIRE` is never set, the key lives forever and users can never make another request after they exhaust the window. The bug appears only in production when a user's quota never resets.
- Using `time.Now().Unix()` (seconds) as the sorted set score instead of `time.Now().UnixNano()`. At 1000 req/s two requests in the same second get the same score. `ZADD` with an existing score updates rather than adds, so you undercount. Use nanoseconds.

**Common mistakes in exercise 6 (circuit breaker fallback):**

The fail-open behavior must be unconditional. If your circuit breaker fails open only when `err != nil` but Redis hangs (timeout), the `Wait()` blocks the request for the full timeout duration anyway. Always use `context.WithTimeout` wrapping the Redis call so a hung Redis becomes a timeout error within 50ms, not an infinite block.

**First-job habit from exercise 4 (standard headers):**

Get the reset semantics the right way round, because the two live conventions mean opposite things and the names look similar enough to blur together.

The IETF draft expresses the reset as **seconds remaining**, carried as the `t` parameter of the consolidated `RateLimit` header (`RateLimit: "default";r=0;t=60` means "60 seconds until your quota returns"). GitHub's legacy `X-RateLimit-Reset` is the other choice: an **absolute Unix timestamp**. Neither is universally right, but putting the wrong one under a given name is catastrophic in a specific way. Emit `1704067200` where a client expects a delta and it sleeps for fifty-four thousand years. Emit `60` where a client expects a timestamp and it computes a negative delay and retries immediately, which is precisely the hammering the header exists to prevent.

The draft chose a duration deliberately: a duration is immune to clock skew between your server and a client whose clock is minutes off, whereas a timestamp is only meaningful if both parties agree on what time it is. The counter-argument is that a duration goes stale if the response is cached, which is a real cost and the reason the legacy convention picked a timestamp. Know both sides, pick one meaning per header name, and write it in the docs.

### Senior @ FAANG: What These Exercises Reveal About System Design Maturity

A senior candidate is evaluated not just on whether the code works but on the design decisions embedded in the code. Here is what each exercise is really testing.

**Exercise 1 (token bucket) tests lazy vs eager evaluation awareness.** Lazy refill (compute elapsed time on each `Allow()` call) is strictly better than a ticker goroutine for per-key limiters at scale. If you have 10 million active users and each has a `time.Ticker`, you have 10 million goroutines. Lazy evaluation means zero goroutines and the same arithmetic. A senior candidate makes this choice explicitly and can defend it.

**Exercise 2 (Redis sliding window) tests Lua atomicity understanding.** The question is not "does it work?" but "what breaks without Lua?" The answer: without Lua, read-then-write is a race condition between replicas. Two replicas both read 99, both decide to allow, both increment to 100. The limit is now exceeded by one. At 1000 req/s that race closes constantly. A senior candidate describes this race and explains that Lua runs atomically on the Redis instance, with no other client interleaving between commands. Two refinements separate the merely-correct answer from the well-informed one. First, atomicity is not transactionality: if a command midway through the script errors, the writes already performed are not rolled back. Second, modern Redis uses **effects replication**, propagating the script's resulting write commands to replicas rather than shipping the script itself for re-execution, which is what makes non-deterministic scripts safe to replicate. Neither of these makes the guarantee span shards: in Redis Cluster, atomicity holds within one hash slot, which is why a single-key limiter is fine and a multi-key script needs hash tags to force colocation.

**Exercise 3 (tiered limits) tests interface design.** A junior puts tier names in a switch statement. A senior defines a `TierConfig` struct, stores it in a map, and loads it from a config source (environment variable, config service, feature flag) so limits can be changed without a deploy. The middleware reads the config on every request through an atomic pointer or a `sync.Map` so a config reload does not require a restart.

**Exercise 5 (adaptive limiting) tests abstraction for testability.** The `LoadReader` interface is the whole point. A `RealLoadReader` calls `gopsutil`. A `MockLoadReader` returns a controlled float. If your implementation couples directly to `gopsutil`, you cannot test the adaptive logic without real CPU load. At FAANG, untestable code is rejectable code. The interface is the test, not the implementation.

**Exercise 7 (abuse detection with HyperLogLog) tests probabilistic data structure judgment.** HyperLogLog is the right choice here because you do not need an exact count of distinct keys per IP. You need to know if the count exceeds 10. HLL uses constant memory (12 KB per key in Redis) versus a Redis Set which grows unboundedly. The trade-off: HLL has a 0.81% error rate, so at a threshold of 10 keys you might block at 9.9 or admit at 10.1. That is acceptable for abuse detection. A senior candidate names this trade-off explicitly.

**The missing exercise that FAANG actually cares about:**

None of the exercises covers quota reconciliation after a cost adjustment. If you set a user's monthly limit to 10,000 in January and they hit it, then in February you raise their limit to 15,000, their Redis key still holds 10,000 used. The new limit is now enforced against stale usage. The correct fix: store limit version alongside usage, and reset usage when the limit version changes. This is the kind of state management edge case that separates senior candidates from junior candidates. Work it into your design whenever quota exercises appear.

**Platform-level concern: key expiry alignment:**

The daily key in exercise 1 uses `now.Format("2006-01-02")` as part of the Redis key. This means all users' daily keys expire at the same clock second (midnight UTC). If you have 10 million users and Redis flushes 10 million expired keys at the same second, you get a Redis CPU spike and a latency burst on all requests that touch those keys. The fix is a random jitter on the `EXPIRE` value: add 0 to 300 seconds of random offset so expiry is spread across 5 minutes around midnight. This detail separates candidates who have run production Redis at scale from those who have not.

---
