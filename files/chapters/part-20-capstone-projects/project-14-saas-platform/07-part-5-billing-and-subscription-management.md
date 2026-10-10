## Part 5: Billing and Subscription Management

Billing is the revenue engine of any SaaS platform. This section implements the full billing pipeline: integrating with Stripe for payment processing, managing subscription lifecycles (creation, upgrades, downgrades, cancellations), and tracking per-tenant resource usage for metered billing. Getting billing right is critical because bugs here directly cost you money or, worse, incorrectly charge your customers.

### Stripe Integration
Stripe is the most popular payment processor for SaaS platforms because it handles the complexity of subscriptions, invoicing, tax calculation, and payment method management. The code below wraps Stripe's Go SDK into a service that creates customers, manages subscriptions, and processes webhook events. Webhooks are especially important because Stripe uses them to notify your application about events like successful payments, failed charges, and subscription cancellations. You should always treat Stripe webhooks as the source of truth for billing state rather than relying solely on API responses.

```go
// internal/billing/stripe.go
package billing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	stripe "github.com/stripe/stripe-go/v78"
	"github.com/stripe/stripe-go/v78/customer"
	"github.com/stripe/stripe-go/v78/subscription"
	"github.com/stripe/stripe-go/v78/webhook"
)

// StripeBillingService orchestrates subscription management and webhook processing.
type StripeBillingService struct {
	webhookSecret string
	repo          Repository
}

func NewStripeBillingService(apiKey, webhookSecret string, repo Repository) *StripeBillingService {
	stripe.Key = apiKey
	return &StripeBillingService{
		webhookSecret: webhookSecret,
		repo:          repo,
	}
}

// CreateCustomer registers a tenant as a new customer in Stripe.
func (s *StripeBillingService) CreateCustomer(ctx context.Context, tenantID uuid.UUID, email, name string) (string, error) {
	params := &stripe.CustomerParams{
		Email: stripe.String(email),
		Name:  stripe.String(name),
		Metadata: map[string]string{
			"tenant_id": tenantID.String(),
		},
	}

	cust, err := customer.New(params)
	if err != nil {
		return "", fmt.Errorf("failed to create Stripe customer: %w", err)
	}

	return cust.ID, nil
}

// CreateSubscription subscribes a tenant to a paid plan.
func (s *StripeBillingService) CreateSubscription(ctx context.Context, customerID, priceID string) (*stripe.Subscription, error) {
	params := &stripe.SubscriptionParams{
		Customer: stripe.String(customerID),
		Items: []*stripe.SubscriptionItemsParams{
			{Price: stripe.String(priceID)},
		},
		PaymentBehavior: stripe.String("default_incomplete"),
	}
	params.AddExpand("latest_invoice.payment_intent")

	sub, err := subscription.New(params)
	if err != nil {
		return nil, fmt.Errorf("failed to create Stripe subscription: %w", err)
	}

	return sub, nil
}

// ProcessWebhook parses and handles verified Stripe webhook events.
func (s *StripeBillingService) ProcessWebhook(ctx context.Context, payload []byte, sigHeader string) error {
	event, err := webhook.ConstructEvent(payload, sigHeader, s.webhookSecret)
	if err != nil {
		return fmt.Errorf("webhook signature verification failed: %w", err)
	}

	switch event.Type {
	case "invoice.paid":
		var inv stripe.Invoice
		if err := json.Unmarshal(event.Data.Raw, &inv); err != nil {
			return err
		}
		return s.handleInvoicePaid(ctx, &inv)

	case "customer.subscription.deleted":
		var sub stripe.Subscription
		if err := json.Unmarshal(event.Data.Raw, &sub); err != nil {
			return err
		}
		return s.handleSubscriptionCancelled(ctx, &sub)

	default:
		return nil
	}
}

func (s *StripeBillingService) handleInvoicePaid(ctx context.Context, inv *stripe.Invoice) error {
	if inv.Customer == nil {
		return errors.New("invoice missing customer")
	}
	return s.repo.RecordPaymentSuccess(ctx, inv.Customer.ID, inv.AmountPaid)
}

func (s *StripeBillingService) handleSubscriptionCancelled(ctx context.Context, sub *stripe.Subscription) error {
	return s.repo.UpdateSubscriptionStatus(ctx, sub.ID, "cancelled")
}
```

### Usage Tracking and Metering

Many SaaS platforms charge based on how much a tenant actually uses, whether that is API calls, storage, compute time, or number of users. Usage tracking records every countable event in real time, and metering aggregates those events into billable quantities at the end of each billing period. The code below implements a usage tracker that records events, checks them against quota limits, and reports aggregated usage to Stripe for metered billing. It uses Redis for fast counters and periodically flushes accumulated usage to the database for durability.

```go
// internal/billing/usage.go
package billing

import (
    "context"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/yourorg/tenantflow/internal/isolation"
)

// UsageTracker tracks resource usage for billing
type UsageTracker struct {
    usageRepo UsageRepository
    cache     cache.Cache
    logger    logger.Logger
}

func NewUsageTracker(usageRepo UsageRepository, cache cache.Cache, logger logger.Logger) *UsageTracker {
    return &UsageTracker{
        usageRepo: usageRepo,
        cache:     cache,
        logger:    logger,
    }
}

// TrackUsage records a usage event
func (t *UsageTracker) TrackUsage(ctx context.Context, metricName string, quantity int64, metadata JSONB) error {
    tenantID, err := isolation.TenantID(ctx)
    if err != nil {
        return err
    }

    now := time.Now().UTC()

    record := &UsageRecord{
        ID:          uuid.New(),
        TenantID:    tenantID,
        MetricName:  metricName,
        Quantity:    quantity,
        Timestamp:   now,
        PeriodStart: startOfMonth(now),
        PeriodEnd:   endOfMonth(now),
        Metadata:    metadata,
        CreatedAt:   now,
    }

    if err := t.usageRepo.Create(ctx, record); err != nil {
        return fmt.Errorf("failed to record usage: %w", err)
    }

    // Update cached usage counters
    t.incrementCachedUsage(ctx, tenantID, metricName, quantity)

    return nil
}

// GetUsage retrieves usage for a tenant and metric
func (t *UsageTracker) GetUsage(ctx context.Context, tenantID uuid.UUID, metricName string, start, end time.Time) (int64, error) {
    return t.usageRepo.GetTotalUsage(ctx, tenantID, metricName, start, end)
}

// GetCurrentMonthUsage retrieves usage for the current billing period
func (t *UsageTracker) GetCurrentMonthUsage(ctx context.Context, tenantID uuid.UUID, metricName string) (int64, error) {
    now := time.Now().UTC()
    start := startOfMonth(now)
    end := endOfMonth(now)

    // Check cache first
    cacheKey := fmt.Sprintf("usage:%s:%s:%s", tenantID, metricName, start.Format("2006-01"))
    if cached, err := t.cache.Get(ctx, cacheKey); err == nil {
        if usage, ok := cached.(int64); ok {
            return usage, nil
        }
    }

    // Get from database
    usage, err := t.usageRepo.GetTotalUsage(ctx, tenantID, metricName, start, end)
    if err != nil {
        return 0, err
    }

    // Cache for 5 minutes
    t.cache.Set(ctx, cacheKey, usage, 5*time.Minute)

    return usage, nil
}

// GetUsageBreakdown retrieves detailed usage breakdown
func (t *UsageTracker) GetUsageBreakdown(ctx context.Context, tenantID uuid.UUID, start, end time.Time) (map[string]int64, error) {
    records, err := t.usageRepo.GetByTenantAndPeriod(ctx, tenantID, start, end)
    if err != nil {
        return nil, err
    }

    breakdown := make(map[string]int64)
    for _, record := range records {
        breakdown[record.MetricName] += record.Quantity
    }

    return breakdown, nil
}

func (t *UsageTracker) incrementCachedUsage(ctx context.Context, tenantID uuid.UUID, metricName string, quantity int64) {
    now := time.Now().UTC()
    cacheKey := fmt.Sprintf("usage:%s:%s:%s", tenantID, metricName, now.Format("2006-01"))

    // Increment counter in cache
    t.cache.Increment(ctx, cacheKey, quantity)
}

func startOfMonth(t time.Time) time.Time {
    return time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, t.Location())
}

func endOfMonth(t time.Time) time.Time {
    return startOfMonth(t).AddDate(0, 1, 0).Add(-time.Nanosecond)
}

// UsageMiddleware tracks API usage
type UsageMiddleware struct {
    tracker *UsageTracker
    logger  logger.Logger
}

func NewUsageMiddleware(tracker *UsageTracker, logger logger.Logger) *UsageMiddleware {
    return &UsageMiddleware{
        tracker: tracker,
        logger:  logger,
    }
}

func (m *UsageMiddleware) Handler(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Track API call
        if err := m.tracker.TrackUsage(r.Context(), "api_calls", 1, nil); err != nil {
            m.logger.Error("failed to track API usage", "error", err)
        }

        next.ServeHTTP(w, r)
    })
}
```
