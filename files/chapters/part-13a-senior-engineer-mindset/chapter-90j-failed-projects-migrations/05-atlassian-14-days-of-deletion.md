## 90J.4 Atlassian: 14 Days of Deletion (2022)

### The Incident

In April 2022, Atlassian accidentally deleted the sites of approximately 400 customers using Jira, Confluence,
and other Atlassian cloud products. The deletion was not discovered for hours, and full restoration took 14 days.
For two weeks, hundreds of companies had no access to their project management, documentation, or development
tools.

### The Timeline

**Background: The Maintenance Script**

Atlassian needed to deactivate a legacy standalone app called Insight - Asset Management. The deactivation
required running a script that would remove the app from customer sites. The script needed the IDs of the
Insight app instances to deactivate. Instead, the script was provided with the site IDs - the IDs of the
entire customer sites, not the IDs of the app instances within those sites.

**The Critical Bug: ID Confusion**

The deletion script accepted an ID parameter. It did not validate whether the ID was an app ID or a site ID.
Both were represented as plain strings (UUIDs), and the API endpoint that performed the deletion would happily
delete whatever entity the ID referred to. When the script was given site IDs, it deleted the entire customer
sites - all their Jira projects, Confluence spaces, Opsgenie configurations, and Statuspage instances.

**April 5, 2022: The Deletion**

The script ran and deleted approximately 400 customer sites. Because the deletion was performed through the
standard provisioning API, it followed the normal site deletion workflow, including queuing data for permanent
removal.

**Hours Later: Discovery**

Atlassian discovered the error when affected customers began reporting they could not access their sites. The
initial investigation revealed that the sites had been marked as deleted.

**April 5-18, 2022: The 14-Day Recovery**

The recovery was extraordinarily slow for several reasons:

1. **No self-service restore**: Atlassian had no automated process to restore a deleted site. Each site had to
   be rebuilt manually.
2. **Multiple products per site**: Each site contained data for multiple products (Jira, Confluence, Opsgenie,
   Statuspage), each with its own data stores and restore procedures.
3. **Restoration order matters**: Products had to be restored in a specific order due to cross-product
   dependencies.
4. **Manual process**: Each site required approximately 30 manual steps to restore. With 400 sites, this meant
   roughly 12,000 manual operations.
5. **No parallel restoration**: The restore process could not be safely parallelized without risking data
   corruption.

### Root Cause Analysis

1. **Type confusion**: Site IDs and app IDs were both plain strings, and the API did not validate which type
   of ID it received
2. **No soft delete**: The deletion was immediate and permanent, with no grace period
3. **No dry-run capability**: The script could not preview what it would delete before executing
4. **No self-service restore**: The restoration process was entirely manual
5. **Insufficient testing**: The script was not tested against a staging environment with realistic data

### Go Code: Type-Safe Deletion System

The Atlassian disaster was fundamentally a type safety problem. Go's type system can prevent this entire
category of bugs. Here is a system that makes it impossible to confuse different types of identifiers:

```go
package typesafe

import (
	"context"
	"fmt"
	"time"
)

// -----------------------------------------------------------------------
// Type-safe identifiers that prevent confusion between different
// entity types. This is the core pattern that would have prevented
// the Atlassian disaster.
// -----------------------------------------------------------------------

// SiteID uniquely identifies a customer site. It is a distinct type
// from AppID, making it impossible to pass one where the other is
// expected without an explicit (and reviewable) conversion.
type SiteID struct {
	value string
}

// AppID uniquely identifies an app instance within a site.
type AppID struct {
	value string
}

// UserID uniquely identifies a user.
type UserID struct {
	value string
}

// WorkspaceID uniquely identifies a workspace within a site.
type WorkspaceID struct {
	value string
}

// NewSiteID creates a validated SiteID.
func NewSiteID(raw string) (SiteID, error) {
	if raw == "" {
		return SiteID{}, fmt.Errorf("site ID cannot be empty")
	}
	// In production, validate UUID format, prefix, etc.
	return SiteID{value: raw}, nil
}

// NewAppID creates a validated AppID.
func NewAppID(raw string) (AppID, error) {
	if raw == "" {
		return AppID{}, fmt.Errorf("app ID cannot be empty")
	}
	return AppID{value: raw}, nil
}

// String returns the string representation. Methods are defined on
// each type independently - there is no shared interface that would
// allow them to be used interchangeably.
func (id SiteID) String() string { return id.value }
func (id AppID) String() string  { return id.value }
func (id UserID) String() string { return id.value }

// -----------------------------------------------------------------------
// Deletion service with type-safe operations
// -----------------------------------------------------------------------

// DeletionRequest captures the intent to delete an entity, including
// who requested it and why.
type DeletionRequest struct {
	RequestedBy UserID
	Reason      string
	DryRun      bool
	RequestedAt time.Time
}

// DeletionPreview shows what would be affected by a deletion without
// actually performing it.
type DeletionPreview struct {
	EntityType    string
	EntityID      string
	AffectedUsers int
	AffectedData  map[string]int // e.g., {"jira_projects": 15, "confluence_spaces": 8}
	Warnings      []string
}

// DeletionResult captures the outcome of a deletion operation.
type DeletionResult struct {
	EntityID     string
	Deleted      bool
	SoftDeleted  bool
	RecoverableUntil time.Time
	AuditLogID   string
}

// SiteManager handles site lifecycle operations with full type safety.
type SiteManager struct {
	siteStore  SiteStore
	appStore   AppStore
	auditLog   AuditLogger
	gracePeriod time.Duration
}

// SiteStore is the data access interface for sites.
type SiteStore interface {
	GetSite(ctx context.Context, id SiteID) (*Site, error)
	SoftDeleteSite(ctx context.Context, id SiteID, deletedBy UserID) error
	RestoreSite(ctx context.Context, id SiteID) error
	PermanentlyDeleteSite(ctx context.Context, id SiteID) error
}

// AppStore is the data access interface for apps.
type AppStore interface {
	GetApp(ctx context.Context, id AppID) (*App, error)
	DeactivateApp(ctx context.Context, id AppID) error
	ListAppsForSite(ctx context.Context, siteID SiteID) ([]App, error)
}

// AuditLogger records all deletion operations for compliance and
// forensics.
type AuditLogger interface {
	LogDeletion(ctx context.Context, entry AuditEntry) (string, error)
}

// AuditEntry captures the full context of a deletion operation.
type AuditEntry struct {
	Action      string
	EntityType  string
	EntityID    string
	PerformedBy string
	Reason      string
	Timestamp   time.Time
	DryRun      bool
	Result      string
}

// Site represents a customer site.
type Site struct {
	ID        SiteID
	Name      string
	OwnerID   UserID
	CreatedAt time.Time
	Status    string
}

// App represents an app instance.
type App struct {
	ID     AppID
	SiteID SiteID
	Name   string
	Status string
}

// NewSiteManager creates a new SiteManager with the given dependencies.
func NewSiteManager(
	siteStore SiteStore,
	appStore AppStore,
	auditLog AuditLogger,
	gracePeriod time.Duration,
) *SiteManager {
	return &SiteManager{
		siteStore:   siteStore,
		appStore:    appStore,
		auditLog:    auditLog,
		gracePeriod: gracePeriod,
	}
}

// DeactivateApp deactivates an app instance. Note: this function
// accepts an AppID, NOT a SiteID. The Go compiler will reject any
// attempt to pass a SiteID here - this is the key safety mechanism.
func (sm *SiteManager) DeactivateApp(
	ctx context.Context,
	appID AppID, // <-- Type safety: cannot pass a SiteID here
	req DeletionRequest,
) (*DeletionResult, error) {
	// Verify the app exists.
	app, err := sm.appStore.GetApp(ctx, appID)
	if err != nil {
		return nil, fmt.Errorf("app %s not found: %w", appID, err)
	}

	// Log the operation.
	auditID, err := sm.auditLog.LogDeletion(ctx, AuditEntry{
		Action:      "deactivate_app",
		EntityType:  "app",
		EntityID:    appID.String(),
		PerformedBy: req.RequestedBy.String(),
		Reason:      req.Reason,
		Timestamp:   time.Now(),
		DryRun:      req.DryRun,
	})
	if err != nil {
		return nil, fmt.Errorf("audit logging failed: %w", err)
	}

	if req.DryRun {
		return &DeletionResult{
			EntityID:    appID.String(),
			Deleted:     false,
			AuditLogID:  auditID,
		}, nil
	}

	// Perform the deactivation.
	if err := sm.appStore.DeactivateApp(ctx, appID); err != nil {
		return nil, fmt.Errorf("deactivating app %s: %w", appID, err)
	}

	fmt.Printf("[SITE MANAGER] Deactivated app %s (name: %s) - audit: %s\n",
		appID, app.Name, auditID)

	return &DeletionResult{
		EntityID:   appID.String(),
		Deleted:    true,
		AuditLogID: auditID,
	}, nil
}

// DeleteSite soft-deletes a customer site with a grace period.
// This is a separate function from DeactivateApp, accepting a SiteID.
// The type system makes it impossible to accidentally call this when
// you meant to deactivate an app.
func (sm *SiteManager) DeleteSite(
	ctx context.Context,
	siteID SiteID, // <-- Type safety: cannot pass an AppID here
	req DeletionRequest,
) (*DeletionResult, error) {
	// Verify the site exists.
	site, err := sm.siteStore.GetSite(ctx, siteID)
	if err != nil {
		return nil, fmt.Errorf("site %s not found: %w", siteID, err)
	}

	// Preview impact.
	apps, err := sm.appStore.ListAppsForSite(ctx, siteID)
	if err != nil {
		return nil, fmt.Errorf("listing apps for site %s: %w", siteID, err)
	}

	fmt.Printf("[SITE MANAGER] WARNING: Deleting site %s (%s) will affect %d apps\n",
		siteID, site.Name, len(apps))

	// Audit log.
	auditID, err := sm.auditLog.LogDeletion(ctx, AuditEntry{
		Action:      "soft_delete_site",
		EntityType:  "site",
		EntityID:    siteID.String(),
		PerformedBy: req.RequestedBy.String(),
		Reason:      req.Reason,
		Timestamp:   time.Now(),
		DryRun:      req.DryRun,
	})
	if err != nil {
		return nil, fmt.Errorf("audit logging failed: %w", err)
	}

	if req.DryRun {
		return &DeletionResult{
			EntityID:    siteID.String(),
			Deleted:     false,
			AuditLogID:  auditID,
		}, nil
	}

	// Soft delete with grace period.
	if err := sm.siteStore.SoftDeleteSite(ctx, siteID, req.RequestedBy); err != nil {
		return nil, fmt.Errorf("soft-deleting site %s: %w", siteID, err)
	}

	recoverableUntil := time.Now().Add(sm.gracePeriod)

	return &DeletionResult{
		EntityID:         siteID.String(),
		Deleted:          true,
		SoftDeleted:      true,
		RecoverableUntil: recoverableUntil,
		AuditLogID:       auditID,
	}, nil
}

// RestoreSite restores a soft-deleted site within the grace period.
func (sm *SiteManager) RestoreSite(
	ctx context.Context,
	siteID SiteID,
	requestedBy UserID,
) error {
	_, err := sm.auditLog.LogDeletion(ctx, AuditEntry{
		Action:      "restore_site",
		EntityType:  "site",
		EntityID:    siteID.String(),
		PerformedBy: requestedBy.String(),
		Reason:      "restoring soft-deleted site",
		Timestamp:   time.Now(),
	})
	if err != nil {
		return fmt.Errorf("audit logging failed: %w", err)
	}

	return sm.siteStore.RestoreSite(ctx, siteID)
}

// -----------------------------------------------------------------------
// Batch operation safety: prevents mass deletion accidents
// -----------------------------------------------------------------------

// BatchDeactivator safely deactivates multiple apps with confirmation
// gates and progress tracking.
type BatchDeactivator struct {
	manager        *SiteManager
	maxBatchSize   int
	confirmationFn func(preview []DeletionPreview) bool
}

// NewBatchDeactivator creates a batch deactivator with safety limits.
func NewBatchDeactivator(manager *SiteManager, maxBatchSize int) *BatchDeactivator {
	return &BatchDeactivator{
		manager:      manager,
		maxBatchSize: maxBatchSize,
	}
}

// DeactivateApps deactivates a batch of apps with safety checks.
func (bd *BatchDeactivator) DeactivateApps(
	ctx context.Context,
	appIDs []AppID, // <-- ONLY accepts AppIDs, never SiteIDs
	req DeletionRequest,
) ([]DeletionResult, error) {
	if len(appIDs) > bd.maxBatchSize {
		return nil, fmt.Errorf(
			"batch size %d exceeds maximum %d - split into smaller batches",
			len(appIDs), bd.maxBatchSize)
	}

	// First pass: dry run to preview impact.
	fmt.Printf("[BATCH] Previewing deactivation of %d apps...\n", len(appIDs))
	req.DryRun = true
	for _, id := range appIDs {
		_, err := bd.manager.DeactivateApp(ctx, id, req)
		if err != nil {
			return nil, fmt.Errorf("dry run failed for app %s: %w", id, err)
		}
	}

	// Second pass: actual deactivation.
	fmt.Printf("[BATCH] Proceeding with deactivation of %d apps...\n", len(appIDs))
	req.DryRun = false
	var results []DeletionResult
	for i, id := range appIDs {
		result, err := bd.manager.DeactivateApp(ctx, id, req)
		if err != nil {
			return results, fmt.Errorf(
				"failed at app %d/%d (%s): %w - %d apps already deactivated",
				i+1, len(appIDs), id, err, len(results))
		}
		results = append(results, *result)

		if (i+1)%100 == 0 {
			fmt.Printf("[BATCH] Progress: %d/%d apps deactivated\n", i+1, len(appIDs))
		}
	}

	return results, nil
}
```

### Engineering Lessons

1. **Use the type system as a safety net** - distinct types for distinct concepts prevent entire classes of bugs.
2. **Always implement soft delete with grace periods** - permanent deletion should require a waiting period.
3. **Dry-run first** - every destructive operation should support a preview mode.
4. **Batch operations need size limits** - no script should be able to delete 400 sites in one run.
5. **Build self-service restore** - if deletion takes seconds, restoration should not take days.
6. **Audit every destructive operation** - you need to know who deleted what and when.

---

### Junior → FAANG: Type Safety and Destructive Operation Safeguards as Interview Topics

The Atlassian incident is the interview answer to "how do you prevent identifier confusion bugs?" A script that confused site IDs with app IDs deleted 400 production sites. Go's type system could have prevented this: define distinct named types (`type SiteID string` and `type AppID string`) so the compiler rejects any function that receives a `SiteID` where an `AppID` is expected. This is the phantom type pattern applied to infrastructure automation. For any function that performs a destructive operation, the type signature should make it structurally impossible to pass the wrong class of identifier. The second interview point is the dry-run requirement: every destructive operation must support a `--dry-run` flag that lists what would be deleted without deleting anything. Running a dry-run before every deletion and comparing the output against the expected scope is the practice that would have caught the identifier confusion before it executed.

### Senior @ FAANG: Destructive Operation Governance as a Platform Safety Standard

At L6, the Atlassian incident reveals the absence of a platform-level policy governing destructive operations. Four specific controls should be platform standards, not individual-team discretion. First, destructive operations must require a separate confirmation token that is generated by a dry-run and passed back to the real run, proving that the operator reviewed the dry-run output before executing. Second, batch deletions must have a configurable size limit enforced by the platform, not by individual scripts. The platform should reject any deletion batch larger than a configured threshold (for example, 10 sites) without an explicit override approval from a second engineer. Third, all site or account deletions must enter a soft-delete queue with a configurable grace period (minimum 72 hours for internal operations, 30 days for customer-facing deletions) before permanent removal, and that queue must be visible and reversible by a separate team from the one that initiated the deletion. Fourth, restoration must be a self-service, time-bounded operation that takes minutes, not a 14-day manual process. The restoration SLA is the test of whether your deletion governance is actually safe: if restoring a deleted site takes two weeks, your deletion operations are high-risk regardless of how many safeguards surround them. At staff level, establish the platform-level policy and verify that every team's tooling complies with it before any new deletion tooling is deployed to production.

---
