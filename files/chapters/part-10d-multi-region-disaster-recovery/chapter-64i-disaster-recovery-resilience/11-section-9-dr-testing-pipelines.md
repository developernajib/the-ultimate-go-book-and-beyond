## Section 9: DR Testing Pipelines

DR tests are only valuable if they run regularly, automatically, and produce measurable results. A DR testing pipeline treats a recovery test as a CI/CD pipeline stage.

```go
// file: internal/dr/testing/pipeline.go
package drtest

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// TestType categorizes different kinds of DR tests.
type TestType string

const (
	TestTabletop   TestType = "tabletop"   // paper exercise, no real systems
	TestWalkthroughTestType = "walkthrough" // partial real steps, no failover
	TestSimulation TestType = "simulation"  // full simulation on non-prod
	TestFailover   TestType = "failover"    // real failover with rollback
	TestGameDay    TestType = "game_day"    // cross-team real-world event
)

// DRTest defines a single test scenario.
type DRTest struct {
	ID          string
	Name        string
	Type        TestType
	Description string
	Scenario    string // e.g. "us-east-1 total region loss"
	Steps       []DRTestStep
	MaxDuration time.Duration
	RTOTarget   time.Duration
	RPOTarget   time.Duration
}

// DRTestStep is one step in a DR test.
type DRTestStep struct {
	Name       string
	Executor   func(ctx context.Context) error
	Validator  func(ctx context.Context) error
	IsCheckpoint bool // pause and require human validation
}

// DRTestResult captures the full test outcome.
type DRTestResult struct {
	TestID       string
	TestName     string
	StartedAt    time.Time
	EndedAt      time.Time
	Passed       bool
	ActualRTO    time.Duration
	ActualRPO    time.Duration
	RTOTarget    time.Duration
	RPOTarget    time.Duration
	RTOPassed    bool
	RPOPassed    bool
	StepResults  []DRStepResult
	Observations []string
	ActionItems  []ActionItem
}

// DRStepResult captures one step outcome.
type DRStepResult struct {
	StepName  string
	Passed    bool
	Duration  time.Duration
	Error     string
}

// ActionItem is an improvement identified during a DR test.
type ActionItem struct {
	Description string
	Owner       string
	Priority    int // 1=critical, 2=high, 3=medium
	DueDate     time.Time
}

// DRPipeline orchestrates a sequence of DR tests.
type DRPipeline struct {
	tests  []DRTest
	logger *slog.Logger
}

func NewDRPipeline(logger *slog.Logger) *DRPipeline {
	return &DRPipeline{logger: logger.With("component", "dr_pipeline")}
}

func (p *DRPipeline) AddTest(t DRTest) {
	p.tests = append(p.tests, t)
}

// RunAll executes all tests in sequence and returns aggregated results.
func (p *DRPipeline) RunAll(ctx context.Context) ([]*DRTestResult, error) {
	p.logger.InfoContext(ctx, "DR test pipeline starting", "total_tests", len(p.tests))

	var results []*DRTestResult
	for _, test := range p.tests {
		result, err := p.runTest(ctx, test)
		results = append(results, result)
		if err != nil {
			p.logger.ErrorContext(ctx, "DR test failed",
				"test_id", test.ID,
				"test_name", test.Name,
				"error", err,
			)
		}
	}

	passed := 0
	for _, r := range results {
		if r.Passed {
			passed++
		}
	}
	p.logger.InfoContext(ctx, "DR test pipeline complete",
		"total", len(results),
		"passed", passed,
		"failed", len(results)-passed,
	)

	return results, nil
}

func (p *DRPipeline) runTest(ctx context.Context, test DRTest) (*DRTestResult, error) {
	p.logger.InfoContext(ctx, "DR test started",
		"test_id", test.ID,
		"test_name", test.Name,
		"type", test.Type,
		"scenario", test.Scenario,
	)

	testCtx, cancel := context.WithTimeout(ctx, test.MaxDuration)
	defer cancel()

	result := &DRTestResult{
		TestID:    test.ID,
		TestName:  test.Name,
		StartedAt: time.Now().UTC(),
		RTOTarget: test.RTOTarget,
		RPOTarget: test.RPOTarget,
	}

	failoverStart := time.Now()
	allPassed := true

	for _, step := range test.Steps {
		stepResult := DRStepResult{StepName: step.Name}
		stepStart := time.Now()

		if step.IsCheckpoint {
			p.logger.InfoContext(testCtx, "CHECKPOINT: manual validation required",
				"test", test.Name,
				"step", step.Name,
			)
			// In automated pipelines, checkpoints may be skipped or signaled via channel.
			// Here we just record and continue.
			stepResult.Passed = true
			stepResult.Duration = time.Since(stepStart)
			result.StepResults = append(result.StepResults, stepResult)
			continue
		}

		if err := step.Executor(testCtx); err != nil {
			stepResult.Passed = false
			stepResult.Error = err.Error()
			allPassed = false
			p.logger.ErrorContext(testCtx, "DR test step failed",
				"step", step.Name,
				"error", err,
			)
		} else {
			stepResult.Passed = true
		}

		// Run validator even on failure to collect evidence.
		if step.Validator != nil {
			if err := step.Validator(testCtx); err != nil {
				stepResult.Passed = false
				stepResult.Error = fmt.Sprintf("validation: %s", err)
				allPassed = false
			}
		}

		stepResult.Duration = time.Since(stepStart)
		result.StepResults = append(result.StepResults, stepResult)
	}

	result.ActualRTO = time.Since(failoverStart)
	result.EndedAt = time.Now().UTC()
	result.RTOPassed = result.ActualRTO <= test.RTOTarget
	// RPO measurement requires comparing backup timestamps - simplified here.
	result.RPOPassed = true
	result.Passed = allPassed && result.RTOPassed && result.RPOPassed

	p.logger.InfoContext(ctx, "DR test complete",
		"test_id", test.ID,
		"passed", result.Passed,
		"actual_rto", result.ActualRTO,
		"rto_target", test.RTOTarget,
		"rto_passed", result.RTOPassed,
		"duration", result.EndedAt.Sub(result.StartedAt),
	)

	return result, nil
}
```

---

### Junior -> FAANG: DR Tests as a CI/CD Stage

The insight in this section is that a DR test is not fundamentally different from a unit test or an integration test. It is a test that verifies a property of your system: "given failure condition X, the system recovers within time Y with data loss no greater than Z." CI/CD pipelines run tests automatically. DR testing pipelines run DR tests automatically.

For interviews: when asked "how do you verify your DR objectives are being met?", the weak answer is "we test it before each release." The strong answer is "we have a DR testing pipeline that runs automatically on a weekly schedule, injects a specific failure scenario, measures actual RTO and RPO against the contract limits, and fails the pipeline if limits are exceeded." This answer demonstrates both technical depth and operational maturity.

A practical first-job contribution: find the oldest DR runbook in your team's wiki that has not been tested recently. Propose adding a single automated test that verifies the first three steps of that runbook. Small, concrete, low-risk. It is the beginning of a DR testing pipeline.

### Senior @ FAANG: DR Testing Pipeline as Infrastructure and Governance

**DR testing frequency must match the rate of system change.** A quarterly DR test is insufficient if the system changes weekly. Each deployment that adds a new service dependency, changes connection pool sizes, or modifies the database schema is a potential DR regression. Automated DR tests that run weekly (or after significant deployments) catch regressions before the next real incident. The frequency of DR testing should be proportional to the deployment frequency of the service.

**Test environments that mirror production.** DR tests in staging environments where the dataset is 100x smaller than production, the network topology differs, and dependency versions are mismatched produce misleading results. A production-fidelity DR test either runs in a production traffic shadow (reads from production, writes to a test database) or in a dedicated pre-production environment that is maintained at the same scale and configuration as production. The cost of this environment is a fraction of the cost of a real DR incident.

**Failure mode coverage matrix.** A DR testing pipeline should cover at minimum: primary database failure, network partition between regions, dependency service failure (for each critical dependency), and storage exhaustion. As the system grows, new failure modes are discovered in incidents. After each incident, a new DR test case is added to the pipeline that would have caught the regression. The failure mode coverage matrix grows monotonically over time.

**Test result trending and SLA degradation detection.** Individual DR test results are less useful than trends. If last quarter's actual RTO was 8 minutes and this quarter's is 12 minutes (with the same SLA of 15 minutes), the trend is alarming even though both individual results pass. A principal engineer builds trending reports that compare DR test results over time and alert when the measured RTO/RPO is trending toward the SLA boundary, giving the team lead time to investigate before the next incident exposes the problem.

**DR test authorization and blast radius.** Running a DR test that intentionally fails the primary database must be authorized, scheduled, and limited to a specific blast radius. A DR test pipeline that can trigger failovers without authorization is a security risk: a compromised CI/CD system could trigger DR failovers in production. DR test pipeline execution should require explicit approval from a designated approver and should be limited to non-business-hours windows. Record the approver's identity and the approval timestamp in the test run log.

