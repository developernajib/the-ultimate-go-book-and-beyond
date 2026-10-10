## Summary

### Secrets Management Quick Reference

| Scenario | Recommended Solution |
|----------|---------------------|
| Multi-cloud deployments | External Secrets Operator + multiple backends |
| Dynamic database creds | Vault Database Secrets Engine |
| Kubernetes workloads | Vault Agent Injector or ESO |
| AWS native | AWS Secrets Manager |
| GCP native | GCP Secret Manager |
| Credential rotation | Vault dynamic secrets or provider rotation |
| Audit logging | Cloud provider audit logs + custom logging |

### Security Checklist

Before deploying any Go service that consumes secrets, verify each item below has been addressed. Secrets leaked through logs, environment dumps, or error messages are among the most common causes of production credential exposure. Rotation and audit logging are non-negotiable in regulated environments. Treat this checklist as a gate, not a suggestion.

```
□ No secrets in code, config files, or environment dumps
□ All secrets encrypted at rest
□ All secret access over TLS
□ Dynamic credentials where possible
□ Automatic rotation enabled
□ Access auditing enabled
□ Least privilege access policies
□ Pre-commit hooks for secret detection
□ Secrets never in logs or errors
□ Rotation tested and documented
```

### Junior → FAANG: The Quick Reference as a Self-Assessment Tool

The quick reference at the end of this chapter is a self-assessment tool. Before your next interview, work through every item: can you explain it, implement it, and describe what goes wrong if it is missing?

**Gap to close:** The item most likely to be missing from a junior's self-assessment is "rotation tested and documented." Many engineers set up rotation but never actually trigger it to verify it works. Untested rotation is as risky as no rotation: you discover it is broken during an emergency. Test your rotation mechanism in staging before trusting it in production.

### Senior @ FAANG: Quick Reference as a Team Standard

At senior level, the quick reference is a team standard, not a personal study guide. Post it in your team's engineering wiki. Review it in your next security retrospective. For every item that your team cannot honestly check, create a tracked improvement item.

**Cadence:** Review the quick reference quarterly against your actual service configurations. Configuration drift (a service that passes the checklist at deployment but drifts out of compliance over time as configurations change) is a real risk. Automated compliance checking (a weekly job that verifies each item in the checklist against your service configurations) converts the checklist from a point-in-time gate to a continuous compliance mechanism.

---

## Navigation

- **Previous Chapter:** [Chapter 108: Cryptography in Go](../chapter-108-cryptography/19-summary.md)
- **Part Overview:** [Part XVII-A: Security](../00-part-intro.md)
- **Next Chapter:** [Chapter 110: Supply Chain Security](../chapter-110-supply-chain-security/00-introduction.md)
