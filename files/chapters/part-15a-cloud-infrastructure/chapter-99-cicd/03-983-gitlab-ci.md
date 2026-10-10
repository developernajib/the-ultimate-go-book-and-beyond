## 99.3 GitLab CI

GitLab CI defines its pipeline in a `.gitlab-ci.yml` file at the repository root, organizing work into ordered stages that run sequentially while jobs within the same stage execute in parallel. Each job specifies a Docker image to run in, giving you precise control over the Go version and tooling available at each stage. The pipeline below separates concerns into lint, test, security, build, and deploy stages, with the production deployment gated behind a manual approval step to prevent accidental rollouts.

```yaml
# .gitlab-ci.yml
stages:
  - lint
  - test
  - security
  - build
  - deploy

variables:
  GO_VERSION: "1.22"

lint:
  stage: lint
  image: golang:${GO_VERSION}
  script:
    - go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
    - golangci-lint run

test:
  stage: test
  image: golang:${GO_VERSION}
  services:
    - postgres:18
  variables:
    DATABASE_URL: postgres://postgres:password@postgres:5432/testdb
    POSTGRES_PASSWORD: password
    POSTGRES_DB: testdb
  script:
    - go test -v -race -coverprofile=coverage.out ./...
    - go tool cover -func=coverage.out
  coverage: '/total:\s+\(statements\)\s+(\d+.\d+)%/'
  artifacts:
    reports:
      coverage_report:
        coverage_format: cobertura
        path: coverage.xml

security:
  stage: security
  image: golang:${GO_VERSION}
  script:
    - go install golang.org/x/vuln/cmd/govulncheck@latest
    - govulncheck ./...

build:
  stage: build
  image: docker:24
  services:
    - docker:24-dind
  script:
    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA .
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA
  only:
    - main

deploy:staging:
  stage: deploy
  image: bitnami/kubectl:latest
  script:
    - kubectl set image deployment/myapp myapp=$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA -n staging
  environment:
    name: staging
  only:
    - main

deploy:production:
  stage: deploy
  image: bitnami/kubectl:latest
  script:
    - kubectl set image deployment/myapp myapp=$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA -n production
  environment:
    name: production
  when: manual
  only:
    - main
```

---

### Junior → FAANG: GitLab CI Fundamentals and When to Choose It

GitLab CI uses a YAML pipeline configuration with a stages list that controls job ordering. Jobs within the same stage run in parallel. Stages run sequentially. This model is straightforward and predictable. The key GitLab CI concepts for Go: `image` selects the Docker image for each job (use a specific `golang:1.27.1` tag, not `latest`), `cache` preserves the module download cache between runs, and `artifacts` passes build outputs between jobs.

The choice between GitLab CI and GitHub Actions is often predetermined by your organization's source control choice. If your org uses GitLab, use GitLab CI. If it uses GitHub, use GitHub Actions. The conceptual model is similar. The YAML syntax differs. The more important skills are pipeline design principles that transfer between platforms.

First-job habit: use GitLab CI includes to share pipeline configuration across repositories. Defining common jobs (lint, test, security scan) in a central template repository and including them in each service's `.gitlab-ci.yml` prevents duplication and ensures updates to shared jobs propagate automatically.

### Senior @ FAANG: GitLab CI at Scale and Pipeline Template Governance

At staff level, GitLab CI at scale requires a pipeline template governance model. With 200 services each having their own `.gitlab-ci.yml`, the shared functionality drifts: some services have security scanning, others do not. Some use the latest Go version, others are pinned to an outdated version. The solution is enforced includes from a centralized template maintained by the platform team.

GitLab's compliance pipelines (a GitLab Ultimate feature) take this further: they inject mandatory jobs into every pipeline in the group, regardless of what the service's own `.gitlab-ci.yml` specifies. This is the enforcement mechanism for mandatory security gates (SAST, container scanning, dependency scanning) that every service must run, even if the service team did not configure them explicitly. This is the platform team's tool for ensuring that no service reaches production without having passed the required security checks.

The runner infrastructure decision for GitLab is the same as for GitHub Actions: self-hosted runners on Kubernetes (via the GitLab Runner Kubernetes executor) for control, performance, and access to internal resources. The autoscaling strategy and the runner security model (which secrets can runners access, how are runner credentials rotated) are platform team responsibilities.
