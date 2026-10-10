## 90G.18 Atlassian 14-Day Deletion (April 2022) - When You Delete Your Customers

*"A maintenance script intended to deactivate a legacy app accidentally used site IDs instead of app IDs,
permanently deleting 883 sites across 775 customers using Jira, Confluence, and Trello. Recovery took 14 days."*
 -  Atlassian Incident Report

### The Incident

In April 2022, Atlassian executed what became one of the most notorious cloud computing incidents in history.
A maintenance script designed to deactivate instances of a legacy Atlassian application was run with the wrong
parameter type. Instead of passing **application instance IDs** (which would deactivate the app), the script
received **site IDs** (which identified entire customer tenants). The script dutifully processed each ID and
**permanently deleted 775 customer sites** - wiping out their Jira projects, Confluence spaces, Trello boards,
Opsgenie configurations, and all associated data.

The deletion was not detected immediately. Customers began reporting that their sites were inaccessible, and
Atlassian initially treated these as routine support tickets. It took hours for the pattern to emerge: hundreds
of customers had simultaneously lost access to all Atlassian products.

Recovery took **14 full days**. Not because Atlassian lacked backups - they had backups - but because their
restoration process was designed for individual site recovery, not bulk restoration of 775 sites simultaneously.
Each site required manual coordination, data verification, and service reconnection. The restoration pipeline
was a bottleneck that could not be parallelized beyond a certain point due to database constraints.

### Timeline Reconstruction

The timeline reveals two compounding failures: the deletion itself executed in under two minutes and was irreversible, yet detection lagged by over three hours because incoming support tickets were triaged individually rather than correlated by pattern. The 14-day recovery was not a data problem (backups existed) but a throughput problem. The restoration pipeline was optimized for single-site recovery and could not be horizontally scaled beyond a database-imposed concurrency limit.

```
April 5, 07:30 UTC    Maintenance script executed with site IDs instead of app IDs
April 5, 07:31 UTC    Script begins deleting customer sites (775 total)
April 5, 07:45 UTC    First customer support tickets arrive: "site unavailable"
April 5, 09:00 UTC    Support team identifies pattern - multiple customers affected
April 5, 10:00 UTC    Engineering escalation - script execution log reviewed
April 5, 11:00 UTC    ROOT CAUSE IDENTIFIED: wrong ID type passed to deletion script
April 5, 12:00 UTC    All 775 affected customers identified
April 5, 14:00 UTC    Restoration process begins (individual site recovery)
April 5-8             ~50 sites restored per day (pipeline bottleneck)
April 8-12            Restoration pipeline optimized, rate increases to ~100/day
April 12-18           Remaining sites restored with data verification
April 18              Last customer site restored - 14 DAYS after deletion
```

### Architecture Diagram: How Type Confusion Caused Mass Deletion

Both ID types were represented as plain `string` in Go, so the function signature `deactivate_legacy_app(ids []string)` accepted either kind without complaint. The compiler had no information to distinguish a site-scoped delete from an app-scoped deactivation. The error was invisible until the database began cascading deletions. This is the canonical case for Go's nominal type system: wrapping primitives in distinct named types costs nothing at runtime but makes the wrong call a compile-time error instead of a production incident.

```
┌────────────────────────────────────────────────────────────────────────┐
│                   THE ATLASSIAN TYPE CONFUSION                         │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Maintenance Script:  deactivate_legacy_app(ids []string)              │
│                                                                        │
│  INTENDED:                          ACTUAL:                            │
│  ┌──────────────────────┐          ┌──────────────────────┐            │
│  │  App Instance IDs    │           │  Site IDs (tenant)    │          │
│  │  "app-12345"         │           │  "site-12345"         │          │
│  │  "app-12346"         │           │  "site-12346"         │          │
│  │  "app-12347"         │           │  "site-12347"         │          │
│  │                      │            │                        │        │
│  │  Action: Deactivate  │           │  Action: DELETE ALL   │          │
│  │  a single app on     │           │  customer data for    │          │
│  │  the site            │           │  the entire site      │          │
│  └──────────────────────┘          └──────────────────────┘            │
│           │                                  │                         │
│           ▼                                  ▼                         │
│  ┌──────────────┐                  ┌──────────────────────┐            │
│  │  App disabled│                    │  775 CUSTOMER SITES   │         │
│  │  (reversible)│                    │  PERMANENTLY DELETED  │         │
│  └──────────────┘                  │  Jira + Confluence +  │           │
│                                     │  Trello + Opsgenie    │          │
│                                     │  ALL GONE             │          │
│                                     └──────────────────────┘           │
│                                                                        │
│  ROOT CAUSE: Both ID types were plain strings. No type safety.         │
│  The function accepted []string - it could not distinguish             │
│  between app IDs and site IDs at the type level.                       │
└────────────────────────────────────────────────────────────────────────┘
```

### Go Implementation: Type-Safe Identifiers

The fundamental defense against the Atlassian incident is **type-safe identifiers** - making it impossible at
the compiler level to pass a site ID where an app ID is expected.

```go
package safeid

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// SiteID is a distinct type representing a customer tenant.
// It CANNOT be accidentally used where an AppInstanceID is expected.
type SiteID struct {
	value string
}

// AppInstanceID is a distinct type representing an app installation.
type AppInstanceID struct {
	value string
}

// UserID is a distinct type for user identifiers.
type UserID struct {
	value string
}

// NewSiteID creates a validated SiteID.
func NewSiteID(raw string) (SiteID, error) {
	if !strings.HasPrefix(raw, "site-") {
		return SiteID{}, fmt.Errorf("invalid site ID format: must start with 'site-', got %q", raw)
	}
	if len(raw) < 10 {
		return SiteID{}, fmt.Errorf("site ID too short: %q", raw)
	}
	return SiteID{value: raw}, nil
}

// NewAppInstanceID creates a validated AppInstanceID.
func NewAppInstanceID(raw string) (AppInstanceID, error) {
	if !strings.HasPrefix(raw, "app-") {
		return AppInstanceID{}, fmt.Errorf("invalid app instance ID format: must start with 'app-', got %q", raw)
	}
	if len(raw) < 8 {
		return AppInstanceID{}, fmt.Errorf("app instance ID too short: %q", raw)
	}
	return AppInstanceID{value: raw}, nil
}

// String returns the string representation.
func (s SiteID) String() string        { return s.value }
func (a AppInstanceID) String() string { return a.value }
func (u UserID) String() string        { return u.value }

// GenerateSiteID creates a new random SiteID.
func GenerateSiteID() SiteID {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return SiteID{value: "site-" + hex.EncodeToString(b)}
}

// GenerateAppInstanceID creates a new random AppInstanceID.
func GenerateAppInstanceID() AppInstanceID {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return AppInstanceID{value: "app-" + hex.EncodeToString(b)}
}

// DeactivateLegacyApp is the SAFE version of the Atlassian maintenance function.
// It accepts ONLY AppInstanceID - passing a SiteID is a COMPILE-TIME ERROR.
func DeactivateLegacyApp(ids []AppInstanceID) error {
	for _, id := range ids {
		fmt.Printf("Deactivating app instance: %s\n", id)
	}
	return nil
}

// DeleteSite is the dangerous operation that requires explicit SiteID.
// Because the types are distinct, you CANNOT accidentally call this with AppInstanceIDs.
func DeleteSite(id SiteID, confirmation string) error {
	if confirmation != "PERMANENTLY-DELETE-"+id.String() {
		return errors.New("deletion requires explicit confirmation string")
	}
	fmt.Printf("DELETING site: %s\n", id)
	return nil
}

// DeletionSafeguard adds multiple layers of protection to destructive operations.
type DeletionSafeguard struct {
	maxBatchSize    int
	requireApproval bool
	dryRunFirst     bool
}

// NewDeletionSafeguard creates safeguards for bulk destructive operations.
func NewDeletionSafeguard(maxBatchSize int) *DeletionSafeguard {
	return &DeletionSafeguard{
		maxBatchSize:    maxBatchSize,
		requireApproval: true,
		dryRunFirst:     true,
	}
}

// ValidateBatch checks a batch of deletions before execution.
func (ds *DeletionSafeguard) ValidateBatch(count int) error {
	if count > ds.maxBatchSize {
		return fmt.Errorf(
			"BLOCKED: batch deletion of %d items exceeds maximum of %d. "+
				"This safety limit prevents mass deletion incidents. "+
				"If this is intentional, increase the batch limit explicitly",
			count, ds.maxBatchSize,
		)
	}
	if count > 100 {
		return fmt.Errorf(
			"WARNING: batch deletion of %d items requires additional approval. "+
				"Deletions above 100 items must be approved by a second engineer",
			count,
		)
	}
	return nil
}

// SoftDelete marks records as deleted without removing data.
// This provides a recovery window for accidental deletions.
type SoftDelete struct {
	DeletedAt   *time.Time
	DeletedBy   UserID
	Recoverable bool
	RecoverBy   time.Time // deadline for recovery before hard delete
}

// ScheduleHardDelete creates a soft delete with a recovery window.
func ScheduleHardDelete(deletedBy UserID, recoveryWindow time.Duration) *SoftDelete {
	now := time.Now()
	return &SoftDelete{
		DeletedAt:   &now,
		DeletedBy:   deletedBy,
		Recoverable: true,
		RecoverBy:   now.Add(recoveryWindow),
	}
}

// IsRecoverable checks if a soft-deleted item can still be recovered.
func (sd *SoftDelete) IsRecoverable() bool {
	return sd.Recoverable && time.Now().Before(sd.RecoverBy)
}
```

### Key Lessons for Go Engineers

1. **Use distinct types for distinct identifiers** - Go's type system is your strongest defense against
   parameter confusion. `type SiteID struct{ value string }` and `type AppID struct{ value string }`
   prevent the exact class of bug that caused the Atlassian incident.
2. **Destructive operations need multiple safeguards** - batch size limits, dry-run modes, confirmation
   strings, soft deletes with recovery windows, and mandatory second-person approval.
3. **Backup is not recovery** - Atlassian had backups but no bulk recovery process. Test your restoration
   pipeline at the scale of your worst-case scenario, not just single-item recovery.
4. **Never use `[]string` for identifiers** - plain strings are the most dangerous type in any codebase
   because they can represent anything. Wrap every identifier in a purpose-built type.

### Exercises

1. Implement a **type-safe ID framework** using Go generics: `type ID[T any] struct { value string }` where
   `T` is a phantom type that prevents cross-type confusion at compile time.
2. Build a **deletion audit system** that logs every destructive operation with the operator, timestamp,
   affected resources, and rollback procedure, stored in an append-only audit log.
3. Design a **bulk operation pipeline** with dry-run, approval gate, canary execution (10%), observation
   window, and full execution - applying the same progressive rollout principles to data operations.

---

### Junior → FAANG: Phantom Types and Destructive Operation Safeguards as Interview Topics

The Atlassian incident is the interview answer to "how do you prevent accidental data deletion at scale?" The root cause was that a maintenance script accepted `[]string` for both app instance IDs and site IDs. When the wrong ID list was passed, the type system provided no defense. In Go, the solution is phantom types or distinct named types: `type SiteID struct{ value string }` and `type AppInstanceID struct{ value string }` force the compiler to reject cross-type calls. This is a concrete, demonstrable technique that interviewers value because it shows you understand that type safety is not just about preventing runtime panics but about encoding domain invariants into the type system. For the behavioral component, frame the lesson as: "I no longer use raw strings for identifiers in any production service. Every ID gets its own type, and the type's String method includes the entity kind prefix to make log entries self-describing."

### Senior @ FAANG: Backup Restoration SLA and Data Operations Governance as Platform Standards

At L6, the Atlassian incident reveals two organizational failures that are more important than the type safety failure. The first is that Atlassian had backups but no tested bulk restoration process. They had run restoration drills for individual accounts, not for 775 simultaneous site restorations under customer pressure with a public incident running. The gap between "we have backups" and "we can recover from our worst-case data loss scenario in a defined time window" is the gap between having a safety net and having a safety net you have tested at load. At staff level, your disaster recovery posture must include: documented RTO (recovery time objective) and RPO (recovery point objective) for each data tier, a tested restoration procedure at 10x the typical incident scale, and a quarterly drill that exercises the full restoration pipeline including the human coordination aspects.

The second failure is that data deletion operations were not subject to the same progressive delivery governance as code deployments. The maintenance script ran to completion without a canary phase, a batch size cap, or an observation window. At staff level, you establish a data operations governance policy: any script that modifies or deletes more than N records (where N is calibrated to the data tier's criticality) must go through a four-stage pipeline: dry-run with output review, 1% execution with impact verification, 10% execution with a bake period, and full execution with a rollback plan. Scripts that cannot be interrupted and rolled back mid-execution are not approved for production. This policy, enforced as a platform gate rather than a guideline, would have stopped the Atlassian script at the dry-run phase when an engineer reviewed the output and saw 775 production site IDs instead of 775 app instance IDs.

