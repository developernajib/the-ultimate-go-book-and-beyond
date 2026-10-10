## Go Version Adoption Strategies

### The Four Adoption Archetypes

Companies do not publish version matrices for their internal fleets, but the strategies they follow cluster into four recognizable archetypes. Pick the one that matches your organization's risk profile.

**Archetype 1: The Early Adopter (Google-style).**

Google maintains Go, tests releases against its own monorepo before they ship, and moves internal code forward aggressively. If your organization has a strong central platform team and a monorepo with uniform CI, this is the cheapest strategy in the long run: small frequent upgrades beat rare painful ones.

```go
// Early-adopter strategy:
// 1. The platform team tests the release candidate against the monorepo
// 2. Canary deployments to low-risk services
// 3. Gradual rollout over 2-4 weeks
// 4. New services start on the new version immediately

// Build constraints for version-specific code
//go:build go1.23

package newfeatures

import "iter" // Go 1.23 iterator support

func ProcessAll[T any](seq iter.Seq[T], fn func(T)) {
    for v := range seq {
        fn(v)
    }
}
```

**Archetype 2: The N-1 Shop (common at Uber-scale monorepos).**

Support the current and previous major version simultaneously, and migrate the fleet within one release cycle (roughly six months). Uber has written publicly about centralizing toolchain upgrades in its Go monorepo, and the N-1 policy is the standard shape for that maturity level: nobody is more than one release behind, so upgrade debt cannot compound.

```go
// N-1 strategy: the fleet spans at most two major versions.
// New services start on the latest stable, everything else
// migrates before the next release lands.

// Migration checklist (one per service):
type MigrationChecklist struct {
    // Pre-migration
    DeprecationWarningsFixed  bool
    TestsPassWithNewVersion   bool
    BenchmarksWithinThreshold bool

    // During migration
    CanaryDeploymentSuccess bool
    MetricsWithinBaseline   bool
    NoRegressionDetected    bool

    // Post-migration
    MonitoringAlertsReviewed bool
    DocumentationUpdated     bool
    TeamNotified             bool
}
```

**Archetype 3: The Stability-First Shop.**

Six to twelve months of lag, security patches applied immediately, feature adoption evaluated case by case. This is the right shape when the cost of a toolchain regression is high and the platform team is small.

```go
// Stability-first upgrade criteria: upgrade when the boxes are checked,
// not when the release lands.
type UpgradeCriteria struct {
    SecurityFixes    bool    // Must upgrade regardless of the rest
    PerformanceGain  float64 // Meaningful measured improvement (e.g. > 10%)
    DeveloperDemand  bool    // Teams are asking for a specific feature
    ProductionStable bool    // The release has 3+ months of field history
}
```

**Archetype 4: The Conservative Shop (regulated or payments-adjacent).**

Wait for the first patch release, test internally for a month or two, then migrate gradually. The `x.y.0` release is never the deployment target: the first patch release has absorbed the early-adopter bug reports.

```go
// Conservative policy: three named versions at any time.
type GoVersionPolicy struct {
    Minimum      string // Oldest version still allowed in CI
    Recommended  string // Default for new and migrating services
    Experimental string // Available for opt-in behind a flag

    // Example during a migration window:
    // Minimum:      "1.25"
    // Recommended:  "1.26"
    // Experimental: "1.27rc"
}
```

### Choosing Your Archetype

| Archetype | Adoption lag | Prerequisite | Failure mode it prevents |
|-----------|--------------|--------------|--------------------------|
| Early adopter | Under a month | Central platform team, uniform CI | Compounding upgrade debt |
| N-1 | 3-6 months | Monorepo or strong dependency governance | Fleet fragmentation |
| Stability-first | 6-12 months | Disciplined security-patch fast path | Toolchain regressions in production |
| Conservative | After first patch release | Version-matrix CI testing | Being the ecosystem's bug reporter |

Two rules hold across all four archetypes. First, security patch releases are exempt from every policy: they go out immediately. Second, the Go team's compatibility promise makes upgrades cheaper than in almost any comparable ecosystem, so the most expensive strategy is the one where lag accumulates until an upgrade becomes a project instead of a chore.

---
