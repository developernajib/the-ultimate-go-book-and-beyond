## 106.5 Cost Alerting

### Budget Alerts

Cost alerting turns the metrics from the previous section into actionable signals: spend anomalies against a rolling baseline, external API cost spikes, and standing over-provisioning. The following Prometheus alert rules cover the four highest-value cases.

```yaml
# Prometheus alert rules for cost
groups:
  - name: cost-alerts
    rules:
      # Daily spend anomaly
      - alert: DailySpendAnomaly
        expr: |
          sum(increase(app_request_cost_microdollars[24h])) / 1000000 >
          avg_over_time(sum(increase(app_request_cost_microdollars[24h]))[7d:1d]) * 1.5
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "Daily spend 50% above 7-day average"
          description: "Current daily spend: ${{ $value | printf \"%.2f\" }}"

      # External API cost spike
      - alert: ExternalAPICostSpike
        expr: |
          sum by (provider) (rate(external_api_cost_microdollars[1h])) * 86400 / 1000000 > 100
        for: 30m
        labels:
          severity: warning
        annotations:
          summary: "High external API cost for {{ $labels.provider }}"
          description: "Projected daily cost: ${{ $value | printf \"%.2f\" }}"

      # Resource over-provisioning
      - alert: ResourceOverProvisioning
        expr: |
          (
            sum by (deployment) (kube_pod_container_resource_requests{resource="cpu"}) -
            sum by (deployment) (rate(container_cpu_usage_seconds_total[24h]))
          ) / sum by (deployment) (kube_pod_container_resource_requests{resource="cpu"}) > 0.7
        for: 24h
        labels:
          severity: info
        annotations:
          summary: "{{ $labels.deployment }} CPU over-provisioned by {{ $value | humanizePercentage }}"

      # Memory over-provisioning
      - alert: MemoryOverProvisioning
        expr: |
          (
            sum by (deployment) (kube_pod_container_resource_requests{resource="memory"}) -
            avg by (deployment) (container_memory_working_set_bytes)
          ) / sum by (deployment) (kube_pod_container_resource_requests{resource="memory"}) > 0.5
        for: 24h
        labels:
          severity: info
        annotations:
          summary: "{{ $labels.deployment }} memory over-provisioned by {{ $value | humanizePercentage }}"
```

### Junior → FAANG: Cost Alerts Are Different From Reliability Alerts

Cost alerts have a different urgency profile than reliability alerts. A service with 10% error rate requires immediate response. A service whose weekly spend is 150% of baseline requires investigation within a business day, not a 3 AM page. Cost alerts should use severity `warning` with routing to a Slack channel or a ticket, not PagerDuty. Configuring cost alerts with the wrong severity routes them to the on-call rotation, contributing to alert fatigue for incidents that are not time-critical.

Know the difference between a spend spike (sudden increase within a week) and cost drift (gradual increase over weeks or months). Spend spikes are typically caused by traffic events, new feature deployments, or configuration mistakes. Cost drift is caused by growing data volume, accumulating technical debt (inefficient queries that worsen as the dataset grows), or organic traffic growth that has outpaced right-sizing efforts. These two patterns require different detection approaches: week-over-week comparisons for spikes, trend-line regression for drift.

### Senior @ FAANG: Cost Alert Governance and Accountability Routing

At L6, cost alerts are most valuable when they route to the team that can act on them, not to a central ops team. The Alertmanager routing for cost alerts must map the `team` label (derived from Kubernetes resource tags) to the corresponding Slack channel for that team. This requires the cost metric labels to be consistent with the organization's team taxonomy, which requires the tagging governance described in the FinOps fundamentals section.

Cost alert thresholds must be reviewed quarterly, not set once and forgotten. A service whose traffic grows 50% over a quarter will trigger its spend spike alert every week as the baseline drifts upward. The quarterly review either resets the baseline or identifies that the growth is unexpected and warrants optimization. Automating the baseline reset using a rolling 4-week average (rather than a fixed threshold) reduces maintenance burden but requires careful tuning: a 4-week rolling average resets too quickly after a genuine cost increase, making it insensitive to real problems.

The over-provisioned memory alert shown in this chapter is a cost-saving opportunity alert, not a performance alert. When it fires, the action is to review the VPA recommendation for the deployment and schedule a right-sizing PR for the next sprint, not to respond immediately. These alerts should feed into a weekly engineering hygiene report rather than the incident management workflow.

---
