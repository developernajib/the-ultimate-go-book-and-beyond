## Deep Dive: Billing and Token Metering

LLM platforms charge per token rather than per request, because token count directly correlates with GPU compute consumed. The billing service below calculates costs by separating prompt tokens (input) from completion tokens (output), applying different rates for each. It also applies a discount for cached prompt tokens, since those skip the expensive prefill computation. All monetary values are integer micro-dollars (1e-6 USD), never floats, so per-request costs sum exactly across millions of records. Usage counters are stored in both PostgreSQL (for durable billing records) and Redis (for real-time rate limiting), ensuring accurate metering under high throughput.

```go
package billing

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// BillingService tracks token usage and computes costs
type BillingService struct {
	db  *pgxpool.Pool
	rdb *redis.Client
}

type UsageRecord struct {
	RequestID        string    `json:"request_id"`
	UserID           string    `json:"user_id"`
	Model            string    `json:"model"`
	PromptTokens     int       `json:"prompt_tokens"`
	CompletionTokens int       `json:"completion_tokens"`
	CachedTokens     int       `json:"cached_tokens"`
	TotalTokens      int       `json:"total_tokens"`
	PromptCost       int64     `json:"prompt_cost"`     // micro-dollars
	CompletionCost   int64     `json:"completion_cost"` // micro-dollars
	TotalCost        int64     `json:"total_cost"`      // micro-dollars
	TTFTMs           int       `json:"ttft_ms"`
	DurationMs       int       `json:"duration_ms"`
	CreatedAt        time.Time `json:"created_at"`
}

// ModelPricing defines per-token pricing in micro-dollars per 1K tokens.
// Integer money avoids float rounding drift across millions of records.
type ModelPricing struct {
	ModelID                string
	PromptPricePer1K       int64 // micro-$/1K prompt tokens
	CompletionPricePer1K   int64 // micro-$/1K completion tokens
	CachedPromptPricePer1K int64 // micro-$/1K cached tokens (50% discount)
}

var modelPricing = map[string]ModelPricing{
	// $0.20 / $0.40 per 1M tokens
	"llama-3.1-8b": {PromptPricePer1K: 200, CompletionPricePer1K: 400, CachedPromptPricePer1K: 100},
	// $2.50 / $5.00 per 1M tokens
	"llama-3.1-70b": {PromptPricePer1K: 2_500, CompletionPricePer1K: 5_000, CachedPromptPricePer1K: 1_250},
	// $5.00 / $15.00 per 1M tokens
	"llama-3.1-405b": {PromptPricePer1K: 5_000, CompletionPricePer1K: 15_000, CachedPromptPricePer1K: 2_500},
}

// tokenCost computes the micro-dollar cost with round-half-up on the
// final division so fractional micro-dollars never accumulate as bias
func tokenCost(tokens int, pricePer1K int64) int64 {
	return (int64(tokens)*pricePer1K + 500) / 1000
}

// RecordUsage records a completed inference request for billing
func (s *BillingService) RecordUsage(ctx context.Context, record UsageRecord) error {
	pricing, ok := modelPricing[record.Model]
	if !ok {
		return fmt.Errorf("unknown model: %s", record.Model)
	}

	// Compute costs in micro-dollars
	uncachedPromptTokens := record.PromptTokens - record.CachedTokens
	record.PromptCost = tokenCost(uncachedPromptTokens, pricing.PromptPricePer1K) +
		tokenCost(record.CachedTokens, pricing.CachedPromptPricePer1K)
	record.CompletionCost = tokenCost(record.CompletionTokens, pricing.CompletionPricePer1K)
	record.TotalCost = record.PromptCost + record.CompletionCost

	// Persist
	_, err := s.db.Exec(ctx, `
		INSERT INTO usage_records (request_id, user_id, model, prompt_tokens, completion_tokens,
			cached_tokens, total_tokens, prompt_cost, completion_cost, total_cost, ttft_ms, duration_ms, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())`,
		record.RequestID, record.UserID, record.Model,
		record.PromptTokens, record.CompletionTokens, record.CachedTokens, record.TotalTokens,
		record.PromptCost, record.CompletionCost, record.TotalCost,
		record.TTFTMs, record.DurationMs)
	if err != nil {
		return err
	}

	// Update daily usage counter in Redis (for rate limiting)
	dayKey := fmt.Sprintf("usage:daily:%s:%s", record.UserID, time.Now().Format("20060102"))
	s.rdb.IncrBy(ctx, dayKey, int64(record.TotalTokens))
	s.rdb.Expire(ctx, dayKey, 48*time.Hour)

	return nil
}

// GetUsageSummary returns usage stats for a user over a time period
func (s *BillingService) GetUsageSummary(ctx context.Context, userID string, start, end time.Time) (*UsageSummary, error) {
	var summary UsageSummary
	err := s.db.QueryRow(ctx, `
		SELECT
			COUNT(*) as requests,
			SUM(prompt_tokens) as prompt_tokens,
			SUM(completion_tokens) as completion_tokens,
			SUM(cached_tokens) as cached_tokens,
			SUM(total_tokens) as total_tokens,
			SUM(total_cost) as total_cost,
			AVG(ttft_ms) as avg_ttft,
			PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ttft_ms) as p99_ttft
		FROM usage_records
		WHERE user_id = $1 AND created_at BETWEEN $2 AND $3`,
		userID, start, end).Scan(
		&summary.TotalRequests, &summary.PromptTokens, &summary.CompletionTokens,
		&summary.CachedTokens, &summary.TotalTokens, &summary.TotalCost,
		&summary.AvgTTFTMs, &summary.P99TTFTMs)
	return &summary, err
}

type UsageSummary struct {
	TotalRequests    int     `json:"total_requests"`
	PromptTokens     int64   `json:"prompt_tokens"`
	CompletionTokens int64   `json:"completion_tokens"`
	CachedTokens     int64   `json:"cached_tokens"`
	TotalTokens      int64   `json:"total_tokens"`
	TotalCost        int64   `json:"total_cost"` // micro-dollars
	AvgTTFTMs        float64 `json:"avg_ttft_ms"`
	P99TTFTMs        float64 `json:"p99_ttft_ms"`
}
```

---
