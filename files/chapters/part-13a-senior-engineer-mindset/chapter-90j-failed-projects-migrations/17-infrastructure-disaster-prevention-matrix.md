## 90J.16 Infrastructure Disaster Prevention Matrix

This matrix summarizes the defensive patterns from every incident in this chapter, organized by the type
of failure they prevent.

### Category 1: Deployment Failures

| Prevention Pattern | Prevents | Go Implementation |
|---|---|---|
| Automated deployment pipeline | Inconsistent deployments (Knight Capital) | CI/CD with deployment validation |
| Canary deployments | Full-fleet deployment failures | Progressive rollout with health checks |
| Deployment version validation | Version inconsistency across servers | DeploymentValidator type |
| Dead code removal policy | Dormant code reactivation | Static analysis in CI pipeline |
| Flag registry | Flag reuse and confusion | Typed flag system with ownership |

### Category 2: Data Integrity Failures

| Prevention Pattern | Prevents | Go Implementation |
|---|---|---|
| Migration validation | Data corruption during migration (TSB) | Validator with per-record comparison |
| Type-safe identifiers | ID confusion (Atlassian) | Distinct types for each entity class |
| Soft delete with grace period | Accidental permanent deletion | SiteManager with recovery window |
| Backup verification | Unrestorable backups (GitLab) | Monitor with regular test restores |
| Immutable audit logs | Evidence tampering (Post Office Horizon) | Append-only log with cryptographic chaining |

### Category 3: Operational Failures

| Prevention Pattern | Prevents | Go Implementation |
|---|---|---|
| Blast radius limiting | Large-scale infrastructure impact (AWS S3) | Limiter with percentage caps |
| Batch execution with health checks | Cascading operational failures | ExecuteWithRollback pattern |
| Confirmation gates for destructive ops | Accidental destructive commands (GitLab) | Multi-step confirmation |
| Cooldown periods | Rapid-fire destructive operations | CooldownBetweenOps policy |
| Independent monitoring | Circular monitoring dependencies (Roblox) | IndependentMonitor with direct IPs |

### Category 4: Financial/Trading Failures

| Prevention Pattern | Prevents | Go Implementation |
|---|---|---|
| Kill switch | Runaway trading losses (Knight Capital) | KillSwitch with multi-threshold halt |
| Circuit breaker | Flash crash cascades | Multi-level CircuitBreaker |
| Price limits | Trading at absurd prices | LULD implementation |
| ML model monitoring | Systematic prediction bias (Zillow) | ModelMonitor with drift detection |
| Human-in-the-loop | Autonomous high-value decisions | Approval gates above thresholds |

### Category 5: Organizational Failures

| Prevention Pattern | Prevents | Who Owns It |
|---|---|---|
| Phased migration | Big bang failures (TSB, Hershey) | Migration lead |
| Single integrator responsibility | Multi-contractor chaos (Healthcare.gov) | Program manager |
| No-go authority | Political deadlines overriding readiness | Engineering leadership |
| Technical debt tracking | Legacy system failures (Southwest) | Engineering management |
| Independent audit | Institutional cover-ups (Post Office) | External auditor |
| Leadership stability | Architectural thrashing (FBI VCF) | Executive leadership |

### Category 6: Network/Infrastructure Failures

| Prevention Pattern | Prevents | Go Implementation |
|---|---|---|
| BGP route validation | Route withdrawal disasters (Meta, Rogers, Optus) | Pre-deployment route simulation |
| Out-of-band management | Recovery tool unavailability | Separate management network |
| Status page independence | Status page down with service (AWS S3) | External hosting for status |
| Multi-region redundancy | Single-region failures | Cross-region health checking |
| Configuration validation | Config errors causing outages | Pre-commit config validation |

### The Universal Prevention Checklist

Before deploying any change to production, ask:

1. **Blast radius**: What is the maximum impact if this goes wrong?
2. **Rollback**: Can we undo this change? How long would it take?
3. **Detection**: How will we know if something goes wrong? How quickly?
4. **Monitoring**: Does our monitoring depend on the system being changed?
5. **Recovery**: Do our recovery tools depend on the system being changed?
6. **Testing**: Has this been tested at production scale?
7. **Timing**: Is this the worst possible time to make this change?
8. **Approval**: Has someone other than the person making the change reviewed it?
9. **Communication**: Do stakeholders know this change is happening?
10. **Backup**: Are our backups verified and restorable?

---

### Junior → FAANG: The Prevention Checklist as a System Design Interview Template

The ten-question prevention checklist at the end of this section is a structured framework for answering "how would you ensure this system is production-ready?" before any major change or launch. For FAANG system design interviews, walking through each question demonstrates that you think about failure modes proactively rather than reactively. The blast radius question ("what is the maximum impact if this goes wrong?") is especially useful because it forces you to name the worst-case scenario explicitly, which is what FAANG interviewers are listening for. The monitoring independence question ("does our monitoring depend on the system being changed?") is the one most candidates miss, and naming it demonstrates that you have thought about cascading failures. For any system design question that involves a migration, deployment, or configuration change, using this ten-question structure as a closing framework demonstrates the operational thinking that separates senior candidates from mid-level candidates.

### Senior @ FAANG: The Prevention Matrix as an Organizational Risk Assessment Tool

At L6, the infrastructure disaster prevention matrix is the input to a quarterly infrastructure risk assessment. The matrix maps each failure pattern (backup failure, blast radius, configuration validation, status page independence, multi-region redundancy) to the specific incidents that exemplify it and the defensive controls that prevent it. For each pattern, measure current organizational coverage: what percentage of production services have verified backup restore tests in the last 30 days? What percentage of infrastructure automation tools enforce blast radius limits? What percentage of configuration changes go through a pre-deployment validation step? These coverage percentages are the infrastructure maturity metrics that a staff engineer reports to engineering leadership and uses to prioritize platform investments. A coverage measurement of 40% on backup verification (meaning 60% of services have unverified backups) is the GitLab scenario in slow motion. The platform investment that closes that gap, an automated backup restoration testing service that runs weekly against all production databases, has a justified cost equal to the expected value of a GitLab-scale data loss incident multiplied by the 60% unverified fraction. Framing platform investment in terms of incident prevention probability and expected loss reduction is the staff engineer's language for infrastructure risk governance.

---
