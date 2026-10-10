## 104.5 Alerting Rules

### Prometheus Alerting Configuration

Alerting rules in Prometheus evaluate PromQL expressions on a fixed schedule and fire when a condition holds for the specified `for` duration. The YAML configuration below defines a set of production alerting rules covering error rate, latency, goroutine leaks, and error budget burn rate, with annotations linking each alert to its corresponding runbook.

```yaml
# prometheus/alerts/go-service.yaml
groups:
  - name: go-service-alerts
    interval: 30s
    rules:
      # High error rate
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m])) /
          sum(rate(http_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "Error rate is {{ $value | humanizePercentage }} (>5%)"
          runbook_url: "https://wiki/runbooks/high-error-rate"

      # High latency
      - alert: HighLatency
        expr: |
          histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m]))) > 1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High latency detected"
          description: "P95 latency is {{ $value | humanizeDuration }}"

      # Low request rate (possible service issue)
      - alert: LowRequestRate
        expr: |
          sum(rate(http_requests_total[5m])) < 1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Unusually low request rate"
          description: "Request rate is {{ $value }}/s"

      # High memory usage
      - alert: HighMemoryUsage
        expr: |
          go_memstats_alloc_bytes / 1024 / 1024 > 500
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage"
          description: "Memory usage is {{ $value }}MB"

      # Too many goroutines
      - alert: TooManyGoroutines
        expr: go_goroutines > 1000
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Too many goroutines"
          description: "{{ $value }} goroutines running"

      # Database connection pool exhausted
      - alert: DatabaseConnectionPoolExhausted
        expr: |
          db_connections_in_use / db_connections_max_open > 0.9
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Database connection pool nearly exhausted"
          description: "{{ $value | humanizePercentage }} of connections in use"

      # Service down
      - alert: ServiceDown
        expr: up == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Service is down"
          description: "{{ $labels.instance }} has been down for more than 1 minute"

  - name: slo-alerts
    rules:
      # SLO: 99.9% availability
      - alert: SLOAvailabilityBreach
        expr: |
          (1 - (
            sum(rate(http_requests_total{status=~"5.."}[1h])) /
            sum(rate(http_requests_total[1h]))
          )) < 0.999
        for: 5m
        labels:
          severity: critical
          slo: availability
        annotations:
          summary: "SLO availability breach"
          description: "Availability is {{ $value | humanizePercentage }}"

      # SLO: P99 latency < 500ms
      - alert: SLOLatencyBreach
        expr: |
          histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[1h]))) > 0.5
        for: 5m
        labels:
          severity: critical
          slo: latency
        annotations:
          summary: "SLO latency breach"
          description: "P99 latency is {{ $value | humanizeDuration }}"
```

### Junior → FAANG: Writing Alerts That Wake People Up for the Right Reasons

An alert that fires too often trains engineers to ignore it. An alert that never fires provides false confidence. The discipline of good alerting is writing rules that fire exactly when human intervention is required and are silent otherwise.

Two structural properties of well-written alerts: a `for` clause and a meaningful annotation. The `for` clause prevents flapping: an alert only fires if the condition has been true continuously for the specified duration. Without it, a momentary metric spike triggers a page at 3am. The annotation explains what the alert means and includes a link to the runbook so the on-call engineer knows what to do without reading source code.

Interview entry point: "What is the difference between a warning alert and a critical alert?" Warning alerts indicate degradation that needs attention during business hours. Critical alerts indicate that user-facing SLOs are being breached now and require immediate response. Mixing these severities (making everything critical) causes alert fatigue.

### Senior @ FAANG: Alert Ownership, Noise Reduction, and Multi-Window SLO Alerts

**Alert ownership as a governance requirement.** Every alert must have an `owner` label that identifies the team responsible for the runbook and the remediation. Without this label, an alert that fires during a handover period produces a 30-minute investigation into who should respond. The platform team enforces alert ownership at the YAML linting stage: alerts without an `owner` label fail the CI check and cannot be merged.

**Multi-window, multi-burn-rate SLO alerts.** The Google SRE workbook defines a multi-window alerting strategy that combines a fast-burn detection (1-hour window burning at 14.4x the error budget rate) with a slow-burn detection (6-hour window burning at 6x). Fast-burn catches sudden outages quickly but produces false positives for brief spikes. Slow-burn catches gradual degradations that would exhaust the error budget by end of month. Both are necessary: relying only on fast-burn misses the slow death, and relying only on slow-burn responds too slowly to severe outages. An L6 engineer implements both windows for every SLO and documents the rationale in the SLO document.

**Alert routing and inhibition.** When a major infrastructure component fails (a database cluster, a load balancer), dozens of dependent service alerts fire simultaneously, creating a flood of pages that overwhelm the on-call engineer. Alertmanager inhibition rules suppress downstream alerts when a known upstream cause alert is active. Designing inhibition rules requires understanding the service dependency graph, which is a platform team responsibility. An L6 engineer maintains the inhibition rule set and updates it whenever a new service dependency is added.

---
