## Exercises

1. **Feature Flag Service**: Build a feature flag service backed by etcd. Implement: (a) admin API to CRUD flags, (b) evaluation API returning flag value for a user context, (c) flag change notifications via etcd watch, (d) metrics tracking eval count per flag per variant.

2. **Canary with Prometheus**: Implement the `CanaryRouter` from this chapter. Add Prometheus metrics: `canary_requests_total{backend="stable|canary"}` and `canary_errors_total{backend="stable|canary"}`. Build a Grafana dashboard and alert rule that fires when canary error rate exceeds 2x stable.

3. **Shadow Traffic Comparison**: Implement the `ShadowProxy` for a user lookup API. The comparison function should: (a) verify status codes match, (b) verify response body JSON fields match (ignoring timestamps and IDs), (c) log diffs to a structured log. Run 100% shadow traffic for 1 hour against a refactored handler and measure mismatch rate.

4. **Statistical A/B Test**: Implement the full `ExperimentEngine`. Write a simulation: generate 20,000 users, assign to control (5% conversion) and treatment (6% conversion). Verify the engine detects significance at roughly 8,000 users per arm. Plot confidence over sample size.

5. **Synthetic Monitoring Dashboard**: Build a synthetic monitoring service that runs 10 probes (HTTP, DNS, TCP) every 30 seconds. Serve Prometheus metrics and a simple HTML dashboard showing current status (green/red) and 24-hour availability percentage for each probe. Alert via webhook when availability drops below 99%.

### Junior → FAANG: ramped exercises

6. **Ship your first flag-gated change end-to-end**: Pick a real code change. Wrap in a feature flag. Ramp from 0 percent to 100 percent over a day with observations at each stage. Remove the flag once rolled out. Document the timeline.

7. **Run a local canary with shadow response diffing**: Using `ShadowProxy` from section 3, point the shadow at a refactored version of a handler you control. Define a response comparison function. Run load for an hour and report mismatch rate.

8. **Write a synthetic probe for an endpoint you own**: Deploy it to a different cloud region from the service it probes. Set it to run every minute. Wire the alert. Document the failure domain it protects against.

9. **Compute a sample size for an A/B test**: For a hypothetical experiment with 3 percent baseline conversion and 5 percent relative MDE, compute N using the formulas in section 5.0. Sanity-check against Evan Miller's calculator.

### Senior @ FAANG: staff-level exercises

10. **Write the progressive-delivery playbook for your team**: Follow the structure in section 10's staff-track answer. Include phases, success metrics, blockers, and escalation paths.

11. **Audit the maturity of your team's releases**: Using the maturity model in section 9, rate your team honestly. Identify the gap to the next level and write the concrete plan.

12. **Design an SRM monitor for your A/B platform**: Implement the chi-square check that runs continuously and flags experiments with biased assignment. Document the alert threshold and the investigation runbook.

13. **Run one local GameDay-style rollback drill**: Deploy a change with a feature flag. Intentionally break it. Simulate an operator response to roll back within three minutes. Debrief on what worked and what did not.

---
