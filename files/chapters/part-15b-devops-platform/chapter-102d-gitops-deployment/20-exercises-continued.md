## 102D.18 Advanced GitOps Exercises

### Exercise 4: ArgoCD ApplicationSet Across Three Environments

**Goal**: Deploy a single Go HTTP service to dev, staging, and prod namespaces from one ApplicationSet definition, demonstrating per-environment customization via Kustomize overlays.

**Setup commands**:

```bash
kind create cluster --name gitops-lab

kubectl create namespace shopapp-dev
kubectl create namespace shopapp-staging
kubectl create namespace shopapp-prod

kubectl create namespace argocd
kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl wait --for=condition=available deployment/argocd-server -n argocd --timeout=120s

# Get the initial admin password
argocd admin initial-password -n argocd
argocd login localhost:8080 --insecure
```

**ApplicationSet** (`appsets/shopapp.yaml`):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: shopapp-all-envs
  namespace: argocd
spec:
  generators:
    - list:
        elements:
          - environment: dev
            namespace: shopapp-dev
          - environment: staging
            namespace: shopapp-staging
          - environment: prod
            namespace: shopapp-prod
  template:
    metadata:
      name: "shopapp-{{environment}}"
    spec:
      project: default
      source:
        repoURL: https://github.com/acme/gitops-config.git
        targetRevision: HEAD
        path: "overlays/{{environment}}"
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{namespace}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
        syncOptions:
          - CreateNamespace=true
```

**Verification sequence**:

```bash
# Confirm all three Applications are created
argocd app list

# Update image tag in dev overlay only
git -C gitops-config checkout -b update-dev-tag
sed -i 's/newTag: .*/newTag: sha-newtest/' overlays/dev/kustomization.yaml
git commit -am "ci: update dev to sha-newtest"
git push

# Wait and verify only dev synced
sleep 180
argocd app get shopapp-dev    # should show sha-newtest
argocd app get shopapp-staging # should still show previous tag

# Test selfHeal: manually scale dev to 0
kubectl scale deploy shopapp -n shopapp-dev --replicas=0
sleep 200
kubectl get deploy shopapp -n shopapp-dev  # ArgoCD should have restored replicas
```

**Expected outcomes**: understand how ApplicationSet generates multiple Applications from a list generator, how Kustomize overlays isolate per-environment changes, and how `selfHeal` reverts manual cluster changes within the reconciliation period.

---

### Exercise 5: Go Promotion Bot - Dev to Staging with Tests

**Goal**: Build a tested Go promotion bot that opens GitHub PRs to advance image tags from dev to staging, demonstrating GitHub API integration and TDD.

**Step 1 - Write tests first**:

```go
// cmd/promotion-bot/promote_test.go
package main

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestReplaceImageTag(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		newTag   string
		expected string
	}{
		{
			name:     "replaces existing tag",
			input:    "images:\n  - name: ghcr.io/acme/shopapp\n    newTag: sha-old123\n",
			newTag:   "sha-new456",
			expected: "images:\n  - name: ghcr.io/acme/shopapp\n    newTag: sha-new456\n",
		},
		{
			name:     "preserves two-space indentation",
			input:    "images:\n  - name: app\n    newTag: v1.0.0\n",
			newTag:   "v2.0.0",
			expected: "images:\n  - name: app\n    newTag: v2.0.0\n",
		},
		{
			name:     "no-op when no newTag line present",
			input:    "images:\n  - name: app\n    digest: sha256:abc\n",
			newTag:   "v1.0.0",
			expected: "images:\n  - name: app\n    digest: sha256:abc\n",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := replaceImageTag(tt.input, tt.newTag)
			require.Equal(t, tt.expected, result)
		})
	}
}

func TestPromotionBranchName(t *testing.T) {
	cfg := Config{FromEnv: "dev", ToEnv: "staging", ImageTag: "sha-abc123"}
	expected := "promote/dev-to-staging-sha-abc123"
	actual := fmt.Sprintf("promote/%s-to-%s-%s", cfg.FromEnv, cfg.ToEnv, cfg.ImageTag)
	assert.Equal(t, expected, actual)
}
```

**Step 2 - Run tests to confirm they fail (TDD red phase)**:

```bash
cd cmd/promotion-bot
go test ./... -v
# Expected: FAIL - replaceImageTag is not yet implemented
```

**Step 3 - Implement `replaceImageTag` and run again (TDD green phase)**:

```bash
go test ./... -v
# Expected: PASS
```

**Step 4 - Run the bot against a real repository**:

```bash
go run ./cmd/promotion-bot/... \
  --owner your-github-username \
  --repo gitops-config \
  --from-env dev \
  --to-env staging \
  --image-tag sha-abc123
```

**Step 5 - Add GitHub Actions integration**:

```yaml
# .github/workflows/promote-dev-to-staging.yaml
name: Promote Dev to Staging
on:
  repository_dispatch:
    types: [dev-healthy]

jobs:
  promote:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: "1.27"
      - name: Run promotion bot
        env:
          GITHUB_TOKEN: ${{ secrets.GITOPS_BOT_TOKEN }}
        run: |
          go run ./cmd/promotion-bot/... \
            --owner ${{ github.repository_owner }} \
            --repo gitops-config \
            --from-env dev \
            --to-env staging \
            --image-tag ${{ github.event.client_payload.image_tag }}
```

**Expected learning outcomes**: experience the full GitHub API interaction for branch creation, file read/update, and PR creation. Understand why `replaceImageTag` uses line-by-line string replacement rather than a YAML round-trip (to preserve comments and ordering). And see how a CI event (ArgoCD webhook) triggers a promotion workflow without direct cluster access.

### Junior → FAANG: Approaching TDD Exercises Seriously

Exercise 5 models TDD correctly: tests written before implementation, then a red phase, then a green phase. This sequence is not ceremonial. It forces you to specify the expected behavior before writing any code, which surfaces ambiguities in the requirement. The `TestReplaceImageTag` function tells you exactly what the function must do in three concrete cases, which makes the implementation straightforward.

For the four-step verification sequence in exercise 4, the `sleep 180` is a teaching moment: the ArgoCD reconciliation loop has a default interval, and you must wait for it. In production, configure a webhook from GitHub to ArgoCD so that reconciliation is triggered immediately on push rather than waiting for the polling interval. The exercises use polling intervals to make the reconciliation loop observable, not because polling is the correct production configuration.

Common exercise mistake: treating the expected outcomes as pass/fail checkboxes rather than as learning objectives. The value of exercise 4 is not that you can run the commands successfully. It is that you understand why the `selfHeal` revert takes approximately 180-200 seconds: ArgoCD polls every 3 minutes by default, and the revert happens at the next polling cycle after the manual change is detected.

### Senior @ FAANG: Exercises as Platform Design Validation

At staff level, these exercises validate design decisions, not implementation skills. The interesting questions for exercise 4 are architectural: what happens to the `shopapp-staging` Application when the `overlays/staging` directory is deleted from the config repository? What happens if two engineers simultaneously update different environment overlays in the same `kustomization.yaml` file? What is the conflict resolution behavior?

Exercise 5's promotion bot is a simplified version of what real organizations build. The staff-level extension: how would you make the promotion bot idempotent so that running it twice does not create two PRs for the same tag? (Answer: check for an existing open PR with the same branch name before creating a new one.) How would you make it handle the case where the target environment's current tag is newer than the tag being promoted? (Answer: treat this as a no-op and log a warning.) How would you add a dry-run mode for testing in CI without creating real PRs? (Answer: accept a `--dry-run` flag that logs the changes instead of committing them.)

The GitHub Actions integration in exercise 5 step 5 uses `repository_dispatch`, which is the correct pattern for cross-repository event triggers. The `dev-healthy` event type is a semantic event that decouples the promotion trigger from the ArgoCD internal event format: if ArgoCD changes its webhook payload structure, only the event dispatcher needs updating, not the promotion workflow. This decoupling is an example of the ports-and-adapters pattern applied to event-driven GitOps automation.

---
