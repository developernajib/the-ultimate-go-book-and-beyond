## 99.6 Production Pitfalls: CI/CD Mistakes

### Pitfall 1: No Protection for Main Branch

**Real Incident Report**: A developer pushed directly to main, accidentally including untested code with a critical bug. No one reviewed it, no tests ran, and it was immediately deployed to production via the automatic pipeline. Four hours of downtime before it was discovered.

**The Anti-Pattern**:
- Direct pushes to main/master allowed
- No required reviews
- No status checks before merge
- Automatic deploy from any push

**The Better Approach**:
```yaml
# GitHub branch protection (via API or UI)
# Required settings for main branch:
#
# ✓ Require pull request reviews (at least 1)
# ✓ Require status checks to pass
#   - ci/lint
#   - ci/test
#   - ci/security
# ✓ Require branches to be up to date
# ✓ Include administrators
# ✓ Require linear history
# ✗ Allow force pushes
# ✗ Allow deletions
```

```yaml
# GitHub Actions - CI checks
name: CI
on:
  pull_request:
    branches: [main]

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: golangci/golangci-lint-action@v4

  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
      - run: go test -v -race ./...
```

**Key Insight**: Branch protection prevents accidents. Every change should go through review and automated checks.

### Pitfall 2: Secrets Hardcoded in Pipeline Files

**Real Incident Report**: A team committed AWS credentials directly in their GitHub Actions workflow file. Within minutes, cryptocurrency miners were running on their AWS account. The credentials were in git history even after removal.

**The Anti-Pattern**:
```yaml
# WRONG: Secrets in workflow file
env:
  AWS_ACCESS_KEY_ID: AKIAIOSFODNN7EXAMPLE     # Exposed!
  AWS_SECRET_ACCESS_KEY: wJalrXUtnFEMI/K7MDENG # Exposed!
```

**The Better Approach**:
```yaml
# RIGHT: Secrets from secret store
env:
  AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
  AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}

# BETTER: OIDC for keyless auth
permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789:role/GitHubActions
          aws-region: us-east-1
      # No secrets stored, OIDC federation
```

**Key Insight**: Use secret stores and OIDC federation. Never commit credentials - they will be found.

### Pitfall 3: No Rollback Strategy

**Real Incident Report**: A deployment broke production. The team tried to rollback but realized: their CD pipeline only deployed forward, they didn't tag releases, and they couldn't remember which commit was previously in production. Rollback took 45 minutes instead of 2.

**The Anti-Pattern**:
- Deployments without version tags
- No "rollback" button or process
- No artifact versioning
- Deploy by building from branch

**The Better Approach**:
```yaml
# Tag releases properly
name: Release
on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build and push versioned image
        run: |
          VERSION=${GITHUB_REF#refs/tags/}
          docker build -t myapp:$VERSION .
          docker tag myapp:$VERSION myapp:latest
          docker push myapp:$VERSION
          docker push myapp:latest
```

```bash
# Kubernetes rollback (immediate)
kubectl rollout undo deployment/myapp

# Or rollback to specific revision
kubectl rollout undo deployment/myapp --to-revision=2

# ArgoCD rollback
argocd app rollback myapp
```

**Key Insight**: Every deployment should be reversible in under 5 minutes. Tag images, keep history, practice rollbacks.

### Pitfall 4: Test Environment Differs from Production

**Real Incident Report**: Tests passed in CI, but the app crashed in production. The CI used Go 1.21, production used 1.22. The CI used an in-memory database, production used PostgreSQL. "Works on my machine" extended to "works in CI."

**The Anti-Pattern**:
- Different Go versions in CI vs prod
- Mocked dependencies instead of real ones
- Different OS/architecture
- Missing production configuration

**The Better Approach**:
```yaml
# Pin versions to match production
jobs:
  test:
    runs-on: ubuntu-22.04    # Match production OS
    services:
      postgres:
        image: postgres:18   # Match production version
        env:
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
      redis:
        image: redis:8
        ports:
          - 6379:6379
    steps:
      - uses: actions/setup-go@v5
        with:
          go-version: '1.27.0'  # Exact version match

      - name: Run tests with real dependencies
        env:
          DATABASE_URL: postgres://postgres:test@localhost/test
          REDIS_URL: localhost:6379
        run: go test -v -race ./...
```

**Key Insight**: CI should mirror production as closely as possible. Differences will find you at the worst time.

### Pitfall 5: No Deployment Stages or Gates

**Real Incident Report**: A pipeline deployed directly to production after tests passed. A bug that tests didn't catch went live immediately to all users. There was no staging, no canary, no manual approval - just straight to production.

**The Anti-Pattern**:
```yaml
# WRONG: Direct to production
jobs:
  deploy-prod:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: kubectl apply -k production/
      # Tests pass → immediately in production
```

**The Better Approach**:
```yaml
# RIGHT: Progressive deployment
jobs:
  deploy-staging:
    needs: test
    environment: staging
    runs-on: ubuntu-latest
    steps:
      - run: kubectl apply -k staging/

  integration-test:
    needs: deploy-staging
    runs-on: ubuntu-latest
    steps:
      - run: ./run-integration-tests.sh

  deploy-canary:
    needs: integration-test
    environment:
      name: production-canary
      url: https://canary.example.com
    runs-on: ubuntu-latest
    steps:
      - run: kubectl apply -k canary/  # 10% traffic

  deploy-production:
    needs: deploy-canary
    environment:
      name: production
    runs-on: ubuntu-latest
    steps:
      - run: kubectl apply -k production/
```

**Key Insight**: Staging catches integration issues. Canary catches production-specific issues. Gates catch human judgment needs.

### Quick Reference: CI/CD Anti-Patterns

| Anti-Pattern | Symptom | Fix |
|--------------|---------|-----|
| Unprotected main | Untested code in production | Branch protection, required reviews |
| Hardcoded secrets | Compromised credentials | Secret stores, OIDC federation |
| No rollback plan | 45 min to rollback | Tag releases, keep history, practice |
| CI differs from prod | "Works in CI, breaks in prod" | Match versions, use real dependencies |
| No staging/gates | Bugs go straight to all users | Progressive deployment, approvals |
| No caching | 10 min builds | Cache dependencies, docker layers |

---

### Junior → FAANG: CI/CD Pitfalls as Common First-Job Mistakes

The pitfalls in this list are not hypothetical: they are the actual mistakes that engineers make when setting up their first CI/CD pipeline. The most consequential for career growth is the first one: no protection for the main branch. Merging directly to main without required PR checks is not just a process gap. It demonstrates a lack of understanding of why the process exists.

The second most impactful: hardcoded secrets in pipeline configuration. This is a security incident waiting to happen, and it is embarrassing to explain in a post-mortem. Use OIDC, environment-specific secret stores, or at minimum encrypted secrets with automatic rotation.

First-job habit: before merging your first PR to a new repository, check whether branch protection is configured. If it is not, ask your team lead whether it should be. Raising this question (rather than just leaving it) is a signal of engineering maturity that is noticed.

### Senior @ FAANG: CI/CD Pitfalls as Platform Debt Indicators

At staff level, the presence of these pitfalls in a codebase or organization is a diagnostic signal about platform maturity and technical debt. A survey of these pitfalls across all repositories in an organization reveals where the platform has failed to provide sufficient guardrails.

The remediation strategy is not to fix each repository individually (that does not scale), but to implement platform-level defaults that prevent each pitfall. Branch protection rules can be enforced organization-wide via GitHub organization settings or GitLab group settings, with exceptions requiring explicit override. Secret scanning can be enabled organization-wide. Pipeline caching can be provided by a platform-level cache infrastructure that services opt into.

The measurement of success: run the pitfall audit periodically (quarterly), track the compliance rate, and set a target for each pitfall category. A clear trend of improvement in compliance rate, driven by platform investments rather than manual remediation, is the evidence of effective platform engineering at the organizational level.
