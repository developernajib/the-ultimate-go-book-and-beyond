## 102N.15 Applied FinOps Exercises

### Exercise 8: Weekly Team Cost Report Service

Build a Go service that queries AWS Cost Explorer and generates weekly per-team cost reports. The service should:

1. Read team definitions from a configuration file (team name → AWS tag value + monthly budget).
2. Query Cost Explorer for the past 7 days of spend grouped by the `team` tag using `GetCostAndUsage`.
3. Compare actual spend to the pro-rated monthly budget (7/30 of the monthly limit).
4. Format the report as a Markdown table with columns: Team, 7-day Spend, Budget (7d pro-rated), % Used, MoM Change.
5. Calculate month-over-month change by also querying the same 7-day window from 4 weeks prior.
6. Post the report to a Slack channel via Incoming Webhook.
7. Write the report to S3 as a dated artifact (`cost-reports/2026-03-14.md`) for historical audit.
8. Run on a weekly cron schedule - implement as a Kubernetes CronJob or AWS EventBridge + Lambda.

**Bonus**: add a "Top 5 most expensive resources" section per team by using `GetCostAndUsage` with `GroupBy: [RESOURCE_ID]` filtered to each team.

**Key AWS SDK calls**:
- `costexplorer.GetCostAndUsage` with `GroupBy: [{Type: TAG, Key: "team"}]`
- `s3.PutObject` for archiving reports
- HTTP POST to Slack Incoming Webhook URL

**Acceptance criteria**: the service runs `go test ./...` with unit tests covering the report formatting logic (mock the Cost Explorer client) and integration tests against a localstack environment.

---

### Exercise 9: Kubernetes Admission Webhook for Cost Tag Enforcement

Write a Kubernetes admission webhook (ValidatingAdmissionWebhook) in Go that rejects Deployments missing required cost allocation labels.

The webhook must:

1. Listen on HTTPS (Kubernetes requires TLS for admission webhooks). Generate a self-signed certificate at startup or mount one from a Kubernetes Secret.
2. Implement the `admissionv1.AdmissionReview` request/response lifecycle correctly.
3. Reject any `apps/v1 Deployment` that is missing any of the following labels on the **Pod template** (`spec.template.metadata.labels`): `team`, `service`, `cost-center`.
4. Return a clear rejection message listing which labels are missing: `"Deployment rejected: missing required cost labels: [team, cost-center]"`.
5. Allow a `finops.example.com/cost-exempt: "true"` annotation on the Deployment to bypass enforcement (for system namespaces or migration periods). Log all exemptions.
6. Exclude the `kube-system` and `kube-public` namespaces from enforcement.
7. Register the webhook via a `ValidatingWebhookConfiguration` manifest with `failurePolicy: Fail` so that misconfiguration blocks deployments rather than silently passing them.

**Key packages**:
- `k8s.io/api/admission/v1` for `AdmissionReview`, `AdmissionRequest`, `AdmissionResponse`
- `k8s.io/api/apps/v1` for `Deployment` deserialization
- `encoding/json` for request/response marshaling
- `crypto/tls` + `net/http` for TLS server

**Testing**: write table-driven unit tests covering: (a) deployment with all required labels → allowed, (b) deployment missing `team` → rejected with correct message, (c) deployment with exempt annotation → allowed with log, (d) deployment in `kube-system` → allowed.

**Deployment**: package as a Docker image, deploy as a Kubernetes `Deployment` with a `Service`, and apply the `ValidatingWebhookConfiguration`. Provide a `Makefile` with `make deploy` and `make test` targets.


---

### Junior → FAANG: Exercises as FinOps Portfolio Projects

The exercises in this section build a complete FinOps platform from scratch. Exercise 8 (weekly cost report service) is the most immediately applicable: it produces a real artifact (cost reports delivered to Slack) that demonstrates the full data pipeline from Cost Explorer API to communication channel. Building this for your team's actual AWS account and running it for a month produces a portfolio artifact with real data, which is more compelling in interviews than a synthetic example.

Exercise 9 (real-time cost alerting) builds on Exercise 8 by adding the anomaly detection component. The combination of the two exercises (scheduled cost reports plus real-time anomaly alerts) is the minimum viable FinOps platform for a small team. If you build both and deploy them to a real AWS account, you will have hands-on experience with Cost Explorer pagination, SNS notification delivery, and the z-score algorithm applied to real cost data.

For the tagging webhook exercise, the most instructive part is testing the failure modes: what happens when the webhook is down? (Kubernetes denies the admission request if the webhook is configured as required, or allows it if configured as optional.) What happens when a resource is missing one required tag? (The webhook should return a clear validation error message that tells the creator exactly which tag is missing.) Building these failure modes deliberately teaches the Kubernetes admission webhook lifecycle better than reading the documentation.

### Senior @ FAANG: Expanded Exercises as Platform Prototype Validation

At staff level, these exercises are platform prototypes that validate the approach before committing to production implementation. Exercise 8 (weekly cost report service) should be evaluated on: report accuracy (do the per-team allocations match what Cost Explorer shows for the team's tagged resources?), shared cost methodology (is the shared infrastructure allocation disputed by any team?), and adoption (do engineers read the report and take action on it, or does it generate noise?). Running the prototype for 4 weeks before investing in a production-grade implementation gives you these answers without over-engineering a system that might need significant redesign.

The tagging webhook exercise is a production-readiness prototype for the organization's tag enforcement system. Before deploying the webhook to a production cluster, validate: what is the failure mode when the webhook is unavailable? (Configure `failurePolicy: Ignore` for gradual rollout, then switch to `failurePolicy: Fail` after confirming stability.) What is the false positive rate? (Does the webhook block legitimate resource creation?) What is the performance impact? (The webhook adds latency to every resource creation event, confirm it completes within the Kubernetes admission timeout of 10 seconds.) These validation questions should be answered with the prototype before the production deployment decision is made.
