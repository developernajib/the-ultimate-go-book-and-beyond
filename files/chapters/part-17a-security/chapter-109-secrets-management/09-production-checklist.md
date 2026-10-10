## 109.9 Production Checklist

Before promoting a service to production, every item in this checklist must be verified, not assumed. Secrets-management failures are among the most common root causes of data breaches, and they are almost always traceable to a skipped step: a credential committed to version control, a rotation schedule never configured, or an access log never reviewed. Work through each category sequentially, treating unchecked boxes as blocking issues rather than deferred work.

```
Secret Storage:
[ ] No secrets hardcoded in source code
[ ] All secrets encrypted at rest
[ ] Secrets transmitted over TLS only
[ ] Using dedicated secret management service (Vault, AWS, GCP)

Access Control:
[ ] Principle of least privilege applied
[ ] Service accounts used (not personal credentials)
[ ] Access auditing enabled
[ ] Regular access reviews scheduled

Rotation:
[ ] Automatic rotation configured for long-lived secrets
[ ] Rotation procedures documented
[ ] Emergency rotation playbook exists
[ ] Rotation testing performed regularly

Monitoring:
[ ] Secret access logged and monitored
[ ] Alerts configured for anomalous access
[ ] Failed access attempts tracked
[ ] Compliance reporting automated

Development:
[ ] .env files in .gitignore
[ ] Pre-commit hooks scan for secrets
[ ] Secrets never in logs or error messages
[ ] Development uses separate secret namespace
```

### Junior → FAANG: The Checklist as a Forcing Function

A production checklist for secrets is only useful if it is consulted before deployment, not after an incident. Junior engineers who treat it as a post-hoc verification exercise miss the point.

**Gap to close:** For each item in the checklist, know the specific tool or mechanism that satisfies it. "Pre-commit hooks scan for secrets" is satisfied by `gitleaks` configured in `.pre-commit-config.yaml`. "Secrets never in logs" is satisfied by a structured logger with field redaction. "Development uses separate secret namespace" is satisfied by Vault namespace separation or separate Secrets Manager paths. If you cannot name the tool, you cannot verify the control.

**First-job practice:** Run through this checklist on your current service before your next deploy. Check each box honestly. For any unchecked box, create a ticket and prioritize it in the next sprint. This habit demonstrates production ownership beyond your direct feature work.

### Senior @ FAANG: Automating the Checklist

At senior level, a manual checklist is a starting point. The target state is that every item on the checklist is verified automatically before deployment.

**Deployment gate automation:** Map each checklist item to a CI/CD gate. "Pre-commit hooks scan for secrets" maps to a gitleaks step in the CI pipeline that blocks deployment if secrets are detected. "Rotation configured" maps to a check against the secrets manager inventory that verifies each secret has a rotation schedule configured. "Secrets never in logs" maps to a log sampling test in staging that searches for common secret patterns in log output. When all items are automated, the checklist verifies the automation, not the engineer's memory.

**Quarterly audit:** Even with automation, run a quarterly manual audit against the checklist for each critical service. Automation can have gaps or be bypassed. A human audit catches the gaps that automated gates miss, and the combination of automated and manual verification is the highest-assurance posture for secrets management compliance.

---
