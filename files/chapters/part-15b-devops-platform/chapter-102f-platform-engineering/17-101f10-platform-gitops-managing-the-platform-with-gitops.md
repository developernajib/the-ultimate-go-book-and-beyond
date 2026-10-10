## 102F.15 Platform GitOps - Managing the Platform with GitOps

The platform team should dogfood GitOps: all platform configuration lives in Git, applied via ArgoCD, reviewed via PRs.

```
platform-config/ (GitHub repo, restricted write: only platform team)
  environments/
    production/
      backstage/           <- Backstage Helm values.yaml
      crossplane/          <- XRDs and Compositions
      argocd/              <- ApplicationSet manifests
      cert-manager/
      external-secrets/
    staging/               <- Mirror of production, promoted via PR
  golden-paths/
    go-service/
      v2/                  <- Current active version
      v1/                  <- Deprecated but supported for 12 months
  policies/
    network-policies/      <- Default deny-all NetworkPolicy template
    resource-quotas/       <- Tiered quotas: small/medium/large teams
```

### Golden Path Change Management

Golden path updates must be validated before merge:

```go
package platformci

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// GoldenPathValidator ensures updates don't silently break existing services.
type GoldenPathValidator struct {
	TemplateDir string
	WorkDir     string
}

// Validate runs scaffold + build + test + k8s validation on a test service.
// Called in CI before every golden path PR can merge.
func (v *GoldenPathValidator) Validate(ctx context.Context) error {
	testDir := filepath.Join(v.WorkDir, "validation-service")
	defer os.RemoveAll(testDir)

	steps := []struct {
		name string
		args []string
		dir  string
	}{
		{"scaffold",      []string{"scaffolder", "--output", testDir, "--service", "test-svc"}, v.TemplateDir},
		{"build",         []string{"go", "build", "./..."},                                      testDir},
		{"test",          []string{"go", "test", "./...", "-race"},                               testDir},
		{"lint",          []string{"golangci-lint", "run"},                                       testDir},
		{"k8s-validate",  []string{"kubeconform", "-strict", "k8s/"},                             testDir},
	}

	for _, step := range steps {
		cmd := exec.CommandContext(ctx, step.args[0], step.args[1:]...)
		cmd.Dir = step.dir
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("step %q failed:\n%s", step.name, out)
		}
	}
	return nil
}
```

**CI pipeline for platform PRs:**
1. `GoldenPathValidator.Validate()` - scaffolds test service, verifies it builds and tests pass
2. `kubeconform` - validates all Kubernetes manifests against current API spec
3. `conftest` (OPA policies) - checks manifests comply with security policies
4. Auto-apply to staging on merge → smoke test on staging → promote to production via second PR

### Junior → FAANG: Why the Platform Team Must Eat Its Own Dog Food

GitOps for the platform itself is a principle that is easy to state and surprisingly hard to maintain under delivery pressure. When the platform team is rushing to ship a new feature, the temptation is to apply changes manually to the cluster and then "backfill the commit later." This is the path to configuration drift, which is exactly what the platform exists to prevent in product teams.

For a junior engineer joining a platform team, insisting on GitOps for platform changes is a professional discipline issue, not a technical one. Every configuration change must be a pull request that goes through the same CI validation pipeline used for product team changes. This creates several benefits: a complete audit trail of who changed what and when, the ability to roll back any change by reverting a commit, and the ability to reproduce the exact platform configuration in a new cluster by applying the Git repository.

The `GoldenPathValidator` is the most important CI check for platform changes. Before merging any update to the golden path template, the validator scaffolds a test service and verifies it builds, tests pass, linting passes, and Kubernetes manifests are valid. This prevents the common failure mode where a golden path update looks correct but silently breaks the generated service for some dependency configuration. Running this validation automatically on every PR prevents the platform team from discovering the breakage only after product teams report failures.

The versioning structure in the `platform-config/golden-paths/go-service/v2/` directory tree is a concrete implementation of the backward compatibility principle. The `v1` directory remains available even after `v2` is current, giving teams that pinned to `v1` time to migrate. The twelve-month support window for deprecated versions is a product commitment, not just a technical decision.

### Senior @ FAANG: GitOps Governance for the Platform Layer

At the senior level, GitOps for the platform introduces governance questions that do not exist for product team repositories.

The `platform-config` repository has restricted write access (platform team only) by design. But "platform team only" must be operationalized precisely: does every platform engineer have direct push access, or are changes gated through pull request review? At FAANG scale, every change to the production platform configuration should require at least one additional review from a senior platform engineer, and changes to foundational components (ArgoCD ApplicationSet manifests, cluster-wide RBAC, network policies) should require sign-off from the platform technical lead. The repository branch protection rules and CODEOWNERS file encode this review policy in an auditable, enforceable way.

The promotion path (staging merge triggers staging apply, production promotion requires a separate PR) is a change management discipline. It creates a mandatory soak period in staging before any platform change reaches production clusters. The duration of the soak period should be calibrated to the blast radius of the change: a new golden path version can soak for 24 hours because its impact is limited to new service creations. A change to the cluster-wide network policy requires a longer soak period (at minimum one full business day) because its impact is immediate and affects all running services.

The `conftest` (OPA policy) check in the CI pipeline is the platform team enforcing its own policies on itself. If the platform requires all deployments to have resource requests and limits, the platform's own deployments must pass the same OPA policy check. This is the "eat your own dog food" principle applied to policy enforcement. A platform that exempts itself from its own policies is not a platform. It is a set of recommendations that the platform team reserves the right to ignore when inconvenient. The conftest check removes that exemption permanently.
