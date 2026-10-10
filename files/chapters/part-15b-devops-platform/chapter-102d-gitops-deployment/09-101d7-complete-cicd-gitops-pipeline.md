## 102D.7 Complete CI/CD + GitOps Pipeline

### GitHub Actions Workflow

This pipeline implements the GitOps promotion pattern: the CI job builds and pushes a Docker image, then opens a pull request against the GitOps manifests repository to update the image tag. ArgoCD detects the merged PR and reconciles the cluster. The two-repository pattern (application code repo separate from GitOps manifests repo) is intentional. It keeps deployment history in a dedicated audit trail and prevents application developers from accidentally modifying cluster configuration files.

```yaml
# .github/workflows/deploy.yaml
name: Build and Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  ECR_REGISTRY: 123456789.dkr.ecr.us-east-1.amazonaws.com
  ECR_REPOSITORY: shopapp-api
  K8S_MANIFESTS_REPO: myorg/k8s-manifests

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'
          cache: true

      - name: Run tests
        run: go test ./... -race -coverprofile=coverage.out

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          files: coverage.out

  build:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    outputs:
      image-tag: ${{ steps.meta.outputs.version }}
    steps:
      - uses: actions/checkout@v4

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: us-east-1

      - name: Login to ECR
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push Docker image
        id: build
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: |
            ${{ env.ECR_REGISTRY }}/${{ env.ECR_REPOSITORY }}:${{ github.sha }}
            ${{ env.ECR_REGISTRY }}/${{ env.ECR_REPOSITORY }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
          build-args: |
            GO_VERSION=1.26
            BUILD_VERSION=${{ github.sha }}

  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - name: Checkout manifests repo
        uses: actions/checkout@v4
        with:
          repository: ${{ env.K8S_MANIFESTS_REPO }}
          token: ${{ secrets.MANIFESTS_GITHUB_TOKEN }}

      - name: Update image tag for staging
        run: |
          cd apps/shopapp/overlays/staging
          kustomize edit set image myorg/shopapp-api=${{ env.ECR_REGISTRY }}/${{ env.ECR_REPOSITORY }}:${{ github.sha }}

      - name: Commit and push
        run: |
          git config user.email "ci@myorg.com"
          git config user.name "CI Bot"
          git add .
          git commit -m "chore: update shopapp-api to ${{ github.sha }} in staging

          Triggered by: ${{ github.actor }}
          PR: ${{ github.event.pull_request.html_url }}"
          git push

      - name: Wait for ArgoCD sync
        run: |
          # ArgoCD CLI checks sync status
          argocd app wait shopapp-staging \
            --sync \
            --health \
            --timeout 300 \
            --server ${{ secrets.ARGOCD_SERVER }} \
            --auth-token ${{ secrets.ARGOCD_AUTH_TOKEN }}

      - name: Run integration tests
        run: |
          go test ./test/integration/... \
            -run TestStagingSmoke \
            -v \
            -timeout 5m
        env:
          API_BASE_URL: https://staging.shopapp.com

  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment: production  # requires manual approval in GitHub
    steps:
      - name: Checkout manifests repo
        uses: actions/checkout@v4
        with:
          repository: ${{ env.K8S_MANIFESTS_REPO }}
          token: ${{ secrets.MANIFESTS_GITHUB_TOKEN }}

      - name: Update image tag for production
        run: |
          cd apps/shopapp/overlays/production
          kustomize edit set image myorg/shopapp-api=${{ env.ECR_REGISTRY }}/${{ env.ECR_REPOSITORY }}:${{ github.sha }}

      - name: Commit and push
        run: |
          git config user.email "ci@myorg.com"
          git config user.name "CI Bot"
          git add .
          git commit -m "deploy: shopapp-api ${{ github.sha }} to production

          Deployed by: ${{ github.actor }}
          Commit: ${{ github.event.head_commit.message }}"
          git push

      # ArgoCD auto-syncs production (or trigger manual sync)
      - name: Trigger ArgoCD sync
        run: |
          argocd app sync shopapp-production \
            --server ${{ secrets.ARGOCD_SERVER }} \
            --auth-token ${{ secrets.ARGOCD_AUTH_TOKEN }} \
            --timeout 600
```

### Sealed Secrets for GitOps

Sealed Secrets solves the fundamental GitOps problem of secret management: raw Kubernetes Secrets cannot be committed to Git, but GitOps requires all cluster state to live in a repository. The `kubeseal` CLI encrypts a Secret using the controller's public key, producing a `SealedSecret` CRD that only the in-cluster controller can decrypt with the matching private key. This means sealed secret files are safe to commit, review in pull requests, and store in version history alongside all other manifests.

```bash
# Install sealed-secrets controller
helm install sealed-secrets sealed-secrets/sealed-secrets -n kube-system

# Seal a secret (can be committed to Git safely)
kubectl create secret generic db-credentials \
  --from-literal=password=SuperSecret123 \
  --dry-run=client -o yaml | \
  kubeseal --cert=pub-cert.pem \
    --namespace=shopapp-production \
    --name=db-credentials \
    -o yaml > sealed-db-credentials.yaml

# sealed-db-credentials.yaml can now be committed to Git
# The sealed-secrets controller decrypts it inside the cluster
```

### Junior → FAANG: Reading the Pipeline YAML as a Sequence of Contracts

The GitHub Actions workflow in this file has three jobs that form a contract: `test` must pass before `build` runs, `build` must succeed on `main` before `deploy-staging` triggers, and `deploy-staging` must complete before `deploy-production` is unlocked. Reading CI configuration this way, as a dependency graph, is how experienced engineers debug pipeline failures quickly.

The two-repository pattern is the most important structural choice in this pipeline. CI has a token to write to the manifests repository but has no kubeconfig. The manifests repository has no application code but controls what runs in the cluster. This separation means a compromised CI token can commit bad manifests (which will be reviewed before merge) but cannot directly modify the cluster. A compromised cluster credential (which does not exist in CI) would be needed for a direct cluster attack.

For a first implementation, the most common mistake is committing manifests without configuring git user email and name, causing the commit to fail silently or succeed with an anonymous author that breaks audit requirements. Always configure `git config user.email` and `git config user.name` explicitly in the CI step, using a machine account identity that is recognizable in the manifest repository's commit history.

### Senior @ FAANG: Pipeline Design as Deployment Policy Enforcement

The CI/CD pipeline is the enforcement point for deployment policy. At senior level, the pipeline YAML is not just automation: it is a codified representation of the organization's deployment governance. Changes to the pipeline must go through the same review process as changes to the application, because pipeline changes can bypass all the safety gates.

The `environment: production` gate in GitHub Actions is the integration between GitOps and human approval workflows. This gate requires an authorized human to review the staging test results and click "Approve" before the production job runs. At FAANG, this gate is often connected to a change management system: the approval action creates a change record, and the completion action closes it. The Git commit that updates the production overlay contains the change record ID in its message, creating a traceable link between the deployment event and its approval.

The Sealed Secrets approach shown here has a rotation problem that warrants an ADR note. When the Sealed Secrets controller's private key is rotated (which should happen periodically as a security practice), all existing sealed secrets become unreadable. The rotation process requires re-sealing every secret with the new public key before the old key is removed. For organizations with hundreds of sealed secrets across dozens of namespaces, this is a painful manual process. External Secrets Operator avoids this problem entirely: the secret store handles rotation, and the Kubernetes Secret is regenerated automatically on the next refresh interval. Teams that start with Sealed Secrets should have an explicit migration plan to External Secrets Operator documented before they exceed the threshold where Sealed Secrets rotation becomes operationally burdensome (typically around 20-30 distinct secrets across 3 or more clusters).

---
