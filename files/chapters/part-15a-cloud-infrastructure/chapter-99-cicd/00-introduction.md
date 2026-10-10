# Chapter 99: CI/CD for Go Applications

> *"Every manual deployment is a liability. The goal of CI/CD is not just automation - it's removing human error from the critical path between a commit and production."*

Continuous Integration and Continuous Delivery are the engineering disciplines that transform a codebase from a collection of source files into a living, always-deployable product. For Go teams, CI/CD is particularly powerful because Go's toolchain was designed with automation in mind: `go test` produces machine-readable output, `go vet` and `staticcheck` integrate cleanly into pipeline steps, and the compilation model produces a single binary artifact that needs no packaging ritual before deployment. A well-designed Go CI/CD pipeline can take a commit from push to production Kubernetes deployment in under five minutes while maintaining a complete audit trail of every build, test result, security scan, and deployment event.

GitHub Actions has become the dominant platform for Go open-source and commercial projects alike, offering Go-specific caching for module downloads and build artifacts that can reduce CI times from minutes to seconds. But pipeline speed is only part of the story. The real value of CI/CD is the gate it provides: every pull request runs the full test suite, race detector, linter, security scanner (using `govulncheck` and Trivy), and integration tests before a single line merges to main. This creates a feedback loop tight enough that engineers trust the main branch to always be deployable - enabling the cultural shift from quarterly releases to multiple deployments per day.

Release automation and GitOps complete the picture. Semantic versioning with `goreleaser` produces cross-platform binaries, signed container images, and GitHub Releases with automated changelogs from conventional commits. ArgoCD watching a Git repository of Kubernetes manifests means that a merged pull request to the infrastructure repo is the deployment mechanism - no kubectl commands run by humans, no configuration drift, no "who deployed what on Friday afternoon" mysteries. This chapter walks you through building a complete, production-grade CI/CD system for Go from first principles.

**What you'll learn in this chapter:**

- How to structure GitHub Actions workflows for Go projects with proper job dependencies, secrets management, and matrix builds across multiple Go versions and platforms
- How to configure Go module and build caching in CI to reduce pipeline execution time from minutes to seconds
- How to parallelize test execution with `gotestsum` and split long-running test suites across multiple CI runners
- How to automate Docker image builds with multi-platform support (`linux/amd64`, `linux/arm64`) and push to container registries with digest-based immutable tags
- How to integrate `govulncheck`, `staticcheck`, `golangci-lint`, and Trivy into PR gates that block merges on security findings
- How to implement automated semantic versioning and release artifact generation with `goreleaser`, including signed binaries and SBOMs
- How to set up GitOps-based deployments with ArgoCD that reconcile Kubernetes state from Git, eliminating manual `kubectl apply` workflows
- How to implement canary and blue-green deployment strategies in your pipeline with automated rollback on health check failures

**Why this matters at scale:**

Google's internal build system (Blaze, open-sourced as Bazel) executes millions of builds and hundreds of millions of test runs per day, with Go being one of the primary supported languages - the engineering investment in fast, reliable CI is foundational to Google's engineering velocity. Shopify runs thousands of CI pipelines per day for its Go-based payment processing services, with a policy that no deploy reaches production without passing a full suite of security scans. HashiCorp uses `goreleaser` for all of its Go tooling (Terraform, Vault, Consul), producing signed, multi-platform releases with SBOMs as a standard part of every version release. Weaveworks (creators of Flux) pioneered GitOps specifically to eliminate configuration drift in large Kubernetes deployments running Go-based microservices.

**Prerequisites:** Chapters 96-97 (Docker and Kubernetes), a GitHub account, and familiarity with Go testing from Part 4.

---

### Junior → FAANG: CI/CD as Engineering Discipline, Not Configuration

Many engineers treat CI/CD as configuration that runs automatically. The more accurate framing: CI/CD is the delivery pipeline that determines how quickly and safely you can respond to production incidents, release new features, and adopt dependency updates. Its reliability and speed directly affect team productivity.

The practical foundation to build first: a pipeline that fails on test failures, fails on `go vet` violations, builds a multi-stage Docker image, and pushes it to a registry on merge. Get this working end to end before adding any complexity. The most common junior mistake is building a complex pipeline with many stages before verifying that the basic flow works reliably.

First-job habit: treat pipeline failures as blocking. A CI failure that is dismissed with "it is just a flaky test" or "the environment was down" is technical debt that accumulates into a culture of ignoring CI. Fix flaky tests or mark them explicitly, never bypass them.

### Senior @ FAANG: CI/CD as a Platform Product With Internal SLOs

At staff level, the CI/CD system is a platform product. Its customers are the entire engineering organization, and its SLOs are: median pipeline duration (from push to deployment-ready artifact), pipeline availability, and flaky test rate (percentage of pipeline failures that are not caused by real defects in the changed code).

FAANG-scale CI/CD involves thousands of pipeline runs per day across hundreds of services. At that scale, a 10% flaky test rate means hundreds of false failures per day, which means hundreds of engineers re-running pipelines, losing trust in the system, and shipping less frequently. Managing flaky test rate as an organizational metric is an L6/L7 concern that requires investment in test infrastructure (flake detection, automatic quarantine, flake attribution to the team that owns the test).

The pipeline reliability and performance architecture at scale: remote build caches, distributed test execution with parallelism, artifact promotion workflows (test once, deploy many times without rebuilding), and progressive delivery integration. The staff engineer who designs and operates this system is creating leverage that compounds with every team and every deployment.
