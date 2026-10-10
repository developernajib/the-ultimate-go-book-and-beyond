// internal/billing/models.go
package billing

import (
    "time"

    "github.com/google/uuid"
)

// Subscription represents a tenant's active subscription
type Subscription struct {
    ID                  uuid.UUID          `json:"id" db:"id"`
    TenantID            uuid.UUID          `json:"tenant_id" db:"tenant_id"`
    PlanID              uuid.UUID          `json:"plan_id" db:"plan_id"`
    Status              SubscriptionStatus `json:"status" db:"status"`
    BillingInterval     BillingInterval    `json:"billing_interval" db:"billing_interval"`

    // Stripe
    StripeCustomerID    string             `json:"stripe_customer_id" db:"stripe_customer_id"`
    StripeSubscriptionID string            `json:"stripe_subscription_id" db:"stripe_subscription_id"`

    // Billing dates
    CurrentPeriodStart  time.Time          `json:"current_period_start" db:"current_period_start"`
    CurrentPeriodEnd    time.Time          `json:"current_period_end" db:"current_period_end"`
    TrialStart          *time.Time         `json:"trial_start,omitempty" db:"trial_start"`
    TrialEnd            *time.Time         `json:"trial_end,omitempty" db:"trial_end"`
    CanceledAt          *time.Time         `json:"canceled_at,omitempty" db:"canceled_at"`
    CancelAtPeriodEnd   bool               `json:"cancel_at_period_end" db:"cancel_at_period_end"`

    // Pricing
    Amount              int64              `json:"amount" db:"amount"` // cents
    Currency            string             `json:"currency" db:"currency"`

    // Usage-based billing
    UsageBasedEnabled   bool               `json:"usage_based_enabled" db:"usage_based_enabled"`

    // Metadata
    Metadata            JSONB              `json:"metadata" db:"metadata"`

    CreatedAt           time.Time          `json:"created_at" db:"created_at"`
    UpdatedAt           time.Time          `json:"updated_at" db:"updated_at"`
}

type SubscriptionStatus string

const (
    SubscriptionStatusTrialing      SubscriptionStatus = "trialing"
    SubscriptionStatusActive        SubscriptionStatus = "active"
    SubscriptionStatusPastDue       SubscriptionStatus = "past_due"
    SubscriptionStatusCanceled      SubscriptionStatus = "canceled"
    SubscriptionStatusUnpaid        SubscriptionStatus = "unpaid"
)

type BillingInterval string

const (
    BillingIntervalMonthly BillingInterval = "monthly"
    BillingIntervalYearly  BillingInterval = "yearly"
)

// UsageRecord tracks usage for metering and billing
type UsageRecord struct {
    ID          uuid.UUID  `json:"id" db:"id"`
    TenantID    uuid.UUID  `json:"tenant_id" db:"tenant_id"`
    MetricName  string     `json:"metric_name" db:"metric_name"`
    Quantity    int64      `json:"quantity" db:"quantity"`
    Timestamp   time.Time  `json:"timestamp" db:"timestamp"`

    // Aggregation period (for reporting)
    PeriodStart time.Time  `json:"period_start" db:"period_start"`
    PeriodEnd   time.Time  `json:"period_end" db:"period_end"`

    // Metadata for additional context
    Metadata    JSONB      `json:"metadata" db:"metadata"`

    CreatedAt   time.Time  `json:"created_at" db:"created_at"`
}

// Invoice represents a billing invoice
type Invoice struct {
    ID                  uuid.UUID      `json:"id" db:"id"`
    TenantID            uuid.UUID      `json:"tenant_id" db:"tenant_id"`
    SubscriptionID      uuid.UUID      `json:"subscription_id" db:"subscription_id"`
    InvoiceNumber       string         `json:"invoice_number" db:"invoice_number"`
    Status              InvoiceStatus  `json:"status" db:"status"`

    // Stripe
    StripeInvoiceID     string         `json:"stripe_invoice_id" db:"stripe_invoice_id"`

    // Amounts
    Subtotal            int64          `json:"subtotal" db:"subtotal"` // cents
    Tax                 int64          `json:"tax" db:"tax"`
    Total               int64          `json:"total" db:"total"`
    AmountDue           int64          `json:"amount_due" db:"amount_due"`
    AmountPaid          int64          `json:"amount_paid" db:"amount_paid"`
    Currency            string         `json:"currency" db:"currency"`

    // Line items stored separately

    // Dates
    PeriodStart         time.Time      `json:"period_start" db:"period_start"`
    PeriodEnd           time.Time      `json:"period_end" db:"period_end"`
    DueDate             time.Time      `json:"due_date" db:"due_date"`
    PaidAt              *time.Time     `json:"paid_at,omitempty" db:"paid_at"`

    // URLs
    InvoicePDF          *string        `json:"invoice_pdf,omitempty" db:"invoice_pdf"`
    HostedInvoiceURL    *string        `json:"hosted_invoice_url,omitempty" db:"hosted_invoice_url"`

    CreatedAt           time.Time      `json:"created_at" db:"created_at"`
    UpdatedAt           time.Time      `json:"updated_at" db:"updated_at"`
}

type InvoiceStatus string

const (
    InvoiceStatusDraft     InvoiceStatus = "draft"
    InvoiceStatusOpen      InvoiceStatus = "open"
    InvoiceStatusPaid      InvoiceStatus = "paid"
    InvoiceStatusVoid      InvoiceStatus = "void"
    InvoiceStatusUncollectible InvoiceStatus = "uncollectible"
)

// InvoiceLineItem represents a line item on an invoice
type InvoiceLineItem struct {
    ID          uuid.UUID  `json:"id" db:"id"`
    InvoiceID   uuid.UUID  `json:"invoice_id" db:"invoice_id"`
    Description string     `json:"description" db:"description"`
    Quantity    int64      `json:"quantity" db:"quantity"`
    UnitAmount  int64      `json:"unit_amount" db:"unit_amount"` // cents
    Amount      int64      `json:"amount" db:"amount"`
    Currency    string     `json:"currency" db:"currency"`
    Metadata    JSONB      `json:"metadata" db:"metadata"`
    CreatedAt   time.Time  `json:"created_at" db:"created_at"`
}

// PaymentMethod represents a stored payment method
type PaymentMethod struct {
    ID                      uuid.UUID         `json:"id" db:"id"`
    TenantID                uuid.UUID         `json:"tenant_id" db:"tenant_id"`
    StripePaymentMethodID   string            `json:"stripe_payment_method_id" db:"stripe_payment_method_id"`
    Type                    PaymentMethodType `json:"type" db:"type"`
    IsDefault               bool              `json:"is_default" db:"is_default"`

    // Card details (last 4, brand, exp)
    CardBrand               *string           `json:"card_brand,omitempty" db:"card_brand"`
    CardLast4               *string           `json:"card_last4,omitempty" db:"card_last4"`
    CardExpMonth            *int              `json:"card_exp_month,omitempty" db:"card_exp_month"`
    CardExpYear             *int              `json:"card_exp_year,omitempty" db:"card_exp_year"`

    CreatedAt               time.Time         `json:"created_at" db:"created_at"`
    UpdatedAt               time.Time         `json:"updated_at" db:"updated_at"`
}

type PaymentMethodType string

const (
    PaymentMethodTypeCard   PaymentMethodType = "card"
    PaymentMethodTypeACH    PaymentMethodType = "ach"
    PaymentMethodTypeSEPA   PaymentMethodType = "sepa"
)
