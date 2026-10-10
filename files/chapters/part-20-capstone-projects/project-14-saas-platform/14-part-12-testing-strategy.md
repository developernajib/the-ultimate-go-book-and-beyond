## Part 12: Testing Strategy

A multi-tenant SaaS platform has complex testing requirements because you need to verify not just that features work, but that tenant isolation holds under all conditions. If a bug lets Tenant A see Tenant B's data, you have a serious security incident. The tests below cover integration testing for tenant provisioning, cross-tenant isolation verification, billing workflow validation, and load testing. Each test sets up isolated tenant contexts and verifies that operations are correctly scoped to the right tenant.

```go
// tests/integration/tenant_test.go
package integration

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "github.com/yourorg/tenantflow/internal/tenant"
)

func TestTenantProvisioning(t *testing.T) {
    // Setup test database
    db := setupTestDB(t)
    defer teardownTestDB(t, db)

    tenantRepo := tenant.NewRepository(db)
    provisioner := tenant.NewProvisioner(tenantRepo, db, nil, testLogger())

    ctx := context.Background()

    req := &tenant.ProvisionRequest{
        Name:              "Test Company",
        Subdomain:         "testco",
        OwnerEmail:        "owner@testco.com",
        OwnerFirstName:    "John",
        OwnerLastName:     "Doe",
        PlanID:            createTestPlan(t, db),
        IsolationStrategy: tenant.IsolationSharedSchema,
        TrialDays:         14,
    }

    result, err := provisioner.Provision(ctx, req)
    require.NoError(t, err)
    require.NotNil(t, result)

    // Verify tenant created
    assert.Equal(t, "Test Company", result.Tenant.Name)
    assert.Equal(t, "testco", result.Tenant.Subdomain)
    assert.Equal(t, tenant.TenantStatusProvisioning, result.Tenant.Status)

    // Verify owner user created
    assert.Equal(t, "owner@testco.com", result.OwnerUser.Email)
    assert.Equal(t, auth.RoleOwner, result.OwnerUser.Role)

    // Verify subscription created
    assert.Equal(t, billing.SubscriptionStatusTrialing, result.Subscription.Status)
    assert.NotNil(t, result.Subscription.TrialEnd)
}

func TestTenantIsolation(t *testing.T) {
    db := setupTestDB(t)
    defer teardownTestDB(t, db)

    // Create two tenants
    tenant1 := createTestTenant(t, db, "tenant1")
    tenant2 := createTestTenant(t, db, "tenant2")

    // Create users for each tenant
    user1 := createTestUser(t, db, tenant1.ID, "user1@tenant1.com")
    user2 := createTestUser(t, db, tenant2.ID, "user2@tenant2.com")

    userRepo := auth.NewUserRepository(db)

    // Tenant 1 should only see their users
    ctx1 := isolation.WithTenant(context.Background(), &isolation.TenantContext{
        TenantID: tenant1.ID,
    })

    users, err := userRepo.ListByTenant(ctx1, tenant1.ID)
    require.NoError(t, err)
    assert.Len(t, users, 1)
    assert.Equal(t, user1.Email, users[0].Email)

    // Tenant 2 should only see their users
    ctx2 := isolation.WithTenant(context.Background(), &isolation.TenantContext{
        TenantID: tenant2.ID,
    })

    users, err = userRepo.ListByTenant(ctx2, tenant2.ID)
    require.NoError(t, err)
    assert.Len(t, users, 1)
    assert.Equal(t, user2.Email, users[0].Email)
}

func TestQuotaEnforcement(t *testing.T) {
    db := setupTestDB(t)
    defer teardownTestDB(t, db)

    tenant := createTestTenant(t, db, "test-tenant")
    plan := createTestPlanWithLimits(t, db, &tenant.PlanLimits{
        MaxUsers: 5,
    })

    // Update tenant plan
    updateTenantPlan(t, db, tenant.ID, plan.ID)

    enforcer := quota.NewEnforcer(
        tenant.NewRepository(db),
        billing.NewUsageTracker(nil, nil, nil),
        cache.NewMemoryCache(),
        testLogger(),
    )

    ctx := isolation.WithTenant(context.Background(), &isolation.TenantContext{
        TenantID: tenant.ID,
    })

    // Create 5 users (should succeed)
    for i := 0; i < 5; i++ {
        err := enforcer.CheckQuota(ctx, "users", 1)
        require.NoError(t, err)
        createTestUser(t, db, tenant.ID, fmt.Sprintf("user%d@test.com", i))
    }

    // Attempt to create 6th user (should fail)
    err := enforcer.CheckQuota(ctx, "users", 1)
    assert.Error(t, err)
    assert.ErrorIs(t, err, quota.ErrQuotaExceeded)
}

// Load tests
func TestLoadTenantConcurrency(t *testing.T) {
    if testing.Short() {
        t.Skip("skipping load test in short mode")
    }

    db := setupTestDB(t)
    defer teardownTestDB(t, db)

    tenantRepo := tenant.NewRepository(db)
    provisioner := tenant.NewProvisioner(tenantRepo, db, nil, testLogger())

    numTenants := 100
    results := make(chan error, numTenants)

    // Provision 100 tenants concurrently
    for i := 0; i < numTenants; i++ {
        go func(i int) {
            req := &tenant.ProvisionRequest{
                Name:              fmt.Sprintf("Tenant %d", i),
                Subdomain:         fmt.Sprintf("tenant%d", i),
                OwnerEmail:        fmt.Sprintf("owner%d@test.com", i),
                OwnerFirstName:    "Owner",
                OwnerLastName:     fmt.Sprintf("%d", i),
                PlanID:            createTestPlan(t, db),
                IsolationStrategy: tenant.IsolationSharedSchema,
            }

            _, err := provisioner.Provision(context.Background(), req)
            results <- err
        }(i)
    }

    // Collect results
    var errors []error
    for i := 0; i < numTenants; i++ {
        if err := <-results; err != nil {
            errors = append(errors, err)
        }
    }

    // All provisions should succeed
    assert.Empty(t, errors, "Expected no provisioning errors")

    // Verify all tenants were created
    count, err := tenantRepo.Count(context.Background())
    require.NoError(t, err)
    assert.Equal(t, numTenants, count)
}
```
