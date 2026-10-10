// internal/tenant/models.go
package tenant

import (
    "database/sql/driver"
    "encoding/json"
    "fmt"
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
