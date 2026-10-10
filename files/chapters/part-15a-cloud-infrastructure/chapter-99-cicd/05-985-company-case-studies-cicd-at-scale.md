## 99.5 Company Case Studies: CI/CD at Scale

### Google: Monorepo with Bazel

Google uses a monorepo with billions of lines of code, built with Bazel:

```yaml
# Google-style CI with Bazel (adapted for GitHub Actions)
name: Bazel CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for affected targets

      - name: Setup Bazel
        uses: bazelbuild/setup-bazelisk@v2

      - name: Mount Bazel cache
        uses: actions/cache@v4
        with:
          path: ~/.cache/bazel
          key: bazel-${{ hashFiles('.bazelversion', 'WORKSPACE', 'BUILD.bazel') }}

      - name: Find affected targets
        id: affected
        run: |
          BASE_SHA=$(git merge-base origin/main HEAD)
          AFFECTED=$(bazel query "rdeps(//..., set($(git diff --name-only $BASE_SHA HEAD)))" 2>/dev/null || echo "//...")
          echo "targets=$AFFECTED" >> $GITHUB_OUTPUT

      - name: Build affected targets
        run: bazel build ${{ steps.affected.outputs.targets }}

      - name: Test affected targets
        run: bazel test ${{ steps.affected.outputs.targets }} --test_output=errors

      - name: Build container images
        if: github.ref == 'refs/heads/main'
        run: |
          bazel run //cmd/server:push_image
```

**Google CI/CD Patterns**:
- Only build/test affected targets (saves hours of build time)
- Hermetic builds with Bazel
- Remote caching across all developers
- Continuous deployment with traffic shifting

### Uber: Multi-Stage Deployment Pipeline

Uber's Go services deploy through multiple stages with automated verification:

```yaml
# Uber-style multi-stage pipeline
name: Deploy Pipeline

on:
  push:
    branches: [main]

env:
  SERVICE_NAME: payment-service

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      image-tag: ${{ steps.build.outputs.tag }}
    steps:
      - uses: actions/checkout@v4

      - name: Build and push
        id: build
        run: |
          TAG=sha-${{ github.sha }}
          docker build -t $ECR_REGISTRY/$SERVICE_NAME:$TAG .
          docker push $ECR_REGISTRY/$SERVICE_NAME:$TAG
          echo "tag=$TAG" >> $GITHUB_OUTPUT

  deploy-canary:
    needs: build
    runs-on: ubuntu-latest
    environment: canary
    steps:
      - name: Deploy canary (1%)
        run: |
          kubectl set image deployment/$SERVICE_NAME-canary \
            $SERVICE_NAME=$ECR_REGISTRY/$SERVICE_NAME:${{ needs.build.outputs.image-tag }}

          # Wait for rollout
          kubectl rollout status deployment/$SERVICE_NAME-canary --timeout=5m

      - name: Run smoke tests
        run: |
          ./scripts/smoke-tests.sh canary.$SERVICE_NAME.svc.cluster.local

      - name: Monitor canary (5 minutes)
        run: |
          ./scripts/monitor-canary.sh \
            --service $SERVICE_NAME \
            --duration 5m \
            --error-threshold 0.1 \
            --latency-p99-threshold 200ms

  deploy-staging:
    needs: [build, deploy-canary]
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - name: Deploy to staging
        run: |
          kubectl --context=staging set image deployment/$SERVICE_NAME \
            $SERVICE_NAME=$ECR_REGISTRY/$SERVICE_NAME:${{ needs.build.outputs.image-tag }}

      - name: Run integration tests
        run: |
          go test -v ./integration/... -tags=integration \
            -env=staging \
            -timeout=10m

  deploy-production:
    needs: [build, deploy-staging]
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Deploy to production (25%)
        run: |
          ./scripts/progressive-rollout.sh \
            --image $ECR_REGISTRY/$SERVICE_NAME:${{ needs.build.outputs.image-tag }} \
            --percentage 25

      - name: Monitor metrics (10 minutes)
        run: |
          ./scripts/production-monitor.sh --duration 10m

      - name: Complete rollout (100%)
        run: |
          ./scripts/progressive-rollout.sh \
            --image $ECR_REGISTRY/$SERVICE_NAME:${{ needs.build.outputs.image-tag }} \
            --percentage 100
```

### Netflix: Spinnaker Pipeline

Netflix's Spinnaker-based deployment for Go services:

```yaml
# Netflix-style Spinnaker pipeline (as manifest)
apiVersion: spinnaker.io/v1alpha2
kind: Pipeline
metadata:
  name: go-service-deploy
spec:
  stages:
    - name: Bake
      type: bake
      ami:
        baseLabel: release
        baseOs: ubuntu
        package: go-service

    - name: Deploy to Test
      type: deploy
      dependsOn: [Bake]
      clusters:
        - account: test
          application: go-service
          capacity:
            desired: 2
            max: 4
            min: 2
          provider: aws

    - name: Chaos Test
      type: runJob
      dependsOn: [Deploy to Test]
      job:
        type: chaosMonkey
        target: go-service
        duration: 30m

    - name: Deploy to Prod (Canary)
      type: canaryAnalysis
      dependsOn: [Chaos Test]
      canary:
        analysisType: realTimeAutomatic
        canaryConfig:
          lifetimeHours: 1
          scoreThresholds:
            marginal: 75
            pass: 90
        metricsAccountName: datadog

    - name: Deploy to Prod (Full)
      type: deploy
      dependsOn: [Deploy to Prod (Canary)]
      clusters:
        - account: prod
          capacity:
            desired: 10
            max: 50
            min: 5
          strategy: redblack
```

### Stripe: Safety-First Deployment

Stripe's deployment pipeline emphasizes safety and compliance:

```yaml
# Stripe-style safe deployment pipeline
name: Safe Deploy

on:
  push:
    branches: [main]

jobs:
  pre-flight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run security scan
        run: |
          govulncheck ./...
          gosec -fmt=sarif -out=security.sarif ./...

      - name: Check for secrets
        run: |
          trufflehog filesystem . --only-verified

      - name: Verify dependencies
        run: |
          go mod verify
          nancy sleuth < go.sum

      - name: Run compliance checks
        run: |
          ./scripts/pci-compliance-check.sh

  test:
    needs: pre-flight
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run tests with race detector
        run: |
          go test -v -race -coverprofile=coverage.out ./...

      - name: Mutation testing
        run: |
          go-mutesting ./...

  deploy:
    needs: test
    runs-on: ubuntu-latest
    environment: production
    steps:
      - name: Request deploy approval
        uses: trstringer/manual-approval@v1
        with:
          secret: ${{ secrets.GITHUB_TOKEN }}
          approvers: sre-team,security-team
          minimum-approvals: 2

      - name: Create deployment record
        run: |
          curl -X POST $DEPLOY_TRACKER_URL \
            -d '{"service": "payments", "sha": "${{ github.sha }}", "deployer": "${{ github.actor }}"}'

      - name: Deploy with automatic rollback
        run: |
          ./scripts/deploy.sh \
            --image $IMAGE \
            --rollback-on-error \
            --error-threshold 1% \
            --monitoring-duration 15m
```

### Amazon: CodePipeline with Blue/Green

Amazon's approach to Go service deployment:

```yaml
# AWS CodePipeline definition
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  Pipeline:
    Type: AWS::CodePipeline::Pipeline
    Properties:
      Name: go-service-pipeline
      RoleArn: !GetAtt PipelineRole.Arn
      Stages:
        - Name: Source
          Actions:
            - Name: Source
              ActionTypeId:
                Category: Source
                Owner: AWS
                Provider: CodeStarSourceConnection
                Version: '1'
              Configuration:
                ConnectionArn: !Ref CodeStarConnection
                FullRepositoryId: myorg/go-service
                BranchName: main

        - Name: Build
          Actions:
            - Name: Build
              ActionTypeId:
                Category: Build
                Owner: AWS
                Provider: CodeBuild
                Version: '1'
              Configuration:
                ProjectName: !Ref BuildProject

        - Name: DeployStaging
          Actions:
            - Name: Deploy
              ActionTypeId:
                Category: Deploy
                Owner: AWS
                Provider: ECS
                Version: '1'
              Configuration:
                ClusterName: staging-cluster
                ServiceName: go-service
                FileName: imagedefinitions.json

        - Name: Approval
          Actions:
            - Name: ManualApproval
              ActionTypeId:
                Category: Approval
                Owner: AWS
                Provider: Manual
                Version: '1'

        - Name: DeployProduction
          Actions:
            - Name: BlueGreenDeploy
              ActionTypeId:
                Category: Deploy
                Owner: AWS
                Provider: CodeDeployToECS
                Version: '1'
              Configuration:
                ApplicationName: go-service-app
                DeploymentGroupName: production
                TaskDefinitionTemplateArtifact: BuildOutput
                AppSpecTemplateArtifact: BuildOutput
```

**CI/CD Comparison Across Companies**:

| Company | Deployment Strategy | Key Feature |
|---------|-------------------|-------------|
| Google | Continuous | Affected target detection, remote caching |
| Uber | Progressive | Canary → Staging → Production |
| Netflix | Automated Canary | Chaos testing, automatic rollback |
| Stripe | Safety-First | Multi-approval, compliance gates |
| Amazon | Blue/Green | Zero-downtime, instant rollback |

---

### Junior → FAANG: Reading CI/CD Case Studies With Appropriate Context

The case studies in this section (Google's Bazel-based monorepo CI, Netflix's chaos engineering, Amazon's blue-green deployments) represent the end state of years of investment by large platform teams. The temptation for junior engineers is to skip directly to these patterns without building the foundational skills first.

The transferable lesson from Google's Bazel adoption: the problem they solved (incremental build correctness and remote caching at monorepo scale) is real, but Bazel's learning curve and operational overhead is significant. The correct path is: understand the problem first (why does my build take 20 minutes?), then evaluate whether the problem is large enough to justify the solution.

The lesson from Netflix's chaos engineering: deliberately injecting failures to test system resilience requires a robust platform foundation first. You cannot chaos-engineer a system that is not observable. Building observability, then building resilience, then validating resilience through chaos is the correct sequence.

### Senior @ FAANG: CI/CD Platform as a Competitive Advantage

At staff level, CI/CD capability is a direct determinant of development velocity and, transitively, of competitive advantage. The case studies demonstrate that the best engineering organizations treat CI/CD as infrastructure deserving the same investment and operational standards as production services.

The shared pattern across all case studies: dedicated platform teams who own the delivery pipeline as a product, invest in it continuously, and measure their performance with explicit SLOs. This is not a property of large companies. It is a property of organizations that recognize delivery velocity as strategically important. A 20-person startup that treats CI/CD as infrastructure rather than configuration will out-deploy a 200-person company that treats it as configuration.

The L6/L7 contribution is making the case for this investment before it is obviously needed. When the engineering team is 50 people and deployment is already slow, making the investment in CI/CD infrastructure is clearly justified. Making the same case at 15 people, before the pain is acute, requires the ability to project forward and quantify the compounding benefit of faster feedback loops. That forward-looking investment thesis is the staff engineer's contribution to organizational strategy.
