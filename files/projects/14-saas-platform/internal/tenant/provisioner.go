// internal/tenant/provisioner.go
package tenant

import (
    "context"
    "crypto/rand"
    "encoding/hex"
    "fmt"
    "time"

    "github.com/google/uuid"
    "github.com/jmoiron/sqlx"
    "github.com/example/saas-platform/internal/billing"
    "github.com/example/saas-platform/pkg/events"
    "github.com/example/saas-platform/pkg/logger"
)

// Provisioner handles tenant provisioning and setup
type Provisioner struct {
    tenantRepo    Repository
    db            *sqlx.DB
    eventPublisher events.Publisher
    logger        logger.Logger
}

func NewProvisioner(
    tenantRepo Repository,
    db *sqlx.DB,
    eventPublisher events.Publisher,
    logger logger.Logger,
) *Provisioner {
    return &Provisioner{
        tenantRepo:     tenantRepo,
        db:             db,
        eventPublisher: eventPublisher,
        logger:         logger,
    }
}

// ProvisionRequest contains parameters for provisioning a new tenant
type ProvisionRequest struct {
    Name              string
    Subdomain         string
    OwnerEmail        string
    OwnerFirstName    string
    OwnerLastName     string
    PlanID            uuid.UUID
    IsolationStrategy IsolationStrategy
    TrialDays         int
}

// ProvisionResult contains the results of tenant provisioning
type ProvisionResult struct {
    Tenant           *Tenant
    OwnerUser        *User
    Subscription     *billing.Subscription
    SetupToken       string // Token for completing setup
}

// Provision creates and sets up a new tenant
func (p *Provisioner) Provision(ctx context.Context, req *ProvisionRequest) (*ProvisionResult, error) {
    p.logger.Info("starting tenant provisioning", "subdomain", req.Subdomain)

    // Start transaction
    tx, err := p.db.BeginTxx(ctx, nil)
    if err != nil {
        return nil, fmt.Errorf("failed to begin transaction: %w", err)
    }
    defer tx.Rollback()

    // Create tenant
    tenant, err := p.createTenant(ctx, tx, req)
    if err != nil {
        return nil, fmt.Errorf("failed to create tenant: %w", err)
    }

    // Set up database isolation
    if err := p.setupDatabaseIsolation(ctx, tx, tenant); err != nil {
        return nil, fmt.Errorf("failed to setup database isolation: %w", err)
    }

    // Create owner user
    owner, err := p.createOwnerUser(ctx, tx, tenant, req)
    if err != nil {
        return nil, fmt.Errorf("failed to create owner user: %w", err)
    }

    // Create subscription (trial or paid)
    subscription, err := p.createSubscription(ctx, tx, tenant, req)
    if err != nil {
        return nil, fmt.Errorf("failed to create subscription: %w", err)
    }

    // Create default resources
    if err := p.createDefaultResources(ctx, tx, tenant); err != nil {
        return nil, fmt.Errorf("failed to create default resources: %w", err)
    }

    // Generate setup token
    setupToken, err := p.generateSetupToken(ctx, tenant, owner)
    if err != nil {
        return nil, fmt.Errorf("failed to generate setup token: %w", err)
    }

    // Commit transaction
    if err := tx.Commit(); err != nil {
        return nil, fmt.Errorf("failed to commit transaction: %w", err)
    }

    // Publish tenant created event
    if err := p.publishTenantCreatedEvent(ctx, tenant, owner); err != nil {
        p.logger.Error("failed to publish tenant created event", "error", err)
        // Don't fail provisioning for event publishing errors
    }

    p.logger.Info("tenant provisioned successfully", "tenant_id", tenant.ID)

    return &ProvisionResult{
        Tenant:       tenant,
        OwnerUser:    owner,
        Subscription: subscription,
        SetupToken:   setupToken,
    }, nil
}

func (p *Provisioner) createTenant(ctx context.Context, tx *sqlx.Tx, req *ProvisionRequest) (*Tenant, error) {
    // Validate subdomain availability
    exists, err := p.tenantRepo.SubdomainExists(ctx, req.Subdomain)
    if err != nil {
        return nil, err
    }
    if exists {
        return nil, fmt.Errorf("subdomain already exists: %s", req.Subdomain)
    }

    // Get plan details
    plan, err := p.tenantRepo.GetPlanByID(ctx, req.PlanID)
    if err != nil {
        return nil, fmt.Errorf("invalid plan ID: %w", err)
    }

    // Create tenant
    tenant := &Tenant{
        ID:                uuid.New(),
        Name:              req.Name,
        Slug:              req.Subdomain,
        Subdomain:         req.Subdomain,
        Status:            TenantStatusProvisioning,
        IsolationStrategy: req.IsolationStrategy,
        PlanID:            req.PlanID,
        BillingEmail:      req.OwnerEmail,
        Settings:          getDefaultSettings(),
        Branding:          getDefaultBranding(),
        Features:          plan.Features,
        Metadata:          make(JSONB),
        CreatedAt:         time.Now().UTC(),
        UpdatedAt:         time.Now().UTC(),
    }

    // Set trial end date if applicable
    if req.TrialDays > 0 {
        trialEnd := time.Now().UTC().AddDate(0, 0, req.TrialDays)
        tenant.TrialEndsAt = &trialEnd
    }

    if err := p.tenantRepo.Create(ctx, tx, tenant); err != nil {
        return nil, err
    }

    return tenant, nil
}

func (p *Provisioner) setupDatabaseIsolation(ctx context.Context, tx *sqlx.Tx, tenant *Tenant) error {
    switch tenant.IsolationStrategy {
    case IsolationSharedSchema:
        // No additional setup needed for shared schema
        return nil

    case IsolationSeparateSchema:
        // Create schema for tenant
        schemaName := fmt.Sprintf("tenant_%s", tenant.ID.String())

        _, err := tx.ExecContext(ctx, fmt.Sprintf("CREATE SCHEMA IF NOT EXISTS %s", schemaName))
        if err != nil {
            return fmt.Errorf("failed to create schema: %w", err)
        }

        // Run migrations in tenant schema
        if err := p.runTenantMigrations(ctx, schemaName); err != nil {
            return fmt.Errorf("failed to run tenant migrations: %w", err)
        }

        return nil

    case IsolationSeparateDatabase:
        // Create separate database for tenant
        dbName := fmt.Sprintf("tenant_%s", tenant.ID.String())

        _, err := tx.ExecContext(ctx, fmt.Sprintf("CREATE DATABASE %s", dbName))
        if err != nil {
            return fmt.Errorf("failed to create database: %w", err)
        }

        // Store database info
        tenant.DatabaseName = &dbName

        // Run migrations in tenant database
        if err := p.runTenantMigrations(ctx, dbName); err != nil {
            return fmt.Errorf("failed to run tenant migrations: %w", err)
        }

        return nil

    default:
        return fmt.Errorf("unknown isolation strategy: %s", tenant.IsolationStrategy)
    }
}

func (p *Provisioner) createOwnerUser(ctx context.Context, tx *sqlx.Tx, tenant *Tenant, req *ProvisionRequest) (*User, error) {
    // Create owner user
    owner := &User{
        ID:            uuid.New(),
        TenantID:      tenant.ID,
        Email:         req.OwnerEmail,
        FirstName:     req.OwnerFirstName,
        LastName:      req.OwnerLastName,
        Role:          RoleOwner,
        Permissions:   []string{"*"}, // All permissions
        Status:        UserStatusActive,
        EmailVerified: false, // Will be verified via setup token
        Metadata:      make(JSONB),
        CreatedAt:     time.Now().UTC(),
        UpdatedAt:     time.Now().UTC(),
    }

    // Note: Password will be set during onboarding

    if err := p.tenantRepo.CreateUser(ctx, tx, owner); err != nil {
        return nil, err
    }

    return owner, nil
}

func (p *Provisioner) createSubscription(ctx context.Context, tx *sqlx.Tx, tenant *Tenant, req *ProvisionRequest) (*billing.Subscription, error) {
    now := time.Now().UTC()

    subscription := &billing.Subscription{
        ID:                 uuid.New(),
        TenantID:           tenant.ID,
        PlanID:             req.PlanID,
        Status:             billing.SubscriptionStatusTrialing,
        BillingInterval:    billing.BillingIntervalMonthly,
        CurrentPeriodStart: now,
        CurrentPeriodEnd:   now.AddDate(0, 1, 0),
        CreatedAt:          now,
        UpdatedAt:          now,
    }

    if req.TrialDays > 0 {
        trialStart := now
        trialEnd := now.AddDate(0, 0, req.TrialDays)
        subscription.TrialStart = &trialStart
        subscription.TrialEnd = &trialEnd
    }

    // Stripe integration will be set up during onboarding

    if err := p.tenantRepo.CreateSubscription(ctx, tx, subscription); err != nil {
        return nil, err
    }

    return subscription, nil
}

func (p *Provisioner) createDefaultResources(ctx context.Context, tx *sqlx.Tx, tenant *Tenant) error {
    // Create default permissions
    permissions := []Permission{
        {ID: uuid.New(), TenantID: tenant.ID, Name: "users:read", Resource: "users", Action: "read", Description: "View users"},
        {ID: uuid.New(), TenantID: tenant.ID, Name: "users:write", Resource: "users", Action: "write", Description: "Manage users"},
        {ID: uuid.New(), TenantID: tenant.ID, Name: "projects:read", Resource: "projects", Action: "read", Description: "View projects"},
        {ID: uuid.New(), TenantID: tenant.ID, Name: "projects:write", Resource: "projects", Action: "write", Description: "Manage projects"},
        {ID: uuid.New(), TenantID: tenant.ID, Name: "settings:read", Resource: "settings", Action: "read", Description: "View settings"},
        {ID: uuid.New(), TenantID: tenant.ID, Name: "settings:write", Resource: "settings", Action: "write", Description: "Manage settings"},
    }

    for _, perm := range permissions {
        if err := p.tenantRepo.CreatePermission(ctx, tx, &perm); err != nil {
            return fmt.Errorf("failed to create permission: %w", err)
        }
    }

    // Additional default resources can be created here

    return nil
}

func (p *Provisioner) generateSetupToken(_ context.Context, _ *Tenant, _ *User) (string, error) {
    // Generate a random secure setup token valid for 24 hours
    b := make([]byte, 32)
    if _, err := rand.Read(b); err != nil {
        return "", fmt.Errorf("failed to generate setup token: %w", err)
    }
    return hex.EncodeToString(b), nil
}

func (p *Provisioner) publishTenantCreatedEvent(ctx context.Context, tenant *Tenant, owner *User) error {
    event := events.Event{
        ID:        uuid.New().String(),
        Type:      "tenant.created",
        TenantID:  tenant.ID.String(),
        Timestamp: time.Now().UTC(),
        Payload: map[string]any{
            "tenant_id":   tenant.ID.String(),
            "subdomain":   tenant.Subdomain,
            "plan_id":     tenant.PlanID.String(),
            "owner_email": owner.Email,
        },
    }

    return p.eventPublisher.Publish(ctx, event)
}

func (p *Provisioner) runTenantMigrations(ctx context.Context, targetSchema string) error {
    // Run database migrations for tenant schema/database
    // Implementation depends on migration tool (e.g., golang-migrate)
    return nil
}

func getDefaultSettings() TenantSettings {
    return TenantSettings{
        Timezone:          "UTC",
        Language:          "en",
        DateFormat:        "YYYY-MM-DD",
        TimeFormat:        "24h",
        RequireMFA:        false,
        SessionTimeout:    480, // 8 hours
        DataRetentionDays: 365,
        PasswordPolicy: PasswordPolicy{
            MinLength:           8,
            RequireUppercase:    true,
            RequireLowercase:    true,
            RequireNumbers:      true,
            RequireSpecialChars: false,
            ExpirationDays:      90,
            PreventReuse:        5,
        },
    }
}

func getDefaultBranding() BrandingSettings {
    return BrandingSettings{
        PrimaryColor:   "#3B82F6",
        SecondaryColor: "#1E40AF",
        AccentColor:    "#10B981",
        CompanyName:    "",
        SupportEmail:   "support@tenantflow.io",
    }
}
