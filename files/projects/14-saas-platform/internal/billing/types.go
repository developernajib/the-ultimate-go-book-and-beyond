// internal/billing/types.go
package billing

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// JSONB is a map that serializes to/from JSON for Postgres jsonb columns
type JSONB map[string]any

func (j JSONB) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any(j))
}

// SubscriptionRepository defines persistence for subscriptions
type SubscriptionRepository interface {
	Create(ctx context.Context, s *Subscription) error
	GetByID(ctx context.Context, id uuid.UUID) (*Subscription, error)
	GetByTenantID(ctx context.Context, tenantID uuid.UUID) (*Subscription, error)
	GetByStripeID(ctx context.Context, stripeID string) (*Subscription, error)
	Update(ctx context.Context, s *Subscription) error
	Delete(ctx context.Context, id uuid.UUID) error
}

// InvoiceRepository defines persistence for invoices
type InvoiceRepository interface {
	Create(ctx context.Context, inv *Invoice) error
	GetByID(ctx context.Context, id uuid.UUID) (*Invoice, error)
	GetByStripeID(ctx context.Context, stripeID string) (*Invoice, error)
	ListByTenant(ctx context.Context, tenantID uuid.UUID) ([]*Invoice, error)
	Update(ctx context.Context, inv *Invoice) error
}

// UsageAggregation holds aggregated usage data
type UsageAggregation struct {
	TenantID   uuid.UUID
	MetricName string
	Total      int64
	PeriodStart time.Time
	PeriodEnd   time.Time
}

// UsageRepository defines persistence for usage records
type UsageRepository interface {
	Create(ctx context.Context, r *UsageRecord) error
	GetByTenantAndMetric(ctx context.Context, tenantID uuid.UUID, metricName string) ([]*UsageRecord, error)
	GetByTenantAndPeriod(ctx context.Context, tenantID uuid.UUID, start, end time.Time) ([]*UsageRecord, error)
	SumByTenantAndMetric(ctx context.Context, tenantID uuid.UUID, metricName string) (int64, error)
	GetTotalUsage(ctx context.Context, tenantID uuid.UUID, metricName string, start, end time.Time) (int64, error)
	GetUsageBreakdown(ctx context.Context, tenantID uuid.UUID, start, end time.Time) (map[string]int64, error)
}

// TenantInfo is a minimal view of a tenant for billing (avoids import cycle)
type TenantInfo struct {
	ID           uuid.UUID
	Name         string
	PlanID       uuid.UUID
	PlanName     string
	BillingEmail string
}

// Plan is a minimal subscription plan for billing
type Plan struct {
	ID              uuid.UUID
	Name            string
	StripeProductID string
	StripePriceID   string
	StripePriceIDYr string
	StripePriceIDMo string
	Amount          int64
	Currency        string
	BillingInterval BillingInterval
}

// TenantRepository is a local interface for billing to get tenant info (avoids import cycle)
type TenantRepository interface {
	GetByID(ctx context.Context, id uuid.UUID) (*TenantInfo, error)
	GetPlanByID(ctx context.Context, id uuid.UUID) (*Plan, error)
}

// SubscriptionRepository extension methods
type SubscriptionByStripeGetter interface {
	GetByStripeID(ctx context.Context, stripeID string) (*Subscription, error)
}
