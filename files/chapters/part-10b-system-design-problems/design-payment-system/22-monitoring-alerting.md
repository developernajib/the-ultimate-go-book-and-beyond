## Monitoring & Alerting

Payment systems require aggressive monitoring because financial errors compound quickly and silently. A bug that misrecords one cent per transaction becomes tens of thousands of dollars per day at scale. This section covers the three pillars of payment observability: metrics that tell you what is happening, dashboards that help you see patterns, and alerting rules that wake you up when something goes wrong.

### Key Metrics Table

Monitoring a payment system is different from monitoring a typical web application because even brief anomalies can mean real financial loss. The table below lists the most important metrics to track, organized by concern area. Each metric includes the threshold at which it should trigger an alert and which dashboard it belongs to, so your on-call engineer can quickly triage issues.

| Metric | Description | Alert Threshold | Dashboard |
|--------|-------------|-----------------|-----------|
| `payment.success_rate` | Percentage of payments that reach CAPTURED | < 95% | Payments |
| `payment.latency_p99` | End-to-end payment processing latency | > 5s | Payments |
| `payment.latency_p50` | Median payment processing latency | > 1s | Payments |
| `payment.auth_decline_rate` | Processor authorization decline rate | > 15% | Payments |
| `payment.amount_total` | Total payment volume per minute | Anomaly detection | Revenue |
| `fraud.score_p95` | 95th percentile fraud score | > 0.7 | Fraud |
| `fraud.block_rate` | Percentage of payments blocked by fraud | > 5% | Fraud |
| `fraud.false_positive_rate` | Legitimate payments wrongly blocked (lagging, see below) | > 2% | Fraud |
| `ledger.balance_mismatch` | Double-entry balance discrepancies | > 0 | Reconciliation |
| `ledger.write_latency` | Time to write ledger entries | > 100ms | Reconciliation |
| `idempotency.hit_rate` | Percentage of requests served from cache | Informational | Infrastructure |
| `idempotency.lock_contention` | Concurrent requests for same key | > 10/min | Infrastructure |
| `processor.timeout_rate` | Processor communication timeouts | > 1% | Processor Health |
| `processor.failover_count` | Failover events to backup processor | > 0 | Processor Health |
| `webhook.delivery_success` | Webhook delivery success rate | < 99% | Webhooks |
| `webhook.retry_queue_depth` | Pending webhook retries | > 10,000 | Webhooks |
| `settlement.pending_amount` | Unsettled captured payments | Growing trend | Settlement |
| `refund.processing_time` | Time from refund request to completion | > 24h | Refunds |

One entry in that table is not like the others, and it is worth being honest about which. `fraud.false_positive_rate` cannot be measured in real time, because at the moment you block a payment you do not know whether it was fraud. You find out later, and only partially, from customers who complain, from merchants who appeal, and from the chargebacks that arrive on the transactions you let through. Treat it as a lagging quality measure reviewed on a weekly cadence against labelled outcomes, not as a live gauge you can alert on. The live signal available to you is `fraud.block_rate`, which is a proxy: a sudden jump in blocks usually means a model or rule change misfired rather than that fraud genuinely tripled overnight.

### Dashboard Recommendations

Dashboards give your team a real-time visual overview of system health. Each dashboard below targets a specific audience: the payments dashboard is for the on-call engineer, the fraud dashboard is for the risk team, and the merchant dashboard is for your customer support team. Grouping metrics by concern area makes it faster to diagnose whether an issue is in your system, at the processor, or in the fraud model.

1. **Payment Flow Dashboard**: Real-time funnel (pending -> authorized -> captured -> settled), decline reasons breakdown, success rate by processor/merchant/currency.
2. **Fraud Dashboard**: Fraud score distribution, blocked transaction heatmap, false positive rate trend, velocity rule trigger rates.
3. **Reconciliation Dashboard**: Ledger balance verification, processor vs internal state mismatches, pending settlement amounts, daily reconciliation results.
4. **Processor Health Dashboard**: Per-processor latency/success rate, failover events, timeout trends, capacity utilization.
5. **Merchant Dashboard**: Per-merchant success rates, average transaction value, refund rates, webhook delivery health.

### Alerting Rules

The Prometheus alerting rules below encode the thresholds from the metrics table into automated alerts. Critical alerts (like a ledger balance mismatch) page the on-call engineer immediately because they indicate potential financial data corruption. Warning-level alerts (like elevated processor timeouts) notify the team in Slack so they can investigate before the issue escalates. The `for` duration on each rule prevents noisy alerts from brief transient spikes.

There is a trap in ratio alerts that is worth internalizing, because it produces the most dangerous kind of monitoring: the kind that is silent for the right reason and the wrong outcome. Every rule below of the form `rate(good) / rate(total) < threshold` divides by zero the moment traffic stops. In Prometheus that yields NaN, every comparison against NaN is false, and the alert does not fire. So the complete outage, where zero payments are even attempted, is precisely the scenario your success-rate alert cannot detect. It looks identical to a healthy quiet night. Ratio alerts need a companion that watches for the absence of traffic, which is why `PaymentVolumeAbsent` is here and is not optional.

```yaml
groups:
  - name: payment_critical
    rules:
      - alert: PaymentSuccessRateLow
        # Guard the denominator: only evaluate when there is enough
        # traffic for the ratio to mean anything. Without the `and`, a
        # handful of payments a minute produces a ratio that swings
        # between 0 and 1 and pages someone at 4am for nothing.
        expr: |
          (
            sum(rate(payment_status_total{status="CAPTURED"}[5m]))
            /
            sum(rate(payment_status_total{status="PENDING"}[5m]))
          ) < 0.95
          and
          sum(rate(payment_status_total{status="PENDING"}[5m])) > 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Payment success rate below 95%"

      - alert: PaymentVolumeAbsent
        # The alert the ratio above cannot be: nobody is paying at all.
        # At 1,160/sec average, a full minute near zero is an outage, not
        # a quiet period, and the success-rate alert stays silent for it
        # because NaN < 0.95 is false.
        expr: sum(rate(payment_status_total{status="PENDING"}[5m])) < 10
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Payment volume has collapsed, no payments being created"

      - alert: LedgerBalanceMismatch
        # No `for` beyond a single evaluation: this is not a threshold to
        # be exceeded for a while, it is an invariant that must never be
        # violated once. If debits stop equalling credits, the question is
        # not whether it persists, it is what corrupted it and when.
        expr: ledger_balance_mismatch_total > 0
        labels:
          severity: critical
        annotations:
          summary: "Double-entry ledger balance discrepancy detected"

      - alert: PaymentsStuckPending
        # Pending payments are ambiguous ones: the card may be charged
        # while we show nothing. Reconciliation should be draining these
        # within 5 minutes, so a growing backlog means it is not running.
        expr: payments_pending_older_than_5m > 100
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Reconciliation backlog: payments stuck in PENDING"

  - name: payment_warning
    rules:
      - alert: ProcessorTimeout
        expr: |
          (
            sum(rate(processor_timeout_total[5m]))
            /
            sum(rate(processor_request_total[5m]))
          ) > 0.01
          and
          sum(rate(processor_request_total[5m])) > 1
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "Processor timeout rate exceeds 1%, expect ambiguous charges"

      - alert: FraudBlockRateHigh
        expr: |
          (
            sum(rate(fraud_blocked_total[10m]))
            /
            sum(rate(payment_total[10m]))
          ) > 0.05
          and
          sum(rate(payment_total[10m])) > 1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Fraud block rate exceeds 5%, check for false positives"
```

---
