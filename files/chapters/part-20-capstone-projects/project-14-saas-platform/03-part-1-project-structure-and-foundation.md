## Part 1: Project Structure and Foundation

> **Why `github.com/google/uuid` and not the Go 1.27 stdlib `uuid` package?** This project stores `uuid.UUID` values in struct fields that are scanned from the database and passed as query arguments. That path requires the `sql.Scanner` and `driver.Valuer` interfaces, which the standard library type deliberately does not implement. The third-party package remains the right choice wherever UUIDs cross a `database/sql` boundary. Projects in this book whose UUIDs stay in memory or serialize as strings (the URL shortener, API gateway, and ML platform) use the stdlib package instead.


Before writing any business logic, you need a well-organized project structure that separates concerns cleanly. A multi-tenant SaaS platform has many moving parts, including tenant management, authentication, billing, and deployment, so getting the foundation right saves you from painful refactors later. In this section, you will set up the directory layout, define the core data models, and establish the shared types that every other service will depend on.

### Directory Structure

The directory structure below follows Go's standard project layout conventions, splitting the codebase into separate services under `cmd/` and shared domain logic under `internal/`. Each service is independently deployable, which makes it easier to scale individual components as your platform grows. Notice how the `internal/` folder groups code by business domain (tenant, auth, billing) rather than by technical layer, which keeps related logic together and enforces clear boundaries between modules.

```
tenantflow/
├── cmd/
│   ├── api-gateway/           # API gateway service
│   ├── tenant-service/        # Tenant management service
│   ├── auth-service/          # Authentication service
│   ├── billing-service/       # Billing and subscriptions
│   ├── app-service/           # Core application service
│   ├── admin-service/         # Admin dashboard backend
│   └── migrate/               # Database migration tool
├── internal/
│   ├── tenant/                # Tenant domain logic
│   │   ├── models.go
│   │   ├── repository.go
│   │   ├── service.go
│   │   └── provisioner.go
│   ├── auth/                  # Auth domain logic
│   │   ├── jwt.go
│   │   ├── oauth.go
│   │   ├── saml.go
│   │   └── rbac.go
│   ├── billing/               # Billing domain logic
│   │   ├── subscription.go
│   │   ├── usage.go
│   │   ├── stripe.go
│   │   └── invoice.go
│   ├── isolation/             # Multi-tenancy patterns
│   │   ├── context.go
│   │   ├── middleware.go
│   │   ├── database.go
│   │   └── scoping.go
│   ├── whitelabel/            # White-labeling
│   │   ├── branding.go
│   │   ├── domain.go
│   │   └── templates.go
│   ├── quota/                 # Resource quotas
│   │   ├── enforcer.go
│   │   ├── tracker.go
│   │   └── limits.go
│   └── pkg/                   # Shared packages
│       ├── database/
│       ├── cache/
│       ├── events/
│       ├── metrics/
│       └── logger/
├── pkg/                       # Public packages
│   ├── api/                   # API client libraries
│   └── sdk/                   # SDK for integrations
├── migrations/                # Database migrations
│   ├── shared/
│   └── tenant/
├── deploy/                    # Deployment configs
│   ├── kubernetes/
│   │   ├── base/
│   │   └── overlays/
│   └── helm/
├── docs/                      # Documentation
├── scripts/                   # Utility scripts
└── tests/                     # Integration tests
    ├── e2e/
    └── load/
```

### Core Data Models

The tenant model is the heart of your SaaS platform. Every request, every database query, and every billing event ties back to a specific tenant. The models below define what a tenant looks like, what states it can be in (provisioning, active, suspended, and so on), and which isolation strategy it uses for data storage. Pay close attention to the `Settings` and `BrandingConfig` fields, as these allow each tenant to customize their experience without requiring separate deployments.

```go
// internal/tenant/models.go
package tenant

import (
    "database/sql/driver"
    "encoding/json"
    "time"

    "github.com/google/uuid"
)

// TenantStatus represents the lifecycle state of a tenant
type TenantStatus string

const (
    TenantStatusProvisioning TenantStatus = "provisioning"
    TenantStatusActive       TenantStatus = "active"
    TenantStatusSuspended    TenantStatus = "suspended"
    TenantStatusCanceled     TenantStatus = "canceled"
    TenantStatusDeleted      TenantStatus = "deleted"
)

// IsolationStrategy defines how tenant data is isolated
type IsolationStrategy string

const (
    // SharedDatabase, shared schema with row-level isolation
    IsolationSharedSchema IsolationStrategy = "shared_schema"

    // Shared database, separate schema per tenant
    IsolationSeparateSchema IsolationStrategy = "separate_schema"

    // Completely separate database per tenant
    IsolationSeparateDatabase IsolationStrategy = "separate_database"

    // Hybrid: small tenants share, large tenants get dedicated
    IsolationHybrid IsolationStrategy = "hybrid"
)

// Tenant represents a customer organization in the SaaS platform
type Tenant struct {
    ID                uuid.UUID          `json:"id" db:"id"`
    Name              string             `json:"name" db:"name"`
    Slug              string             `json:"slug" db:"slug"` // URL-safe identifier
    Subdomain         string             `json:"subdomain" db:"subdomain"`
    CustomDomain      *string            `json:"custom_domain,omitempty" db:"custom_domain"`
    Status            TenantStatus       `json:"status" db:"status"`
    IsolationStrategy IsolationStrategy  `json:"isolation_strategy" db:"isolation_strategy"`

    // Plan and billing
    PlanID            uuid.UUID          `json:"plan_id" db:"plan_id"`
    SubscriptionID    *string            `json:"subscription_id,omitempty" db:"subscription_id"`
    TrialEndsAt       *time.Time         `json:"trial_ends_at,omitempty" db:"trial_ends_at"`
    BillingEmail      string             `json:"billing_email" db:"billing_email"`

    // Settings and customization
    Settings          TenantSettings     `json:"settings" db:"settings"`
    Branding          BrandingSettings   `json:"branding" db:"branding"`
    Features          FeatureFlags       `json:"features" db:"features"`

    // Metadata
    Metadata          JSONB              `json:"metadata" db:"metadata"`

    // Database connection info (for separate DB strategy)
    DatabaseHost      *string            `json:"-" db:"database_host"`
    DatabaseName      *string            `json:"-" db:"database_name"`
    DatabaseUser      *string            `json:"-" db:"database_user"`
    DatabasePassword  *string            `json:"-" db:"database_password"` // Encrypted

    // Timestamps
    CreatedAt         time.Time          `json:"created_at" db:"created_at"`
    UpdatedAt         time.Time          `json:"updated_at" db:"updated_at"`
    DeletedAt         *time.Time         `json:"deleted_at,omitempty" db:"deleted_at"`
}

// TenantSettings contains tenant-specific configuration
type TenantSettings struct {
    Timezone              string            `json:"timezone"`
    Language              string            `json:"language"`
    DateFormat            string            `json:"date_format"`
    TimeFormat            string            `json:"time_format"`
    AllowedEmailDomains   []string          `json:"allowed_email_domains"`
    SSOEnabled            bool              `json:"sso_enabled"`
    SSOProvider           string            `json:"sso_provider,omitempty"`
    RequireMFA            bool              `json:"require_mfa"`
    SessionTimeout        int               `json:"session_timeout"` // minutes
    PasswordPolicy        PasswordPolicy    `json:"password_policy"`
    DataRetentionDays     int               `json:"data_retention_days"`
    AllowedIPRanges       []string          `json:"allowed_ip_ranges,omitempty"`
}

// PasswordPolicy defines password requirements for a tenant
type PasswordPolicy struct {
    MinLength            int  `json:"min_length"`
    RequireUppercase     bool `json:"require_uppercase"`
    RequireLowercase     bool `json:"require_lowercase"`
    RequireNumbers       bool `json:"require_numbers"`
    RequireSpecialChars  bool `json:"require_special_chars"`
    ExpirationDays       int  `json:"expiration_days"`
    PreventReuse         int  `json:"prevent_reuse"` // Number of previous passwords
}

// BrandingSettings contains white-labeling configuration
type BrandingSettings struct {
    LogoURL           string            `json:"logo_url"`
    FaviconURL        string            `json:"favicon_url"`
    PrimaryColor      string            `json:"primary_color"`
    SecondaryColor    string            `json:"secondary_color"`
    AccentColor       string            `json:"accent_color"`
    CompanyName       string            `json:"company_name"`
    SupportEmail      string            `json:"support_email"`
    SupportURL        string            `json:"support_url"`
    CustomCSS         string            `json:"custom_css,omitempty"`
    EmailTemplates    EmailTemplates    `json:"email_templates"`
}

// EmailTemplates stores customized email template IDs
type EmailTemplates struct {
    Welcome           string `json:"welcome"`
    Invitation        string `json:"invitation"`
    PasswordReset     string `json:"password_reset"`
    Invoice           string `json:"invoice"`
    TrialExpiring     string `json:"trial_expiring"`
}

// FeatureFlags represents enabled features for a tenant based on their plan
type FeatureFlags map[string]bool

// Plan represents a subscription plan
type Plan struct {
    ID                uuid.UUID         `json:"id" db:"id"`
    Name              string            `json:"name" db:"name"`
    DisplayName       string            `json:"display_name" db:"display_name"`
    Description       string            `json:"description" db:"description"`
    PriceMonthly      int64             `json:"price_monthly" db:"price_monthly"` // cents
    PriceYearly       int64             `json:"price_yearly" db:"price_yearly"`   // cents
    TrialDays         int               `json:"trial_days" db:"trial_days"`
    Features          FeatureFlags      `json:"features" db:"features"`
    Limits            PlanLimits        `json:"limits" db:"limits"`
    IsPublic          bool              `json:"is_public" db:"is_public"`
    StripePriceIDMo   string            `json:"stripe_price_id_monthly" db:"stripe_price_id_monthly"`
    StripePriceIDYr   string            `json:"stripe_price_id_yearly" db:"stripe_price_id_yearly"`
    CreatedAt         time.Time         `json:"created_at" db:"created_at"`
    UpdatedAt         time.Time         `json:"updated_at" db:"updated_at"`
}

// PlanLimits defines resource quotas for a plan
type PlanLimits struct {
    MaxUsers              int   `json:"max_users"`
    MaxProjects           int   `json:"max_projects"`
    MaxStorageGB          int   `json:"max_storage_gb"`
    MaxAPICallsPerMonth   int64 `json:"max_api_calls_per_month"`
    MaxCustomDomains      int   `json:"max_custom_domains"`
    MaxTeamMembers        int   `json:"max_team_members"`
    MaxIntegrations       int   `json:"max_integrations"`
}

// JSONB is a type for PostgreSQL JSONB columns
type JSONB map[string]any

func (j JSONB) Value() (driver.Value, error) {
    return json.Marshal(j)
}

func (j *JSONB) Scan(value any) error {
    if value == nil {
        *j = make(JSONB)
        return nil
    }

    bytes, ok := value.([]byte)
    if !ok {
        return fmt.Errorf("failed to unmarshal JSONB value: %v", value)
    }

    return json.Unmarshal(bytes, j)
}

// Implement Value and Scan for custom types
func (ts TenantSettings) Value() (driver.Value, error) {
    return json.Marshal(ts)
}

func (ts *TenantSettings) Scan(value any) error {
    if value == nil {
        return nil
    }
    bytes, ok := value.([]byte)
    if !ok {
        return fmt.Errorf("failed to scan TenantSettings")
    }
    return json.Unmarshal(bytes, ts)
}

func (bs BrandingSettings) Value() (driver.Value, error) {
    return json.Marshal(bs)
}

func (bs *BrandingSettings) Scan(value any) error {
    if value == nil {
        return nil
    }
    bytes, ok := value.([]byte)
    if !ok {
        return fmt.Errorf("failed to scan BrandingSettings")
    }
    return json.Unmarshal(bytes, bs)
}

func (ff FeatureFlags) Value() (driver.Value, error) {
    return json.Marshal(ff)
}

func (ff *FeatureFlags) Scan(value any) error {
    if value == nil {
        *ff = make(FeatureFlags)
        return nil
    }
    bytes, ok := value.([]byte)
    if !ok {
        return fmt.Errorf("failed to scan FeatureFlags")
    }
    return json.Unmarshal(bytes, ff)
}

func (pl PlanLimits) Value() (driver.Value, error) {
    return json.Marshal(pl)
}

func (pl *PlanLimits) Scan(value any) error {
    if value == nil {
        return nil
    }
    bytes, ok := value.([]byte)
    if !ok {
        return fmt.Errorf("failed to scan PlanLimits")
    }
    return json.Unmarshal(bytes, pl)
}
```

### User and Authentication Models

Users always belong to a tenant, and their permissions are scoped to that tenant's resources. The models below define user accounts, login sessions, and the relationship between users and their organizations. Each user has a role within their tenant (such as owner, admin, or member), and can optionally authenticate through single sign-on providers. These models form the foundation for the authentication and authorization logic you will build in Part 4.

```go
// internal/auth/models.go
package auth

import (
    "time"

    "github.com/google/uuid"
)

// User represents an individual user within a tenant
type User struct {
    ID                uuid.UUID         `json:"id" db:"id"`
    TenantID          uuid.UUID         `json:"tenant_id" db:"tenant_id"`
    Email             string            `json:"email" db:"email"`
    EmailVerified     bool              `json:"email_verified" db:"email_verified"`
    PasswordHash      string            `json:"-" db:"password_hash"`
    FirstName         string            `json:"first_name" db:"first_name"`
    LastName          string            `json:"last_name" db:"last_name"`
    AvatarURL         *string           `json:"avatar_url,omitempty" db:"avatar_url"`

    // Role and permissions
    Role              Role              `json:"role" db:"role"`
    Permissions       []string          `json:"permissions" db:"permissions"`

    // MFA
    MFAEnabled        bool              `json:"mfa_enabled" db:"mfa_enabled"`
    MFASecret         *string           `json:"-" db:"mfa_secret"`

    // SSO
    SSOProvider       *string           `json:"sso_provider,omitempty" db:"sso_provider"`
    SSOExternalID     *string           `json:"sso_external_id,omitempty" db:"sso_external_id"`

    // Status
    Status            UserStatus        `json:"status" db:"status"`
    LastLoginAt       *time.Time        `json:"last_login_at,omitempty" db:"last_login_at"`
    LastLoginIP       *string           `json:"last_login_ip,omitempty" db:"last_login_ip"`

    // Invitation
    InvitedBy         *uuid.UUID        `json:"invited_by,omitempty" db:"invited_by"`
    InvitedAt         *time.Time        `json:"invited_at,omitempty" db:"invited_at"`
    InviteAcceptedAt  *time.Time        `json:"invite_accepted_at,omitempty" db:"invite_accepted_at"`

    // Metadata
    Metadata          JSONB             `json:"metadata" db:"metadata"`

    // Timestamps
    CreatedAt         time.Time         `json:"created_at" db:"created_at"`
    UpdatedAt         time.Time         `json:"updated_at" db:"updated_at"`
    DeletedAt         *time.Time        `json:"deleted_at,omitempty" db:"deleted_at"`
}

type UserStatus string

const (
    UserStatusActive    UserStatus = "active"
    UserStatusInvited   UserStatus = "invited"
    UserStatusSuspended UserStatus = "suspended"
    UserStatusDeleted   UserStatus = "deleted"
)

type Role string

const (
    RoleOwner       Role = "owner"
    RoleAdmin       Role = "admin"
    RoleMember      Role = "member"
    RoleReadOnly    Role = "readonly"
    RoleCustom      Role = "custom"
)

// Permission represents a granular permission
type Permission struct {
    ID          uuid.UUID  `json:"id" db:"id"`
    TenantID    uuid.UUID  `json:"tenant_id" db:"tenant_id"`
    Name        string     `json:"name" db:"name"`
    Resource    string     `json:"resource" db:"resource"`
    Action      string     `json:"action" db:"action"`
    Description string     `json:"description" db:"description"`
    CreatedAt   time.Time  `json:"created_at" db:"created_at"`
}

// RolePermission maps roles to permissions
type RolePermission struct {
    ID           uuid.UUID  `json:"id" db:"id"`
    TenantID     uuid.UUID  `json:"tenant_id" db:"tenant_id"`
    Role         Role       `json:"role" db:"role"`
    PermissionID uuid.UUID  `json:"permission_id" db:"permission_id"`
    CreatedAt    time.Time  `json:"created_at" db:"created_at"`
}

// Session represents an active user session
type Session struct {
    ID           uuid.UUID  `json:"id" db:"id"`
    UserID       uuid.UUID  `json:"user_id" db:"user_id"`
    TenantID     uuid.UUID  `json:"tenant_id" db:"tenant_id"`
    RefreshToken string     `json:"-" db:"refresh_token"`
    DeviceInfo   string     `json:"device_info" db:"device_info"`
    IPAddress    string     `json:"ip_address" db:"ip_address"`
    ExpiresAt    time.Time  `json:"expires_at" db:"expires_at"`
    CreatedAt    time.Time  `json:"created_at" db:"created_at"`
}

// SSOConfig represents SSO configuration for a tenant
type SSOConfig struct {
    ID           uuid.UUID   `json:"id" db:"id"`
    TenantID     uuid.UUID   `json:"tenant_id" db:"tenant_id"`
    Provider     SSOProvider `json:"provider" db:"provider"`
    Enabled      bool        `json:"enabled" db:"enabled"`

    // SAML
    SAMLMetadataURL  *string `json:"saml_metadata_url,omitempty" db:"saml_metadata_url"`
    SAMLEntityID     *string `json:"saml_entity_id,omitempty" db:"saml_entity_id"`
    SAMLCertificate  *string `json:"saml_certificate,omitempty" db:"saml_certificate"`

    // OIDC
    OIDCIssuer       *string `json:"oidc_issuer,omitempty" db:"oidc_issuer"`
    OIDCClientID     *string `json:"oidc_client_id,omitempty" db:"oidc_client_id"`
    OIDCClientSecret *string `json:"-" db:"oidc_client_secret"`

    // Attribute mapping
    AttributeMapping map[string]string `json:"attribute_mapping" db:"attribute_mapping"`

    CreatedAt    time.Time  `json:"created_at" db:"created_at"`
    UpdatedAt    time.Time  `json:"updated_at" db:"updated_at"`
}

type SSOProvider string

const (
    SSOProviderSAML   SSOProvider = "saml"
    SSOProviderOIDC   SSOProvider = "oidc"
    SSOProviderOAuth2 SSOProvider = "oauth2"
)
```

### Billing Models

Billing in a SaaS platform involves subscriptions, plans, invoices, and usage records. The models below capture the full billing lifecycle, from the moment a tenant picks a plan to the generation of monthly invoices. Subscription plans define what features and resource limits each pricing tier includes, while usage records track how much of each resource a tenant consumes. These models integrate tightly with Stripe, so you will see fields like `StripeCustomerID` and `StripeSubscriptionID` that map directly to Stripe's API objects.

```go
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
```
