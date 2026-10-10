## 102D.15 Multi-Environment GitOps Promotion Pipeline

A production-grade GitOps pipeline never deploys directly from CI to production. Instead it promotes through environments - each requiring evidence (tests pass, metrics healthy) before advancing. The promotion itself is a pull request: a human or bot opens a PR updating the image tag in the next environment's Kustomize overlay. A reviewer approves. ArgoCD syncs.

### Repository Layout

Separating application source code from deployment configuration is a foundational GitOps practice. The `gitops-config` repository holds only Kustomize overlays and ArgoCD manifests, never application logic. Each environment lives under `overlays/<env>/` and overrides only what differs from the shared `base/`: the image tag, replica count, and resource limits. The `appsets/` directory contains a single ApplicationSet that stamps out one ArgoCD Application per environment, eliminating per-environment boilerplate.

```
gitops-config/
├── base/
│   ├── deployment.yaml          # image: PLACEHOLDER - overridden per env
│   ├── service.yaml
│   └── kustomization.yaml
├── overlays/
│   ├── dev/
│   │   ├── kustomization.yaml   # newTag: sha-abc123 - updated by CI
│   │   └── config.yaml          # replica: 1, small resource limits
│   ├── staging/
│   │   ├── kustomization.yaml   # newTag: sha-abc123 - updated by promotion bot PR
│   │   └── config.yaml          # replica: 2, staging resource limits
│   └── prod/
│       ├── kustomization.yaml   # newTag: sha-abc123 - updated by promotion bot PR
│       └── config.yaml          # replica: 10, full resource limits
└── appsets/
    └── shopapp-appset.yaml      # ApplicationSet generating all 3 env Applications
```

### ArgoCD ApplicationSet - Environment Matrix Generator

An ApplicationSet with a matrix generator removes the need to maintain three nearly identical ArgoCD Application manifests by treating the environment list as data. The outer matrix combines a static `list` generator (one entry per environment with cluster URL and namespace) with a `git files` generator that reads each environment's `config.yaml` directly from the repo, making per-environment configuration fully declarative. Production sets `selfHeal: "false"` so that out-of-band changes to the live cluster are preserved rather than silently reverted, requiring an explicit operator decision to reconcile.

```yaml
# appsets/shopapp-appset.yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: shopapp-environments
  namespace: argocd
spec:
  generators:
    - matrix:
        generators:
          - list:
              elements:
                - environment: dev
                  cluster: https://dev.k8s.acme.internal
                  namespace: shopapp-dev
                  selfHeal: "true"
                - environment: staging
                  cluster: https://staging.k8s.acme.internal
                  namespace: shopapp-staging
                  selfHeal: "false"
                - environment: prod
                  cluster: https://prod.k8s.acme.internal
                  namespace: shopapp-prod
                  selfHeal: "false"
          - git:
              repoURL: https://github.com/acme/gitops-config.git
              revision: HEAD
              files:
                - path: "overlays/{{environment}}/config.yaml"
  template:
    metadata:
      name: "shopapp-{{environment}}"
      annotations:
        notifications.argoproj.io/subscribe.on-sync-succeeded.slack: deployments
        notifications.argoproj.io/subscribe.on-sync-failed.pagerduty: oncall
    spec:
      project: default
      source:
        repoURL: https://github.com/acme/gitops-config.git
        targetRevision: HEAD
        path: "overlays/{{environment}}"
      destination:
        server: "{{cluster}}"
        namespace: "{{namespace}}"
      syncPolicy:
        automated:
          prune: true
          selfHeal: "{{selfHeal}}"
        syncOptions:
          - CreateNamespace=true
          - PrunePropagationPolicy=foreground
          - RespectIgnoreDifferences=true
```

The matrix generator combines a static list (environments) with a Git files generator (reads per-environment config.yaml for replica counts, resource limits). Each combination produces one Application. Production has `selfHeal: "false"` - manual changes to the prod cluster are not automatically reverted, requiring an explicit operator sync decision.

### Kustomize Overlay - Staging Example

Each overlay references the shared `base/` through a relative path and applies only the environment-specific differences as patches. The `images` transformer is the key promotion mechanism: the promotion bot changes the single `newTag` value here and ArgoCD detects the diff on the next sync cycle. A `configMapGenerator` injects environment-specific values such as `LOG_LEVEL` and `ENVIRONMENT` without touching the base manifests, keeping the base truly environment-agnostic.

```yaml
# overlays/staging/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: shopapp-staging
commonLabels:
  environment: staging
resources:
  - ../../base
patches:
  - path: config.yaml
images:
  - name: ghcr.io/acme/shopapp
    newTag: sha-abc123          # promotion bot updates this line via PR
configMapGenerator:
  - name: shopapp-env
    literals:
      - LOG_LEVEL=info
      - ENVIRONMENT=staging
```

### Go Promotion Bot - Full Implementation

The bot runs as a GitHub Actions job after the dev ArgoCD Application reaches `Healthy`. It opens a PR updating `overlays/staging/kustomization.yaml` with the new image tag. A reviewer merges the PR. ArgoCD syncs staging automatically.

```go
// cmd/promotion-bot/main.go
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/google/go-github/v62/github"
	"go.uber.org/zap"
	"golang.org/x/oauth2"
)

// Config holds all promotion parameters.
type Config struct {
	Owner      string
	Repo       string
	FromEnv    string
	ToEnv      string
	ImageTag   string
	BaseBranch string
}

func main() {
	log, _ := zap.NewProduction()
	defer log.Sync() //nolint:errcheck

	cfg := Config{}
	flag.StringVar(&cfg.Owner, "owner", "", "GitHub organization or user name")
	flag.StringVar(&cfg.Repo, "repo", "", "GitOps config repository name")
	flag.StringVar(&cfg.FromEnv, "from-env", "dev", "Source environment")
	flag.StringVar(&cfg.ToEnv, "to-env", "staging", "Target environment")
	flag.StringVar(&cfg.ImageTag, "image-tag", "", "Docker image tag to promote")
	flag.StringVar(&cfg.BaseBranch, "base-branch", "main", "Base branch for the PR")
	flag.Parse()

	token := os.Getenv("GITHUB_TOKEN")
	if token == "" {
		log.Fatal("GITHUB_TOKEN environment variable is required")
	}
	if cfg.Owner == "" || cfg.Repo == "" || cfg.ImageTag == "" {
		log.Fatal("--owner, --repo, and --image-tag are required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	ts := oauth2.StaticTokenSource(&oauth2.Token{AccessToken: token})
	gh := github.NewClient(oauth2.NewClient(ctx, ts))

	bot := &PromotionBot{gh: gh, cfg: cfg, log: log}
	if err := bot.Promote(ctx); err != nil {
		log.Fatal("promotion failed", zap.Error(err))
	}
}

// PromotionBot encapsulates all GitHub API operations for one promotion event.
type PromotionBot struct {
	gh  *github.Client
	cfg Config
	log *zap.Logger
}

// Promote creates a branch, patches the kustomization file, and opens a PR.
func (b *PromotionBot) Promote(ctx context.Context) error {
	branchName := fmt.Sprintf("promote/%s-to-%s-%s",
		b.cfg.FromEnv, b.cfg.ToEnv, b.cfg.ImageTag)

	// 1. Resolve the HEAD SHA of the base branch.
	ref, _, err := b.gh.Git.GetRef(ctx, b.cfg.Owner, b.cfg.Repo,
		"refs/heads/"+b.cfg.BaseBranch)
	if err != nil {
		return fmt.Errorf("get base branch ref: %w", err)
	}
	baseSHA := ref.Object.GetSHA()

	// 2. Create a promotion branch.
	newRef := &github.Reference{
		Ref:    github.String("refs/heads/" + branchName),
		Object: &github.GitObject{SHA: github.String(baseSHA)},
	}
	if _, _, err = b.gh.Git.CreateRef(ctx, b.cfg.Owner, b.cfg.Repo, newRef); err != nil {
		return fmt.Errorf("create branch %s: %w", branchName, err)
	}
	b.log.Info("created promotion branch", zap.String("branch", branchName))

	// 3. Read the current kustomization for the target environment.
	filePath := fmt.Sprintf("overlays/%s/kustomization.yaml", b.cfg.ToEnv)
	fileContent, _, _, err := b.gh.Repositories.GetContents(
		ctx, b.cfg.Owner, b.cfg.Repo, filePath,
		&github.RepositoryContentGetOptions{Ref: branchName},
	)
	if err != nil {
		return fmt.Errorf("read %s: %w", filePath, err)
	}

	current, err := fileContent.GetContent()
	if err != nil {
		return fmt.Errorf("decode file content: %w", err)
	}

	// 4. Patch the newTag line.
	updated := replaceImageTag(current, b.cfg.ImageTag)
	if updated == current {
		b.log.Warn("image tag already current - nothing to promote",
			zap.String("tag", b.cfg.ImageTag))
		return nil
	}

	// 5. Commit the change.
	commitMsg := fmt.Sprintf("chore(promote): %s to %s tag %s",
		b.cfg.FromEnv, b.cfg.ToEnv, b.cfg.ImageTag)
	opts := &github.RepositoryContentFileOptions{
		Message: github.String(commitMsg),
		Content: []byte(updated),
		SHA:     fileContent.SHA,
		Branch:  github.String(branchName),
	}
	if _, _, err = b.gh.Repositories.UpdateFile(
		ctx, b.cfg.Owner, b.cfg.Repo, filePath, opts,
	); err != nil {
		return fmt.Errorf("commit updated kustomization: %w", err)
	}

	// 6. Open the pull request.
	prTitle := fmt.Sprintf("Promote %s to %s (tag: %s)",
		b.cfg.FromEnv, b.cfg.ToEnv, b.cfg.ImageTag)
	prBody := fmt.Sprintf(
		"## Automated Promotion\n\n"+
			"- **From**: `%s`\n- **To**: `%s`\n- **Image tag**: `%s`\n\n"+
			"Opened automatically after `%s` passed all health checks.\n"+
			"Merge this PR to trigger ArgoCD sync on `%s`.",
		b.cfg.FromEnv, b.cfg.ToEnv, b.cfg.ImageTag,
		b.cfg.FromEnv, b.cfg.ToEnv,
	)
	pr, _, err := b.gh.PullRequests.Create(ctx, b.cfg.Owner, b.cfg.Repo,
		&github.NewPullRequest{
			Title:               github.String(prTitle),
			Body:                github.String(prBody),
			Head:                github.String(branchName),
			Base:                github.String(b.cfg.BaseBranch),
			MaintainerCanModify: github.Bool(true),
		})
	if err != nil {
		return fmt.Errorf("create pull request: %w", err)
	}
	b.log.Info("pull request created",
		zap.String("url", pr.GetHTMLURL()),
		zap.Int("number", pr.GetNumber()))
	return nil
}

// replaceImageTag swaps the newTag value in a kustomization YAML string.
// Preserves indentation and comments - does not require a full YAML round-trip.
func replaceImageTag(content, newTag string) string {
	lines := strings.Split(content, "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "newTag:") {
			indent := line[:len(line)-len(strings.TrimLeft(line, " \t"))]
			lines[i] = indent + "newTag: " + newTag
		}
	}
	return strings.Join(lines, "\n")
}
```

### Junior → FAANG: Understanding the Promotion Pipeline as a Gate System

The promotion pipeline in this file is a sequence of gates, each requiring evidence before the next environment receives the new version. The key insight: promotion is not automatic. CI can only update the dev overlay automatically. All subsequent promotions are pull requests that require human review. This means the commit diff for a staging promotion is always one line (the `newTag` value), which makes review fast and unambiguous.

The `replaceImageTag` function uses line-by-line string replacement rather than a YAML round-trip for a reason worth understanding. YAML round-trips through a Go parser can reorder keys, strip comments, and change quote styles. A PR that changes 40 lines of whitespace and key ordering in a kustomization.yaml file is difficult to review, even if the only meaningful change is the image tag. String replacement preserves the file structure exactly, making diffs minimal and review friction low.

For a first implementation, the promotion bot pattern is approachable: it is a Go program that uses the GitHub API to create a branch, update a file, and open a PR. The `go-github` library handles all the API interaction. The most common debugging issue is GitHub token permissions: the bot token needs `repo` scope to create branches and open PRs on private repositories.

### Senior @ FAANG: Multi-Environment Promotion as an Organizational Interface

At staff level, the promotion pipeline is the interface between the development team and the platform team. The design decisions made here determine how much friction engineers experience shipping features and how much visibility platform engineers have into what is running where.

The self-heal configuration asymmetry in the ApplicationSet is a deliberate governance choice: dev uses `selfHeal: true` (the cluster must always match Git, unauthorized changes are reverted), while staging and prod use `selfHeal: false` (operators can make temporary adjustments without being immediately reverted). This asymmetry represents a trade-off between platform discipline and operational flexibility. At FAANG, the correct choice for production is often environment-dependent: stateless services benefit from `selfHeal: true` because any drift is likely unauthorized, while stateful services with complex operational procedures may need `selfHeal: false` to allow emergency interventions without triggering immediate reversion.

The matrix generator combining a list of environments with a git files generator is a sophisticated ApplicationSet pattern worth understanding deeply. The git files generator reads `config.yaml` from each environment's overlay directory, making the per-environment configuration fully declarative without duplicating it in the ApplicationSet manifest. This means adding a new configuration parameter for all environments requires only: adding the field to each environment's `config.yaml`, updating the ApplicationSet template to use the new field, and letting the ApplicationSet controller regenerate all Application objects. Compare this to the alternative of updating a centralized list in the ApplicationSet manifest every time any environment's configuration changes, and the scalability advantage of the git files generator becomes clear.

The promotion bot PR body includes a structured summary of what changed and why. At scale, PRs in the manifests repository accumulate quickly: a platform with 50 services, 3 environments, and daily deployments generates 100+ promotion PRs per week. The PR body format must be consistent enough to parse programmatically and informative enough for humans to review in under 30 seconds. Standardizing the PR body format across all promotion bots in the organization is a platform team responsibility that compounds in value as the fleet grows.

---
