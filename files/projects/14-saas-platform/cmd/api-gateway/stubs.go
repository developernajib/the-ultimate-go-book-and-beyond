// cmd/api-gateway/stubs.go
// Stub implementations and initialization helpers for the API gateway.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
	"github.com/example/saas-platform/internal/auth"
	"github.com/example/saas-platform/internal/billing"
	"github.com/example/saas-platform/pkg/cache"
)

// initDatabase initializes the database connection.
func initDatabase() *sqlx.DB {
	// TODO: read DSN from environment and connect
	return &sqlx.DB{}
}

// initCache initializes the cache client.
func initCache() cache.Cache {
	return &cache.NoOpCache{}
}

// package-level stubs that main.go references without declaring.

// usageRepo provides a billing.UsageRepository to main.
var usageRepo billing.UsageRepository = &sqlUsageRepo{}

// sessionRepo provides an auth.SessionRepository to main.
var sessionRepo auth.SessionRepository = &sqlAuthSession{}

// sqlUsageRepo is a minimal stub implementing billing.UsageRepository.
type sqlUsageRepo struct{}

func (r *sqlUsageRepo) Create(ctx context.Context, rec *billing.UsageRecord) error {
	return fmt.Errorf("not implemented")
}
func (r *sqlUsageRepo) GetByTenantAndMetric(ctx context.Context, tenantID uuid.UUID, metric string) ([]*billing.UsageRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (r *sqlUsageRepo) GetByTenantAndPeriod(ctx context.Context, tenantID uuid.UUID, start, end time.Time) ([]*billing.UsageRecord, error) {
	return nil, fmt.Errorf("not implemented")
}
func (r *sqlUsageRepo) SumByTenantAndMetric(ctx context.Context, tenantID uuid.UUID, metric string) (int64, error) {
	return 0, fmt.Errorf("not implemented")
}
func (r *sqlUsageRepo) GetTotalUsage(ctx context.Context, tenantID uuid.UUID, metric string, start, end time.Time) (int64, error) {
	return 0, fmt.Errorf("not implemented")
}
func (r *sqlUsageRepo) GetUsageBreakdown(ctx context.Context, tenantID uuid.UUID, start, end time.Time) (map[string]int64, error) {
	return nil, fmt.Errorf("not implemented")
}

// sqlAuthSession is a minimal stub implementing auth.SessionRepository.
type sqlAuthSession struct{}

func (r *sqlAuthSession) Create(ctx context.Context, s *auth.Session) error {
	return fmt.Errorf("not implemented")
}
func (r *sqlAuthSession) GetByID(ctx context.Context, id uuid.UUID) (*auth.Session, error) {
	return nil, fmt.Errorf("not implemented")
}
func (r *sqlAuthSession) Delete(ctx context.Context, id uuid.UUID) error {
	return fmt.Errorf("not implemented")
}
func (r *sqlAuthSession) DeleteByUserID(ctx context.Context, userID uuid.UUID) error {
	return fmt.Errorf("not implemented")
}

// --- Middleware stubs ---

func requireAdminMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
	})
}

// writeJSON writes a JSON response (used by handlers).
func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// --- Route handler stubs ---

func registerHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func loginHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func forgotPasswordHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func resetPasswordHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func getCurrentUserHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func updateCurrentUserHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func getTenantHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func updateTenantHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func getQuotasHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func getSubscriptionHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func createSubscriptionHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func updateSubscriptionHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func cancelSubscriptionHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func listInvoicesHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func getUsageHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func getBrandingHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func updateBrandingHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func uploadLogoHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func setupCustomDomainHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func adminDashboardHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func listTenantsHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func getTenantDetailsHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func suspendTenantHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

func reactivateTenantHandler(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}
