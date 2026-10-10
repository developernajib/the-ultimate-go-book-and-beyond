## Exercises

### Exercise 1: Instrument a Go HTTP Service with Cost Metrics (Beginner)

Take a Go HTTP server with three endpoints: `GET /users`, `POST /users`, `GET /health`.

1. Add `UnitEconomicsMiddleware` configured for a `t3.medium` ($0.0416/hour, 2 vCPUs).
2. Expose Prometheus metrics at `/metrics` with `promhttp.Handler()`.
3. Generate synthetic traffic with `hey` or a `curl` loop.
4. Verify `finops_cost_per_request_usd` and `finops_request_cost_usd_histogram` appear with correct `endpoint` labels.
5. Write a unit test asserting the gauge is `> 0` and `< 0.001` after 100 requests.

---

### Exercise 2: Right-Sizing CLI from a CSV File (Beginner-Intermediate)

Write a CLI tool reading a CSV with columns `instance_id, instance_type, p95_cpu_pct`.

1. Parse with `encoding/csv`.
2. Flag instances where `p95_cpu_pct < 30` and a downsize path exists.
3. Print a formatted savings table.
4. Accept `--min-savings` to filter below a dollar threshold.

Table-driven tests: (a) under-utilized with a known downsize, (b) well-utilized, (c) unknown instance type.

---

### Exercise 3: Holt-Winters Cost Forecasting (Intermediate)

1. Generate a synthetic 90-day series: $1,000/day, 2%/day growth, Gaussian noise (seed 42).
2. Split 75 train / 15 test.
3. Forecast 15 steps. Compute MAPE against the test set.
4. Compare three `(alpha, beta)` combinations in a table.
5. Print a 30-day capacity planning forecast.

Target MAPE below 8% with tuned parameters.

---

### Exercise 4: Tagging Compliance CI/CD Gate (Intermediate)

1. Write Terraform for three EC2 instances: fully tagged, missing `cost-center`, completely untagged.
2. Apply to a sandbox or LocalStack.
3. Run `tag-enforcer` - expect exit code 1.
4. Fix Terraform. re-apply. re-run - expect exit code 0.
5. Add as a GitHub Actions post-deploy step failing on compliance < 95%.

Write a mock test for `buildReport` using an interface over the tagging API client.

---

### Exercise 5: Spot Termination Integration Test (Intermediate-Advanced)

1. Implement the handler in a minimal Go HTTP server.
2. Integration test:
   - Start app on a random port.
   - Start mock IMDS returning HTTP 404 initially.
   - Make 20 requests - verify all return HTTP 200.
   - Switch mock IMDS to return HTTP 200.
   - Wait up to 10 seconds for graceful shutdown.
   - Verify `/tmp/spot-terminating` was created.
   - Verify no in-flight requests received HTTP 500.
3. Must pass `go test -race ./...`.

---

### Exercise 6: End-to-End FinOps Dashboard (Advanced)

Build a Go service as a FinOps dashboard backend:

1. **Ingestion**: query Cost Explorer daily via a 24-hour background ticker. Store in SQLite (`daily_costs(date, service_tag, aws_service, cost_usd)`).
2. **Anomaly detection**: run z-score detector after each ingestion. Write to `anomalies(date, service_tag, zscore, severity)`.
3. **Forecast endpoint**: `GET /forecast?service=<tag>&days=30` returns JSON `[]ForecastPoint` using `HoltLinear`.
4. **Summary endpoint**: `GET /summary?month=2026-03` returns total spend, top-5 services, MoM change, compliance score.
5. **Slack alerting**: POST to `SLACK_WEBHOOK_URL` on `severity: high` anomaly.
6. **Auth**: Bearer tokens stored as bcrypt hashes. `POST /tokens` protected by master admin token env var.
7. **Tests**: mock Cost Explorer, mock Slack via `httptest`, in-memory SQLite.
8. **Deployment**: `Dockerfile` + `docker-compose.yml`.

---

### Junior → FAANG: FinOps Exercises as the Fastest Path to Cost Literacy

Exercise 1 (instrumenting a Go HTTP service with cost metrics) is the highest-return exercise in this section. It takes less than a day to implement and produces a real `cost_per_request_usd` metric in your production service. Once the metric exists, you can track it over time, and any architectural change you make (adding caching, switching to a smaller instance type, reducing DynamoDB read capacity) will show up as a change in the metric. This feedback loop makes cost-aware engineering a daily practice rather than a quarterly review.

Exercise 4 (cost anomaly detection) is the second most valuable for career development: it produces a production-quality time series analysis component that can be used in any future cost monitoring project and demonstrates statistical analysis skills in the context of infrastructure engineering, which is valued in platform engineer interviews.

For the full platform exercise (Exercise 7), focus on getting the API and alerting working first, then add the UI. A cost monitoring platform with a functional API and Slack alerting is operationally useful. A platform with a polished UI but no reliable alerting is not. Build the most operationally important components first.

### Senior @ FAANG: Exercise Selection as Platform Investment Prioritization

At staff level, these exercises represent a portfolio of potential platform investments. The decision of which to implement first should be driven by organizational ROI, not by technical interest. Exercise 2 (Kubernetes rightsizing advisor) has the highest potential savings for organizations running large Kubernetes clusters at 15-40% CPU utilization. Exercise 3 (automated Savings Plans) has the highest savings rate (30-40% on covered compute) but requires the highest organizational trust in the automation before it can be fully automated (Savings Plans purchases are financial commitments).

The sequencing recommendation for organizations building a FinOps platform from scratch: Exercise 1 (unit economics instrumentation) enables the measurement that makes everything else meaningful. Exercise 5 (tagging enforcer) prevents new attribution debt from accumulating while you remediate existing gaps. Exercise 4 (anomaly detection) provides the real-time alert system that catches spend regressions before they become budget crises. Exercise 2 (rightsizing advisor) generates the first cost reduction recommendations. Exercise 3 (Savings Plans automation) locks in the savings from the steady-state baseline after rightsizing is complete. This sequence respects the dependency between visibility (measurement, governance) and action (rightsizing, commitments), which is the order in which real FinOps programs succeed.
