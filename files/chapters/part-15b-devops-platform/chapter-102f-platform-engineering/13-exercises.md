## 102F.11 Guided Exercises and Solutions

### Exercise 1: Backstage Service Catalog

Set up local Backstage and:
1. Create catalog entries for 3 services with different owners and dependencies
2. Add TechDocs documentation for one service
3. Install the GitHub Actions plugin to show CI/CD status in Backstage
4. Create a simple Scaffolding template that generates a `catalog-info.yaml`

### Exercise 2: Platform API

Build a simplified platform API in Go that:
1. `POST /environments` - creates a Kubernetes namespace with ResourceQuota, LimitRange, and default NetworkPolicy
2. `GET /environments/{name}/status` - returns namespace resource usage vs quota
3. `DELETE /environments/{name}` - deletes namespace and all resources
4. Include Prometheus metrics: environment_provisioned_total, provision_duration_seconds
5. Test with testcontainers-go using a real kind cluster

### Exercise 3: Self-Service CI/CD Template

Create a GitHub Actions reusable workflow (the platform's golden CI/CD path) that:
1. Runs Go tests with race detection
2. Builds Docker image (multi-stage, distroless)
3. Scans image with Trivy
4. Pushes to ECR
5. Updates image tag in Kustomize manifests repo
6. Triggers ArgoCD sync
7. Runs smoke tests post-deploy
Teams use it with: `uses: myorg/platform/.github/workflows/go-service.yml@v2`

### Junior → FAANG: How to Approach These Exercises to Build Interview Credibility

These three exercises are calibrated to give you artifacts you can reference in interviews. Completing Exercise 1 (Backstage service catalog) gives you a concrete answer when asked "have you worked with Backstage?" Completing Exercise 2 (Platform API) gives you a Go implementation you can walk through in a technical interview. Completing Exercise 3 (CI/CD template) gives you a direct answer to "how would you design a self-service deployment pipeline?"

For Exercise 2, the most important implementation detail is the Prometheus metrics. Adding `environment_provisioned_total` and `provision_duration_seconds` before you write the provisioning logic (test-driven instrumentation) trains the habit of making observability a first-class concern rather than an afterthought. The distinction between counters (total provisioned, errors) and histograms (duration distribution) is a technical interview question about Prometheus metric types.

For Exercise 3, the `@v2` version pin in the `uses` field is intentional. Reusable workflows are versioned like libraries. If the platform team pushes a breaking change to the main branch, every workflow that pins to main breaks immediately. Pinning to a version tag means teams opt into upgrades deliberately, giving them time to test compatibility. This is the same versioning discipline that applies to golden path templates.

### Senior @ FAANG: What These Exercises Reveal About Platform Maturity

The three exercises here represent three maturity stages of a platform program.

Exercise 1 (Backstage catalog) is stage one: discoverability. The platform makes it easy to find what exists, who owns it, and where its documentation lives. Many organizations stop here and call it a "developer portal," but without self-service capabilities, the portal is a wiki with a better UI.

Exercise 2 (Platform API) is stage two: self-service provisioning. Developers can create environments and onboard services without opening a ticket. This is where the platform delivers its first measurable time savings: the onboarding time metric drops from days to minutes.

Exercise 3 (CI/CD reusable workflow) is stage three: standardized delivery. Every service uses the same CI pipeline, which means every service benefits from improvements (new security scanning step, faster caching strategy) and every incident (CVE in a base image) can be remediated in one place rather than across hundreds of repositories.

A staff engineer evaluating a platform program should verify all three stages are present before investing in more advanced capabilities (Crossplane, preview environments, DORA dashboards). Organizations that skip to advanced capabilities without solid foundations in discoverability, self-service, and standardized delivery will find that adoption stagnates because the platform is not solving the foundational problems developers actually encounter every day.
