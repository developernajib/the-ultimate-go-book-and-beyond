// internal/quota/enforcer.go
package quota

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/example/saas-platform/internal/billing"
	"github.com/example/saas-platform/internal/isolation"
	"github.com/example/saas-platform/internal/tenant"
	"github.com/example/saas-platform/pkg/cache"
	"github.com/example/saas-platform/pkg/logger"
	"github.com/google/uuid"
)

var (
	ErrQuotaExceeded = fmt.Errorf("quota exceeded")
)

// Enforcer enforces resource quotas
type Enforcer struct {
	tenantRepo   tenant.Repository
	usageTracker *billing.UsageTracker
	cache        cache.Cache
	logger       logger.Logger
}

func NewEnforcer(
	tenantRepo tenant.Repository,
	usageTracker *billing.UsageTracker,
	cache cache.Cache,
	logger logger.Logger,
) *Enforcer {
	return &Enforcer{
		tenantRepo:   tenantRepo,
		usageTracker: usageTracker,
		cache:        cache,
		logger:       logger,
	}
}

// CheckQuota verifies if a tenant can perform an action based on quotas
func (e *Enforcer) CheckQuota(ctx context.Context, resource string, requested int64) error {
	tenantID, err := isolation.TenantID(ctx)
	if err != nil {
		return err
	}

	// Get tenant's plan limits
	limits, err := e.getPlanLimits(ctx, tenantID)
	if err != nil {
		return err
	}

	// Get current usage
	usage, err := e.getCurrentUsage(ctx, tenantID, resource)
	if err != nil {
		return err
	}

	// Check if quota would be exceeded
	limit := e.getLimitForResource(limits, resource)
	if limit > 0 && (usage+requested) > limit {
		return fmt.Errorf("%w: %s (limit: %d, current: %d, requested: %d)",
			ErrQuotaExceeded, resource, limit, usage, requested)
	}

	return nil
}

// EnforceQuota checks quota and returns an error if exceeded
func (e *Enforcer) EnforceQuota(ctx context.Context, resource string, requested int64) error {
	return e.CheckQuota(ctx, resource, requested)
}

// GetQuotaStatus returns quota status for a resource
func (e *Enforcer) GetQuotaStatus(ctx context.Context, resource string) (*QuotaStatus, error) {
	tenantID, err := isolation.TenantID(ctx)
	if err != nil {
		return nil, err
	}

	limits, err := e.getPlanLimits(ctx, tenantID)
	if err != nil {
		return nil, err
	}

	usage, err := e.getCurrentUsage(ctx, tenantID, resource)
	if err != nil {
		return nil, err
	}

	limit := e.getLimitForResource(limits, resource)
	remaining := max(limit-usage, 0)

	percentUsed := float64(0)
	if limit > 0 {
		percentUsed = float64(usage) / float64(limit) * 100
	}

	return &QuotaStatus{
		Resource:    resource,
		Limit:       limit,
		Used:        usage,
		Remaining:   remaining,
		PercentUsed: percentUsed,
		IsExceeded:  usage >= limit && limit > 0,
	}, nil
}

// GetAllQuotaStatus returns quota status for all resources
func (e *Enforcer) GetAllQuotaStatus(ctx context.Context) (map[string]*QuotaStatus, error) {
	tenantID, err := isolation.TenantID(ctx)
	if err != nil {
		return nil, err
	}

	if _, err := e.getPlanLimits(ctx, tenantID); err != nil {
		return nil, err
	}

	resources := []string{
		"users",
		"projects",
		"storage_gb",
		"api_calls_monthly",
		"custom_domains",
		"team_members",
		"integrations",
	}

	statuses := make(map[string]*QuotaStatus)
	for _, resource := range resources {
		status, err := e.GetQuotaStatus(ctx, resource)
		if err != nil {
			e.logger.Error("failed to get quota status", "resource", resource, "error", err)
			continue
		}
		statuses[resource] = status
	}

	return statuses, nil
}

func (e *Enforcer) getPlanLimits(ctx context.Context, tenantID uuid.UUID) (*tenant.PlanLimits, error) {
	// Get from database
	t, err := e.tenantRepo.GetByID(ctx, tenantID)
	if err != nil {
		return nil, err
	}

	plan, err := e.tenantRepo.GetPlanByID(ctx, t.PlanID)
	if err != nil {
		return nil, err
	}

	// Cache key (fire-and-forget; cache returns string so we skip structured caching here)
	cacheKey := fmt.Sprintf("plan:limits:%s", tenantID)
	_ = e.cache.Set(ctx, cacheKey, plan.Limits, time.Hour)

	return &plan.Limits, nil
}

func (e *Enforcer) getCurrentUsage(ctx context.Context, tenantID uuid.UUID, resource string) (int64, error) {
	switch resource {
	case "users":
		return e.tenantRepo.CountUsers(ctx, tenantID)
	case "projects":
		return e.tenantRepo.CountProjects(ctx, tenantID)
	case "storage_gb":
		bytes, err := e.tenantRepo.GetStorageUsage(ctx, tenantID)
		if err != nil {
			return 0, err
		}
		return bytes / (1024 * 1024 * 1024), nil // Convert to GB
	case "api_calls_monthly":
		return e.usageTracker.GetCurrentMonthUsage(ctx, tenantID, "api_calls")
	case "custom_domains":
		return e.tenantRepo.CountCustomDomains(ctx, tenantID)
	default:
		return 0, nil
	}
}

func (e *Enforcer) getLimitForResource(limits *tenant.PlanLimits, resource string) int64 {
	switch resource {
	case "users":
		return int64(limits.MaxUsers)
	case "projects":
		return int64(limits.MaxProjects)
	case "storage_gb":
		return int64(limits.MaxStorageGB)
	case "api_calls_monthly":
		return limits.MaxAPICallsPerMonth
	case "custom_domains":
		return int64(limits.MaxCustomDomains)
	case "team_members":
		return int64(limits.MaxTeamMembers)
	case "integrations":
		return int64(limits.MaxIntegrations)
	default:
		return 0
	}
}

type QuotaStatus struct {
	Resource    string  `json:"resource"`
	Limit       int64   `json:"limit"`
	Used        int64   `json:"used"`
	Remaining   int64   `json:"remaining"`
	PercentUsed float64 `json:"percent_used"`
	IsExceeded  bool    `json:"is_exceeded"`
}

// QuotaMiddleware enforces quotas on API requests
type QuotaMiddleware struct {
	enforcer *Enforcer
	logger   logger.Logger
}

func NewQuotaMiddleware(enforcer *Enforcer, logger logger.Logger) *QuotaMiddleware {
	return &QuotaMiddleware{
		enforcer: enforcer,
		logger:   logger,
	}
}

func (m *QuotaMiddleware) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Check API calls quota
		if err := m.enforcer.CheckQuota(r.Context(), "api_calls_monthly", 1); err != nil {
			if errors.Is(err, ErrQuotaExceeded) {
				http.Error(w, "API quota exceeded", http.StatusTooManyRequests)
				return
			}
			m.logger.Error("failed to check quota", "error", err)
		}

		next.ServeHTTP(w, r)
	})
}
