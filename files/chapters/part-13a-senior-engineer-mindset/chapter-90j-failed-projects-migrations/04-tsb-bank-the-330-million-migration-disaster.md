## 90J.3 TSB Bank: The £330 Million Migration Disaster (2018)

### The Background

TSB Bank was originally part of Lloyds Banking Group. When TSB was spun off as an independent bank in 2013, it
continued running on Lloyds' legacy banking platform under a transitional services agreement. TSB's new owner,
Sabadell (a Spanish bank), planned to migrate all 5.4 million TSB customer accounts from the Lloyds platform
to Sabadell's Proteo4UK platform. This was one of the largest bank migrations in UK history.

### The Timeline

**2015-2017: Planning and Development**

Sabadell spent three years developing and testing the Proteo4UK platform, adapting their Spanish banking
software for the UK market. The project involved migrating current accounts, savings accounts, mortgages,
credit cards, and business banking products - each with their own data structures, regulatory requirements,
and integration points with UK payment systems (BACS, Faster Payments, CHAPS, LINK ATM network).

Multiple go/no-go reviews were conducted. Internal testing showed issues, but each time the decision was made
to proceed on schedule. The migration was planned as a "big bang" - all 5.4 million accounts would be moved
in a single weekend. There was no phased rollout, no canary migration, no ability to partially roll back.

**April 20-22, 2018: The Migration Weekend**

On Friday evening, TSB took its systems offline for the migration. Over the weekend, the data from 5.4 million
accounts was extracted from the Lloyds platform, transformed, and loaded into Proteo4UK. The migration itself
completed - the data was moved.

**Monday, April 23, 2018: Launch Day**

When TSB turned on the new platform on Monday morning, the disaster began immediately:

- **1.9 million customers were locked out** of online and mobile banking entirely
- Customers who could log in saw other people's account details, balances, and transactions
- Some customers could see accounts belonging to other people and had the ability to transfer money from them
- Business banking customers could not access their accounts at all
- Direct debits and standing orders failed to execute
- Mortgage payments were not processed
- Customers could not make payments or transfer money
- The call center was overwhelmed - wait times exceeded two hours, and the phone systems themselves crashed

**April-June 2018: The Prolonged Crisis**

Unlike a typical outage that lasts hours, TSB's problems persisted for weeks. The core issues were:

1. **Data mapping errors**: Account data had been incorrectly mapped between systems, causing customers to
   see wrong balances or other people's accounts
2. **Integration failures**: Connections to UK payment networks (BACS, Faster Payments) were not working
   correctly, causing payment failures
3. **Capacity issues**: The Proteo4UK platform could not handle the load from 5.4 million accounts
4. **No rollback path**: There was no realistic way to move 5.4 million accounts back to the Lloyds platform

TSB CEO Paul Pester initially described the problems as "teething issues." As the crisis deepened over the
following weeks, he was forced to resign. The bank set up a £150 million compensation fund for affected
customers. The total cost of the migration disaster reached £330 million.

**The Regulatory Aftermath**

The Financial Conduct Authority (FCA) and the Prudential Regulation Authority (PRA) launched investigations.
An independent review by Slaughter and May found systemic failures in testing, governance, and risk management.
The review concluded that TSB had insufficient testing of the Proteo4UK platform under realistic conditions
and that the governance structure did not adequately escalate the known risks.

### Root Cause Analysis

1. **Big bang migration**: All 5.4 million accounts migrated at once with no phased approach
2. **No rollback plan**: Once migrated, there was no realistic path back
3. **Data mapping errors**: Incorrect transformation rules caused data corruption
4. **Insufficient testing**: The platform was not tested at scale with real data patterns
5. **Integration gaps**: Payment network integrations were not fully validated
6. **Governance failure**: Known risks were not escalated to decision-makers
7. **Single weekend deadline**: A migration of this scale needed weeks, not a weekend

### Go Code: Migration Validation System

The TSB disaster underscores the need for rigorous validation at every stage of a data migration. Here
is a Go system that validates data integrity before, during, and after migration:

```go
package migration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
)

// -----------------------------------------------------------------------
// Migration validation framework
// -----------------------------------------------------------------------

// Account represents a bank account being migrated. In a real system,
// this would contain all the fields in the source and target schemas.
type Account struct {
	ID              string            `json:"id"`
	CustomerID      string            `json:"customer_id"`
	Type            string            `json:"type"` // current, savings, mortgage, credit
	Balance         int64             `json:"balance"` // in pence/cents
	Currency        string            `json:"currency"`
	SortCode        string            `json:"sort_code"`
	AccountNumber   string            `json:"account_number"`
	DirectDebits    []DirectDebit     `json:"direct_debits"`
	StandingOrders  []StandingOrder   `json:"standing_orders"`
	Metadata        map[string]string `json:"metadata"`
}

// DirectDebit represents a direct debit instruction.
type DirectDebit struct {
	Reference    string `json:"reference"`
	OriginatorID string `json:"originator_id"`
	Amount       int64  `json:"amount"`
	Frequency    string `json:"frequency"`
	NextDate     string `json:"next_date"`
}

// StandingOrder represents a standing order instruction.
type StandingOrder struct {
	Reference       string `json:"reference"`
	DestSortCode    string `json:"dest_sort_code"`
	DestAccountNum  string `json:"dest_account_num"`
	Amount          int64  `json:"amount"`
	Frequency       string `json:"frequency"`
	NextDate        string `json:"next_date"`
}

// ValidationResult captures the outcome of validating a single account
// migration.
type ValidationResult struct {
	AccountID    string
	CustomerID   string
	Valid        bool
	Errors       []ValidationError
	CheckedAt    time.Time
	SourceHash   string
	TargetHash   string
}

// ValidationError describes a specific discrepancy found during
// validation.
type ValidationError struct {
	Field      string
	SourceVal  string
	TargetVal  string
	Severity   string // "critical", "warning", "info"
	Message    string
}

// MigrationReport is the aggregate report for the entire migration
// validation run.
type MigrationReport struct {
	mu               sync.Mutex
	StartTime        time.Time            `json:"start_time"`
	EndTime          time.Time            `json:"end_time"`
	TotalAccounts    int64                `json:"total_accounts"`
	ValidatedCount   int64                `json:"validated_count"`
	PassedCount      int64                `json:"passed_count"`
	FailedCount      int64                `json:"failed_count"`
	CriticalErrors   int64                `json:"critical_errors"`
	Warnings         int64                `json:"warnings"`
	FailedAccounts   []ValidationResult   `json:"failed_accounts,omitempty"`
	ErrorDistribution map[string]int64    `json:"error_distribution"`
}

// MigrationPhase represents which phase of migration we are validating.
type MigrationPhase int

const (
	PhasePre       MigrationPhase = iota // Before migration begins
	PhaseDuring                           // During migration (incremental checks)
	PhasePost                             // After migration completes
	PhaseParallel                         // Parallel running period
)

// SourceReader reads accounts from the source (legacy) system.
type SourceReader interface {
	ReadAccount(ctx context.Context, id string) (*Account, error)
	ListAccountIDs(ctx context.Context, batchSize int) (<-chan []string, error)
	Count(ctx context.Context) (int64, error)
}

// TargetReader reads accounts from the target (new) system.
type TargetReader interface {
	ReadAccount(ctx context.Context, id string) (*Account, error)
	Count(ctx context.Context) (int64, error)
}

// -----------------------------------------------------------------------
// Validator
// -----------------------------------------------------------------------

// Validator performs comprehensive comparison between source and target
// accounts during migration.
type Validator struct {
	source      SourceReader
	target      TargetReader
	concurrency int
	phase       MigrationPhase
	report      *MigrationReport
}

// NewValidator creates a new migration validator.
func NewValidator(source SourceReader, target TargetReader, concurrency int) *Validator {
	return &Validator{
		source:      source,
		target:      target,
		concurrency: concurrency,
		report: &MigrationReport{
			ErrorDistribution: make(map[string]int64),
		},
	}
}

// ValidateAll validates every account in the source system against the
// target system. This is the primary validation function that should
// be run before declaring a migration complete.
func (v *Validator) ValidateAll(ctx context.Context) (*MigrationReport, error) {
	v.report.StartTime = time.Now()

	// Count source accounts.
	sourceCount, err := v.source.Count(ctx)
	if err != nil {
		return nil, fmt.Errorf("counting source accounts: %w", err)
	}
	v.report.TotalAccounts = sourceCount

	// Count target accounts to check for count mismatch.
	targetCount, err := v.target.Count(ctx)
	if err != nil {
		return nil, fmt.Errorf("counting target accounts: %w", err)
	}

	if sourceCount != targetCount {
		fmt.Printf("[MIGRATION VALIDATOR] WARNING: account count mismatch - "+
			"source: %d, target: %d\n", sourceCount, targetCount)
	}

	// Stream account IDs from source.
	idBatches, err := v.source.ListAccountIDs(ctx, 1000)
	if err != nil {
		return nil, fmt.Errorf("listing account IDs: %w", err)
	}

	// Process batches with bounded concurrency.
	sem := make(chan struct{}, v.concurrency)
	var wg sync.WaitGroup

	var validated atomic.Int64

	for batch := range idBatches {
		for _, id := range batch {
			select {
			case <-ctx.Done():
				wg.Wait()
				v.report.EndTime = time.Now()
				return v.report, ctx.Err()
			default:
			}

			sem <- struct{}{}
			wg.Add(1)
			go func(accountID string) {
				defer wg.Done()
				defer func() { <-sem }()

				result := v.validateAccount(ctx, accountID)
				v.recordResult(result)

				count := validated.Add(1)
				if count%10000 == 0 {
					fmt.Printf("[MIGRATION VALIDATOR] Validated %d/%d accounts (%.1f%%)\n",
						count, sourceCount, float64(count)/float64(sourceCount)*100)
				}
			}(id)
		}
	}

	wg.Wait()
	v.report.EndTime = time.Now()
	v.report.ValidatedCount = validated.Load()

	return v.report, nil
}

// validateAccount compares a single account between source and target.
func (v *Validator) validateAccount(ctx context.Context, id string) ValidationResult {
	result := ValidationResult{
		AccountID: id,
		CheckedAt: time.Now(),
		Valid:     true,
	}

	// Read from source.
	sourceAccount, err := v.source.ReadAccount(ctx, id)
	if err != nil {
		result.Valid = false
		result.Errors = append(result.Errors, ValidationError{
			Field:    "account",
			Severity: "critical",
			Message:  fmt.Sprintf("failed to read from source: %v", err),
		})
		return result
	}
	result.CustomerID = sourceAccount.CustomerID
	result.SourceHash = hashAccount(sourceAccount)

	// Read from target.
	targetAccount, err := v.target.ReadAccount(ctx, id)
	if err != nil {
		result.Valid = false
		result.Errors = append(result.Errors, ValidationError{
			Field:    "account",
			Severity: "critical",
			Message:  fmt.Sprintf("account missing from target: %v", err),
		})
		return result
	}
	result.TargetHash = hashAccount(targetAccount)

	// Compare critical fields.
	if sourceAccount.CustomerID != targetAccount.CustomerID {
		result.Valid = false
		result.Errors = append(result.Errors, ValidationError{
			Field:    "customer_id",
			SourceVal: sourceAccount.CustomerID,
			TargetVal: targetAccount.CustomerID,
			Severity: "critical",
			Message:  "Customer ID mismatch - account may be associated with wrong customer",
		})
	}

	if sourceAccount.Balance != targetAccount.Balance {
		result.Valid = false
		result.Errors = append(result.Errors, ValidationError{
			Field:    "balance",
			SourceVal: fmt.Sprintf("%d", sourceAccount.Balance),
			TargetVal: fmt.Sprintf("%d", targetAccount.Balance),
			Severity: "critical",
			Message:  "Balance mismatch - customer will see wrong balance",
		})
	}

	if sourceAccount.SortCode != targetAccount.SortCode {
		result.Valid = false
		result.Errors = append(result.Errors, ValidationError{
			Field:    "sort_code",
			SourceVal: sourceAccount.SortCode,
			TargetVal: targetAccount.SortCode,
			Severity: "critical",
			Message:  "Sort code mismatch - payments will fail",
		})
	}

	if sourceAccount.AccountNumber != targetAccount.AccountNumber {
		result.Valid = false
		result.Errors = append(result.Errors, ValidationError{
			Field:    "account_number",
			SourceVal: sourceAccount.AccountNumber,
			TargetVal: targetAccount.AccountNumber,
			Severity: "critical",
			Message:  "Account number mismatch - payments will fail",
		})
	}

	// Validate direct debits.
	v.validateDirectDebits(sourceAccount, targetAccount, &result)

	// Validate standing orders.
	v.validateStandingOrders(sourceAccount, targetAccount, &result)

	// Validate account type.
	if sourceAccount.Type != targetAccount.Type {
		result.Valid = false
		result.Errors = append(result.Errors, ValidationError{
			Field:    "account_type",
			SourceVal: sourceAccount.Type,
			TargetVal: targetAccount.Type,
			Severity: "critical",
			Message:  "Account type changed during migration",
		})
	}

	return result
}

// validateDirectDebits compares direct debit instructions between
// source and target.
func (v *Validator) validateDirectDebits(source, target *Account, result *ValidationResult) {
	sourceDebits := make(map[string]DirectDebit)
	for _, dd := range source.DirectDebits {
		sourceDebits[dd.Reference] = dd
	}

	targetDebits := make(map[string]DirectDebit)
	for _, dd := range target.DirectDebits {
		targetDebits[dd.Reference] = dd
	}

	// Check for missing direct debits in target.
	for ref, sdd := range sourceDebits {
		tdd, exists := targetDebits[ref]
		if !exists {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:    "direct_debit",
				SourceVal: ref,
				Severity: "critical",
				Message:  fmt.Sprintf("Direct debit %s missing from target", ref),
			})
			continue
		}
		if sdd.Amount != tdd.Amount {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:    "direct_debit_amount",
				SourceVal: fmt.Sprintf("%d", sdd.Amount),
				TargetVal: fmt.Sprintf("%d", tdd.Amount),
				Severity: "critical",
				Message:  fmt.Sprintf("Direct debit %s amount mismatch", ref),
			})
		}
	}

	// Check for extra direct debits in target.
	for ref := range targetDebits {
		if _, exists := sourceDebits[ref]; !exists {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:    "direct_debit",
				TargetVal: ref,
				Severity: "warning",
				Message:  fmt.Sprintf("Extra direct debit %s in target", ref),
			})
		}
	}
}

// validateStandingOrders compares standing orders between source and
// target.
func (v *Validator) validateStandingOrders(source, target *Account, result *ValidationResult) {
	sourceOrders := make(map[string]StandingOrder)
	for _, so := range source.StandingOrders {
		sourceOrders[so.Reference] = so
	}

	targetOrders := make(map[string]StandingOrder)
	for _, so := range target.StandingOrders {
		targetOrders[so.Reference] = so
	}

	for ref, sso := range sourceOrders {
		tso, exists := targetOrders[ref]
		if !exists {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:    "standing_order",
				SourceVal: ref,
				Severity: "critical",
				Message:  fmt.Sprintf("Standing order %s missing from target", ref),
			})
			continue
		}
		if sso.Amount != tso.Amount || sso.DestSortCode != tso.DestSortCode ||
			sso.DestAccountNum != tso.DestAccountNum {
			result.Valid = false
			result.Errors = append(result.Errors, ValidationError{
				Field:    "standing_order_details",
				Severity: "critical",
				Message:  fmt.Sprintf("Standing order %s details mismatch", ref),
			})
		}
	}
}

// recordResult safely adds a validation result to the report.
func (v *Validator) recordResult(result ValidationResult) {
	v.report.mu.Lock()
	defer v.report.mu.Unlock()

	if result.Valid {
		v.report.PassedCount++
	} else {
		v.report.FailedCount++
		// Store first 1000 failures for detailed review.
		if len(v.report.FailedAccounts) < 1000 {
			v.report.FailedAccounts = append(v.report.FailedAccounts, result)
		}
		for _, e := range result.Errors {
			v.report.ErrorDistribution[e.Field]++
			if e.Severity == "critical" {
				v.report.CriticalErrors++
			} else {
				v.report.Warnings++
			}
		}
	}
}

// PrintSummary outputs a human-readable summary of the validation.
func (r *MigrationReport) PrintSummary() {
	r.mu.Lock()
	defer r.mu.Unlock()

	fmt.Println("\n" + fmt.Sprintf("%s", "========================================"))
	fmt.Println("  MIGRATION VALIDATION REPORT")
	fmt.Println("========================================")
	fmt.Printf("  Total Accounts:    %d\n", r.TotalAccounts)
	fmt.Printf("  Validated:         %d\n", r.ValidatedCount)
	fmt.Printf("  Passed:            %d (%.2f%%)\n", r.PassedCount,
		float64(r.PassedCount)/float64(r.ValidatedCount)*100)
	fmt.Printf("  Failed:            %d (%.2f%%)\n", r.FailedCount,
		float64(r.FailedCount)/float64(r.ValidatedCount)*100)
	fmt.Printf("  Critical Errors:   %d\n", r.CriticalErrors)
	fmt.Printf("  Warnings:          %d\n", r.Warnings)
	fmt.Println("----------------------------------------")
	fmt.Println("  Error Distribution:")
	for field, count := range r.ErrorDistribution {
		fmt.Printf("    %-30s %d\n", field, count)
	}
	fmt.Println("========================================")

	if r.CriticalErrors > 0 {
		fmt.Println("\n  RECOMMENDATION: DO NOT GO LIVE")
		fmt.Printf("  %d critical errors must be resolved first.\n", r.CriticalErrors)
	} else if r.FailedCount > 0 {
		fmt.Println("\n  RECOMMENDATION: REVIEW WARNINGS BEFORE GO-LIVE")
	} else {
		fmt.Println("\n  RECOMMENDATION: MIGRATION VALIDATED SUCCESSFULLY")
	}
}

// hashAccount computes a deterministic hash of an account's critical
// fields for quick comparison.
func hashAccount(a *Account) string {
	data, _ := json.Marshal(a)
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}
```

### Engineering Lessons

1. **Never do a big bang migration** - migrate in phases, starting with the least critical accounts.
2. **Build a rollback path** - if you cannot roll back, you cannot recover from errors.
3. **Validate every single record** - compare source and target for every account, every field.
4. **Run parallel for weeks** - keep both systems running and compare results before cutting over.
5. **Test with production data volumes** - 5.4 million accounts behave differently than 50,000 test accounts.
6. **Governance must escalate risk** - if testers find issues, the launch must be delayed.

---

### Junior → FAANG: Parallel-Run Migration as the Interview Answer to "How Do You Migrate Safely?"

TSB Bank is the interview answer to "how would you migrate 5.4 million accounts to a new banking system?" The answer is not "we would migrate them all at once on the cutover weekend." The answer is the strangler fig pattern applied to data: migrate a small cohort of low-risk accounts first, run both systems in parallel for at least four weeks comparing outputs record by record, establish automated reconciliation between old and new systems that runs continuously, and only cut over additional cohorts when the previous cohort has zero discrepancies for 14 consecutive days. TSB's failure was executing a big-bang migration of all 5.4 million accounts simultaneously with no parallel-run phase and no per-record validation. When problems emerged, there was no rollback path because the old system had been decommissioned. The specific lesson for interviews: any migration that has no tested rollback path should not proceed.

### Senior @ FAANG: Migration Governance as a Formal Process with Explicit Go/No-Go Gates

At L6, TSB Bank demonstrates that technical migration planning is necessary but not sufficient. TSB had a technical migration plan. What they lacked was a governance process that gave technical concerns the authority to delay the business timeline. This is the staff engineer's contribution: defining the formal go/no-go criteria before the migration begins, specifying what constitutes a passing state at each gate, and ensuring that a single executive cannot override a failing gate by asserting business urgency. The governance structure needs three components. First, explicit quantitative gates: reconciliation error rate must be below 0.001% for cohort N before cohort N+1 migrates, and the error rate must be measured independently by the team running the migration and a separate QA team. Second, mandatory parallel-run duration: no cohort can be cut over with fewer than four weeks of parallel-run data, regardless of business timeline pressure. Third, rollback authority: the migration owner must have the unilateral authority to halt the migration and invoke the rollback plan without requiring executive approval. TSB's testers found significant issues before go-live. Those findings did not result in a delay because there was no governance mechanism that gave technical teams the authority to override the business decision. The staff engineer's job is to build that governance mechanism into the project plan before the project begins, not to fight for it after the problems are already visible.

---
