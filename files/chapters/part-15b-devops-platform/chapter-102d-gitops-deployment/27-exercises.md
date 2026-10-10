## Exercises

### Exercise 1: Bootstrap a Local GitOps Environment

Set up a complete local GitOps environment from scratch.

1. Install `kind` and create a 3-node cluster:
 ```bash
   kind create cluster --config - <<EOF
   kind: Cluster
   apiVersion: kind.x-k8s.io/v1alpha4
   nodes:
     - role: control-plane
     - role: worker
     - role: worker
   EOF
   ```
2. Install ArgoCD: `kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml`
3. Create a public GitHub repository with a `base/` directory containing a Go HTTP server Deployment (3 replicas), Service, and HPA.
4. Create an ArgoCD Application pointing to your repository with `selfHeal: true` and `automated.prune: true`.
5. Verify the Application deploys automatically. Run `kubectl scale deployment my-app --replicas=0` and observe ArgoCD revert it within 3 minutes.
6. Commit a change (modify a ConfigMap value or change resource limits) and verify ArgoCD picks it up without any manual action.

**Expected outcome:** understand the full GitOps reconciliation loop and observe self-heal correcting unauthorized changes.

### Exercise 2: Canary Deployment with Automated Rollback

Extend Exercise 1 with metric-driven canary deployment.

1. Install Argo Rollouts: `kubectl apply -n argo-rollouts -f https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml`
2. Convert your Deployment to an Argo Rollout with canary steps: 10% → 30% → 50% → 100%, with 2-minute pauses between steps.
3. Install `kube-prometheus-stack` via Helm to get Prometheus and Grafana.
4. Instrument your Go service with `github.com/prometheus/client_golang` to expose `http_requests_total{status_code}`.
5. Create an `AnalysisTemplate` that fails if the canary error rate exceeds 2%.
6. Build a "buggy" v2 that returns HTTP 500 for 15% of requests (use `math/rand`).
7. Trigger a rollout to v2 and observe the `AnalysisRun` detect the elevated error rate, abort the rollout, and restore v1 - all without any human action.

**Expected outcome:** observe fully automated metric-driven rollback working end-to-end.

### Exercise 3: Multi-Environment Promotion Pipeline

Build a complete promotion pipeline across three environments.

1. Create a Kustomize structure with `base/`, `overlays/dev/`, `overlays/staging/`, and `overlays/production/`. Each overlay sets different replica counts, resource limits, and ingress hostnames.
2. Create three ArgoCD Applications: dev (fully automated), staging (automated with self-heal), production (manual sync only - requires SRE approval).
3. Write a GitHub Actions workflow with three stages:
 - On push to `main`: update the dev overlay image tag, commit, and push - triggers automatic dev sync.
 - On `promote-to-staging` label added to a PR: update the staging overlay, open a review PR.
 - On `promote-to-production` label: open a PR against the production overlay requiring 2 reviewers.
4. Configure branch protection on the production overlay directory.
5. Walk a real change through all three environments, noting how time-to-deploy differs between environments.

**Expected outcome:** understand how to balance automation with governance across environment tiers.

### Exercise 4: Build and Deploy the Custom Go GitOps Controller

Implement the controller from this chapter and run it against a real cluster.

1. Scaffold with kubebuilder: `kubebuilder init --domain example.com --repo github.com/you/gitops-controller`
2. Create the API: `kubebuilder create api --group gitops --version v1alpha1 --kind GitOpsApp`
3. Implement the reconciler. Add Prometheus metrics:
 - Counter: `gitops_syncs_total{app, namespace, status}` - increment on every sync attempt.
 - Gauge: `gitops_drift_detected{app, namespace}` - 1 when OutOfSync, 0 when Synced.
 - Histogram: `gitops_sync_duration_seconds{app}` - measure end-to-end sync time.
4. Write unit tests using `sigs.k8s.io/controller-runtime/pkg/envtest`. Cover: successful sync flow, failed revision fetch (retry behavior), drift with auto-sync disabled (OutOfSync status), finalizer addition and removal.
5. Build a Docker image and load it into kind: `docker build -t gitops-controller:dev . && kind load docker-image gitops-controller:dev`
6. Deploy the controller and CRD to your kind cluster. Create a `GitOpsApp` CR pointing to a test repository.
7. Verify sync completes successfully and metrics appear in Prometheus.

**Expected outcome:** understand controller-runtime reconciliation patterns and how GitOps tooling is built internally.

### Exercise 5: GitOps Security Hardening

Harden the GitOps pipeline against the most common attack vectors.

1. Configure Gitsign locally. Write a GitHub Actions job that verifies all commits to `main` carry valid Sigstore signatures.
2. Implement four Conftest policies: no `latest` tag, mandatory `readinessProbe`, every production Deployment directory must contain a matching `PodDisruptionBudget`, all containers must set `securityContext.runAsNonRoot: true`.
3. Make the Conftest check a required status check on all PRs modifying `applications/`.
4. Install External Secrets Operator with HashiCorp Vault (dev mode). Migrate all hard-coded secrets from your manifests to Vault-backed `ExternalSecret` resources.
5. Configure ArgoCD AppProject RBAC with three roles: developer (read-only), SRE (sync but no delete), CI bot (full access).
6. Write a Go unit test for the `WebhookHandler` that verifies: requests with invalid HMAC signatures return HTTP 401, requests with valid signatures are processed and written to the store.

**Expected outcome:** understand defense-in-depth for a production-grade GitOps security posture.

### Exercise 6: DORA Metrics Pipeline

Build a DORA metrics tracking system for your GitOps environment.

1. Configure ArgoCD Notifications to POST to a webhook on `on-sync-succeeded`, `on-sync-failed`, and `on-health-degraded` events.
2. Implement the `WebhookHandler` from this chapter. Persist records to PostgreSQL with schema: `(id UUID, application TEXT, environment TEXT, cluster TEXT, revision TEXT, sync_status TEXT, triggered_by TEXT, synced_at TIMESTAMPTZ, committed_at TIMESTAMPTZ, duration_seconds FLOAT)`.
3. Populate `committed_at` by calling the GitHub API with the `revision` SHA to fetch the commit timestamp.
4. Implement a Go HTTP API with four endpoints:
 - `GET /metrics/deployment-frequency?env=production&days=30`
 - `GET /metrics/lead-time?env=production&days=30`
 - `GET /metrics/change-failure-rate?env=production&days=30`
 - `GET /metrics/mttr?env=production&days=30`
5. Write a Grafana dashboard JSON with four panels - one per DORA metric - showing 30-day trends as time-series graphs.
6. Set up Prometheus alerting: alert if lead time exceeds 4 hours or deployment frequency drops below 1 per day.

**Expected outcome:** measure your deployment pipeline objectively and create a feedback loop for continuous improvement.

### Junior → FAANG: Getting Full Value from Hands-On Exercises

The most common mistake with exercise sets is completing the happy path and stopping. Exercise 2 (canary with automated rollback) is specifically designed to fail: the buggy v2 that returns HTTP 500 for 15% of requests will trigger the `AnalysisRun` and rollback. If you never observe the rollback happening, you have not completed the exercise. The learning is in watching the system detect the problem and recover without human action.

For Exercise 4 (the custom controller), focus on the test coverage requirement before the Docker build. The `envtest` package runs a real API server against your reconciler so you can verify status transitions and finalizer behavior without a full cluster. If you skip the tests and go straight to `kind load docker-image`, you are practicing deployment rather than learning controller design. The test suite is where you discover the edge cases: what happens when the Git repository is unreachable? What happens when the object is deleted during a sync? These are the questions that distinguish a functional controller from a production-grade one.

Entry-level interview framing: FAANG interviewers often ask about systems you have designed and deployed. Having completed Exercise 6 (the DORA metrics pipeline) gives you a concrete answer to "how do you measure deployment performance?" with real numbers: deployment frequency, lead time, MTTR. These are the metrics engineering managers at FAANG actually care about, and being able to discuss them from hands-on experience rather than theory is a meaningful signal.

### Senior @ FAANG: Using These Exercises to Evaluate Platform Readiness

At staff level, these six exercises map to distinct organizational capabilities that a platform team must own. Working through them personally is valuable, but the deeper use is to run them as a platform readiness assessment against your current environment.

Exercise 1 tests the baseline GitOps contract: self-heal corrects unauthorized changes. If your production ArgoCD installation cannot pass this test because `selfHeal` is disabled on production Applications, you have uncovered a governance gap that requires a documented decision: either enable self-heal and accept that emergency patches are reverted, or document the manual drift-correction process and its SLA.

Exercise 3 tests the promotion pipeline design. The three-environment scenario (dev fully automated, staging automated with self-heal, production manual with required reviewers) reflects the governance model many regulated organizations need. If your organization cannot implement production-manual sync because "we need continuous deployment to production," that is a risk appetite decision that must be explicit and documented, not implicit.

Exercise 5 (security hardening) is the most important for a staff-level platform engineer to personally complete. The combination of Gitsign, Conftest, External Secrets Operator, AppProject RBAC, and audited webhooks represents the minimal security posture for a regulated industry GitOps deployment. Any of these layers missing without documented compensating controls is a finding in a SOC 2 audit. Running this exercise against a representative subset of your production configuration before an audit is a concrete way to identify gaps.

Exercise 6 (DORA metrics) is the business case justification for the GitOps investment. The four metrics are the standard language for communicating deployment pipeline maturity to engineering leadership and to FAANG interviewers asking "how did you improve your team's deployment velocity?" Completing this exercise creates the measurement infrastructure that turns GitOps from a technical practice into a quantified engineering capability.

---
