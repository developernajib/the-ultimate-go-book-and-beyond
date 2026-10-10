// internal/admin/service.go
package admin

import (
    "context"
    "time"

    "github.com/google/uuid"
    "github.com/example/saas-platform/internal/tenant"
    "github.com/example/saas-platform/internal/billing"
    "github.com/example/saas-platform/pkg/logger"
)

// AdminTenantRepository extends tenant.Repository with admin-specific queries
type AdminTenantRepository interface {
    tenant.Repository
    Count(ctx context.Context) (int, error)
    CountByStatus(ctx context.Context, status tenant.TenantStatus) (int, error)
    CountCreatedAfter(ctx context.Context, t time.Time) (int, error)
    CountChurnedInPeriod(ctx context.Context, start, end time.Time) (int, error)
    CountUsers(ctx context.Context, tenantID uuid.UUID) (int64, error)
    ListWithFilters(ctx context.Context, filters *TenantFilters, page, pageSize int) ([]*tenant.Tenant, int, error)
}

// AdminSubscriptionRepository extends billing.SubscriptionRepository with admin-specific queries
type AdminSubscriptionRepository interface {
    billing.SubscriptionRepository
    CountByStatus(ctx context.Context, status billing.SubscriptionStatus) (int, error)
    CalculateMRR(ctx context.Context) (int64, error)
}

// Service provides admin dashboard functionality
type Service struct {
    tenantRepo       AdminTenantRepository
    subscriptionRepo AdminSubscriptionRepository
    usageRepo        billing.UsageRepository
    logger           logger.Logger
}

func NewService(
    tenantRepo AdminTenantRepository,
    subscriptionRepo AdminSubscriptionRepository,
    usageRepo billing.UsageRepository,
    logger logger.Logger,
) *Service {
    return &Service{
        tenantRepo:       tenantRepo,
        subscriptionRepo: subscriptionRepo,
        usageRepo:        usageRepo,
        logger:           logger,
    }
}

// GetDashboardStats retrieves platform-wide statistics
func (s *Service) GetDashboardStats(ctx context.Context) (*DashboardStats, error) {
    stats := &DashboardStats{}

    // Total tenants
    total, err := s.tenantRepo.Count(ctx)
    if err != nil {
        return nil, err
    }
    stats.TotalTenants = total

    // Active tenants
    active, err := s.tenantRepo.CountByStatus(ctx, tenant.TenantStatusActive)
    if err != nil {
        return nil, err
    }
    stats.ActiveTenants = active

    // Trial tenants
    trial, err := s.subscriptionRepo.CountByStatus(ctx, billing.SubscriptionStatusTrialing)
    if err != nil {
        return nil, err
    }
    stats.TrialTenants = trial

    // Monthly recurring revenue (MRR)
    mrr, err := s.subscriptionRepo.CalculateMRR(ctx)
    if err != nil {
        return nil, err
    }
    stats.MRR = mrr

    // New tenants this month
    startOfMonth := time.Now().UTC().Truncate(24 * time.Hour)
    startOfMonth = time.Date(startOfMonth.Year(), startOfMonth.Month(), 1, 0, 0, 0, 0, time.UTC)
    newThisMonth, err := s.tenantRepo.CountCreatedAfter(ctx, startOfMonth)
    if err != nil {
        return nil, err
    }
    stats.NewTenantsThisMonth = newThisMonth

    // Churned tenants this month
    churned, err := s.tenantRepo.CountChurnedInPeriod(ctx, startOfMonth, time.Now().UTC())
    if err != nil {
        return nil, err
    }
    stats.ChurnedThisMonth = churned

    return stats, nil
}

// GetTenantList retrieves paginated list of tenants
func (s *Service) GetTenantList(ctx context.Context, filters *TenantFilters, page, pageSize int) (*TenantListResult, error) {
    tenants, total, err := s.tenantRepo.ListWithFilters(ctx, filters, page, pageSize)
    if err != nil {
        return nil, err
    }

    return &TenantListResult{
        Tenants:    tenants,
        Total:      total,
        Page:       page,
        PageSize:   pageSize,
        TotalPages: (total + pageSize - 1) / pageSize,
    }, nil
}

// GetTenantDetails retrieves detailed information about a tenant
func (s *Service) GetTenantDetails(ctx context.Context, tenantID uuid.UUID) (*TenantDetails, error) {
    t, err := s.tenantRepo.GetByID(ctx, tenantID)
    if err != nil {
        return nil, err
    }

    subscription, err := s.subscriptionRepo.GetByTenantID(ctx, tenantID)
    if err != nil {
        s.logger.Error("failed to get subscription", "error", err)
    }

    // Get usage stats
    usageStats, err := s.getUsageStats(ctx, tenantID)
    if err != nil {
        s.logger.Error("failed to get usage stats", "error", err)
    }

    // Get user count
    userCount, err := s.tenantRepo.CountUsers(ctx, tenantID)
    if err != nil {
        s.logger.Error("failed to count users", "error", err)
    }

    return &TenantDetails{
        Tenant:       t,
        Subscription: subscription,
        UsageStats:   usageStats,
        UserCount:    userCount,
    }, nil
}

// SuspendTenant suspends a tenant's access
func (s *Service) SuspendTenant(ctx context.Context, tenantID uuid.UUID, reason string) error {
    if err := s.tenantRepo.UpdateStatus(ctx, tenantID, tenant.TenantStatusSuspended); err != nil {
        return err
    }

    s.logger.Info("tenant suspended", "tenant_id", tenantID, "reason", reason)

    // TODO: Send notification to tenant

    return nil
}

// ReactivateTenant reactivates a suspended tenant
func (s *Service) ReactivateTenant(ctx context.Context, tenantID uuid.UUID) error {
    if err := s.tenantRepo.UpdateStatus(ctx, tenantID, tenant.TenantStatusActive); err != nil {
        return err
    }

    s.logger.Info("tenant reactivated", "tenant_id", tenantID)

    return nil
}

func (s *Service) getUsageStats(ctx context.Context, tenantID uuid.UUID) (map[string]int64, error) {
    now := time.Now().UTC()
    startOfMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)

    return s.usageRepo.GetUsageBreakdown(ctx, tenantID, startOfMonth, now)
}

type DashboardStats struct {
    TotalTenants         int   `json:"total_tenants"`
    ActiveTenants        int   `json:"active_tenants"`
    TrialTenants         int   `json:"trial_tenants"`
    MRR                  int64 `json:"mrr"` // in cents
    NewTenantsThisMonth  int   `json:"new_tenants_this_month"`
    ChurnedThisMonth     int   `json:"churned_this_month"`
}

type TenantFilters struct {
    Status      *tenant.TenantStatus
    PlanID      *uuid.UUID
    CreatedAfter *time.Time
    SearchQuery *string
}

type TenantListResult struct {
    Tenants    []*tenant.Tenant `json:"tenants"`
    Total      int              `json:"total"`
    Page       int              `json:"page"`
    PageSize   int              `json:"page_size"`
    TotalPages int              `json:"total_pages"`
}

type TenantDetails struct {
    Tenant       *tenant.Tenant           `json:"tenant"`
    Subscription *billing.Subscription    `json:"subscription"`
    UsageStats   map[string]int64         `json:"usage_stats"`
    UserCount    int64                    `json:"user_count"`
}
