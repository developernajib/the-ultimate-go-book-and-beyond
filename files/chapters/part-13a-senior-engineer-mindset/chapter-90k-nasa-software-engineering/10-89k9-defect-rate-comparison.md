## 90K.9 Defect Rate Comparison

The software industry has collected decades of data on defect rates. Comparing these
rates reveals the enormous gap between NASA's flight software and typical commercial
software.

### Defect Density Comparison Table

| Software Type | Defects per KLOC (dev) | Defects per KLOC (release) | Testing Ratio |
|---------------|----------------------|---------------------------|---------------|
| **NASA Flight Software** | < 0.1 | 0.004 | 10:1 (test:code) |
| **Space Shuttle PASS** | 0.04 | 0.004 | 8:1 |
| **DO-178C DAL-A Avionics** | < 1.0 | < 0.1 | 6:1 |
| **Safety-Critical Medical** | 1-5 | 0.1-0.5 | 4:1 |
| **Automotive (ISO 26262)** | 1-5 | 0.5-1.0 | 3:1 |
| **High-Quality Commercial** | 5-15 | 1-5 | 1:1 |
| **Typical Commercial** | 15-50 | 5-15 | 0.5:1 |
| **Open Source (varies)** | 5-50 | 1-20 | 0.3:1 |
| **Startup / Move Fast** | 30-100 | 10-50 | 0.1:1 |

Notes:
- KLOC = 1,000 lines of code.
- "Dev" = defects found during development (before release).
- "Release" = defects found after release to production.
- "Testing ratio" = lines of test code per line of production code.

### Why NASA's Defect Rate Is 1000x Better

The industry average for released commercial software is approximately 15 defects per
KLOC. NASA's flight software averages 0.004 defects per KLOC. That is a **3,750x**
difference. How?

1. **Specification completeness.** NASA writes 2,500 pages of specification for 6,366
   lines of code. Commercial software often has no formal specification at all.

2. **Multi-stage review.** Every line of code is reviewed by multiple independent
   reviewers. Each reviewer has a checklist. Defects found in review are tracked and
   root-caused.

3. **Independent V&V.** A separate organization writes tests from the same spec. This
   catches interpretation errors that the development team cannot see.

4. **Root cause analysis.** Every defect triggers a process investigation. The team asks:
   "Why did our process allow this defect to exist?" Then the process is modified.

5. **Static analysis.** Multiple static analyzers run on every build. All warnings are
   fixed - not suppressed, not ignored, fixed.

6. **Testing ratio.** NASA writes 8-10 lines of test code for every line of flight code.
   Commercial software averages 0.5-1 line of test code per line of production code.

### The Cost of Quality

| Metric | NASA Flight | Google/Big Tech | Startup |
|--------|-------------|-----------------|---------|
| Cost per line | $1,500 | $15-50 | $1-5 |
| Lines per developer per day | 3-5 | 50-100 | 100-500 |
| Defects per KLOC (release) | 0.004 | 1-5 | 10-50 |
| Cost of one defect in prod | $100M+ (mission loss) | $10K-$10M | $100-$100K |
| Break-even point | Always worth it | Usually worth it | Often not |

The $1,500/line cost is justified when a single bug can destroy a billion-dollar
spacecraft and decades of scientific work. For a web application, spending $1,500/line
would be absurd. The optimal investment in quality depends on the cost of failure.

```go
package nasa

import (
    "fmt"
    "math"
    "time"
)

// DefectMetrics tracks defect rates for a software project.
type DefectMetrics struct {
    ProjectName     string
    LinesOfCode     int
    TestLinesOfCode int
    DefectsFound    []DefectRecord
    ReviewHours     float64
    TestingHours    float64
    DevHours        float64
}

// ErrorSeverity classifies the impact of a defect.
type ErrorSeverity int

const (
    SeverityCritical ErrorSeverity = iota
    SeverityMajor
    SeverityModerate
    SeverityMinor
)

// DefectRecord tracks an individual defect.
type DefectRecord struct {
    ID          string
    Severity    ErrorSeverity
    Phase       DetectionPhase
    Category    DefectCategory
    FoundAt     time.Time
    ResolvedAt  time.Time
    RootCause   string
}

// DetectionPhase indicates when the defect was found.
type DetectionPhase int

const (
    PhaseDesignReview DetectionPhase = iota
    PhaseCodeReview
    PhaseUnitTest
    PhaseIntegrationTest
    PhaseSystemTest
    PhaseProduction
)

// DefectCategory classifies the type of defect.
type DefectCategory int

const (
    CategoryLogic DefectCategory = iota
    CategoryConcurrency
    CategoryMemory
    CategoryInput
    CategoryConfiguration
    CategoryPerformance
)

// DefectsPerKLOC returns defects per thousand lines of code.
func (dm *DefectMetrics) DefectsPerKLOC() float64 {
    if dm.LinesOfCode == 0 {
        return 0
    }
    return float64(len(dm.DefectsFound)) / (float64(dm.LinesOfCode) / 1000.0)
}

// TestingRatio returns test lines per production line.
func (dm *DefectMetrics) TestingRatio() float64 {
    if dm.LinesOfCode == 0 {
        return 0
    }
    return float64(dm.TestLinesOfCode) / float64(dm.LinesOfCode)
}

// ProductionDefectsPerKLOC returns only defects found after release.
func (dm *DefectMetrics) ProductionDefectsPerKLOC() float64 {
    if dm.LinesOfCode == 0 {
        return 0
    }

    prodDefects := 0
    for _, d := range dm.DefectsFound {
        if d.Phase == PhaseProduction {
            prodDefects++
        }
    }

    return float64(prodDefects) / (float64(dm.LinesOfCode) / 1000.0)
}

// CostOfQuality estimates the cost of the quality investment.
func (dm *DefectMetrics) CostOfQuality(hourlyRate float64) QualityCost {
    preventionCost := dm.ReviewHours * hourlyRate
    appraisalCost := dm.TestingHours * hourlyRate
    devCost := dm.DevHours * hourlyRate

    // Internal failure cost: defects found before production.
    internalFailures := 0
    for _, d := range dm.DefectsFound {
        if d.Phase != PhaseProduction {
            internalFailures++
        }
    }
    internalFailureCost := float64(internalFailures) * 4 * hourlyRate // ~4 hours per fix.

    // External failure cost: defects found in production.
    externalFailures := 0
    for _, d := range dm.DefectsFound {
        if d.Phase == PhaseProduction {
            externalFailures++
        }
    }
    externalFailureCost := float64(externalFailures) * 40 * hourlyRate // ~40 hours per prod fix.

    total := preventionCost + appraisalCost + internalFailureCost + externalFailureCost

    return QualityCost{
        PreventionCost:      preventionCost,
        AppraisalCost:       appraisalCost,
        InternalFailureCost: internalFailureCost,
        ExternalFailureCost: externalFailureCost,
        TotalQualityCost:    total,
        CostPerLine:         total / math.Max(float64(dm.LinesOfCode), 1),
        DevelopmentCost:     devCost,
        QualityToDevRatio:   total / math.Max(devCost, 1),
    }
}

// QualityCost breaks down the cost of quality.
type QualityCost struct {
    PreventionCost      float64 // Reviews, training, process improvement.
    AppraisalCost       float64 // Testing, static analysis, auditing.
    InternalFailureCost float64 // Fixing defects found before release.
    ExternalFailureCost float64 // Fixing defects found in production.
    TotalQualityCost    float64
    CostPerLine         float64
    DevelopmentCost     float64
    QualityToDevRatio   float64
}

// Report generates a human-readable quality report.
func (dm *DefectMetrics) Report() string {
    cost := dm.CostOfQuality(150.0) // $150/hour assumption.

    return fmt.Sprintf(`
Quality Report: %s
=================================
Lines of Code:        %d
Test Lines:           %d
Testing Ratio:        %.1f:1
Total Defects:        %d
Defects/KLOC:         %.3f
Production Defects:   %.3f/KLOC
Cost per Line:        $%.2f
Prevention Cost:      $%.0f
Appraisal Cost:       $%.0f
Internal Failure:     $%.0f
External Failure:     $%.0f
Total Quality Cost:   $%.0f
Quality/Dev Ratio:    %.1f%%
=================================`,
        dm.ProjectName,
        dm.LinesOfCode,
        dm.TestLinesOfCode,
        dm.TestingRatio(),
        len(dm.DefectsFound),
        dm.DefectsPerKLOC(),
        dm.ProductionDefectsPerKLOC(),
        cost.CostPerLine,
        cost.PreventionCost,
        cost.AppraisalCost,
        cost.InternalFailureCost,
        cost.ExternalFailureCost,
        cost.TotalQualityCost,
        cost.QualityToDevRatio*100,
    )
}
```

---
