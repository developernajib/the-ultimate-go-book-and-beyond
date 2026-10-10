## Summary

### Supply Chain Security Checklist

| Phase | Tool | Purpose |
|-------|------|---------|
| Dependency | govulncheck | Vulnerability scanning |
| Dependency | go mod verify | Integrity verification |
| Build | -trimpath flag | Reproducible builds |
| Build | SLSA generator | Build provenance |
| Container | Trivy | Image vulnerability scanning |
| Container | cosign | Image signing/verification |
| Artifacts | syft | SBOM generation |
| CI/CD | gosec | Static security analysis |

### Quick Reference Commands

These commands cover the full supply-chain hardening lifecycle for a Go project, from dependency auditing through container signing. Run `govulncheck` and `go mod verify` in every CI pipeline to catch known CVEs and tampered module checksums before they reach production. SBOM generation with `syft` and image signing with `cosign` complement the SLSA provenance generated in your release pipeline.

```bash
# Dependency security
govulncheck ./...
go mod verify
go mod tidy

# SBOM generation
syft dir:. -o spdx-json > sbom.json

# Container security
trivy image --severity CRITICAL,HIGH myapp:latest
cosign sign --key cosign.key myapp:latest
cosign verify --key cosign.pub myapp:latest

# Reproducible build
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o app

# Private modules routed through an internal proxy
export GOPROXY="https://proxy.yourcompany.com,https://proxy.golang.org,direct"
export GONOSUMDB="github.com/yourcompany/*"
# Or, without an internal proxy, fetch private modules directly from VCS:
# export GOPRIVATE="github.com/yourcompany/*"
```

### Junior → FAANG: Quick Reference as a Pre-Deployment Gate

This quick reference is a pre-deployment gate checklist for supply chain security. Before shipping a new service or a significant change to an existing service, run through every item.

**Gap to close:** The most commonly skipped item is GOPROXY configuration with the internal proxy first. Without this, your service may accidentally pull a dependency from the public module proxy instead of your approved internal proxy, bypassing your vulnerability scanning and access control.

**First-job action:** Configure these environment variables in your local development environment and in your team's CI/CD pipeline template this week. The configuration changes take 30 minutes and affect every future build.

### Senior @ FAANG: Quick Reference as an Onboarding Checklist

At senior level, the quick reference is an onboarding checklist for new services. Every new service that your team creates should pass through this checklist before it is considered production-ready.

**New service gate:** Add "supply chain security checklist" as a required item in your team's new service creation runbook. The runbook specifies who is responsible for verifying each item (the creating engineer, the tech lead, the security champion) and what evidence demonstrates compliance (CI pipeline screenshot, artifact repository configuration screenshot). Checklists without evidence are aspirational. Checklists with evidence are auditable.

---

## Navigation

- **Previous Chapter:** [Chapter 109: Secrets Management](../chapter-109-secrets-management/16-summary.md)
- **Part Overview:** [Part XVII-A: Security](../00-part-intro.md)
- **Next Chapter:** [Chapter 111: Zero Trust Architecture](../chapter-111-zero-trust/00-introduction.md)
