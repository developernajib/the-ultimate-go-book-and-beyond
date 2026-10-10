## 110.11 Mid-Chapter Synthesis: Core Supply Chain Security Concepts Recap

Supply chain security is multi-layered and requires vigilance at every stage:

**Dependency Management**
- ✓ Regular vulnerability scanning with `govulncheck`
- ✓ Automated updates for security patches
- ✓ Review dependency changes in PRs
- ✓ Pin dependencies to specific versions

**Build Security**
- ✓ Reproducible builds with verified hashes
- ✓ Build provenance generation (SLSA)
- ✓ Minimal base images (distroless)
- ✓ Multi-stage builds to reduce attack surface

**Distribution Security**
- ✓ Image scanning before deployment
- ✓ Image signing with cosign
- ✓ SBOM generation and distribution
- ✓ Secure private module hosting

**Continuous Monitoring**
- ✓ Daily automated vulnerability scans
- ✓ Dependency update notifications
- ✓ Security audit logging
- ✓ Incident response procedures

### Junior → FAANG: Supply Chain Security Is a Team Sport

The chapter summary makes clear that supply chain security is not one person's responsibility. It spans source code, dependencies, build pipelines, container images, and deployment infrastructure. Juniors contribute most effectively by owning one layer deeply.

**Gap to close:** Pick one layer from the summary checklist and become the expert on your team for that layer. If you focus on dependency scanning, know every `govulncheck` flag, how to integrate it into CI, how to triage findings, and how to communicate the results to non-security engineers. Depth in one area is more valuable than shallow knowledge of all areas.

**First-job goal:** By the end of your first six months, ensure that every item in the checklist for your team's primary service is checked. Unchecked items become improvement proposals for the next planning cycle.

### Senior @ FAANG: Supply Chain Security as an Organizational Investment

At senior level, the summary checklist is an organizational compliance standard. Your role is ensuring every team can check every box, not just your own team.

**Compliance tracking:** Convert the checklist into a compliance dashboard that shows the status for every service across the organization. Services that fail a checklist item appear in the dashboard with the owning team. The dashboard is reviewed in the quarterly security posture meeting. Teams with persistent failures receive additional support (not blame) to resolve the gaps.

**Supply chain security roadmap:** Present the supply chain security roadmap to leadership using a maturity model: where are we today (percentage of services with SBOM, percentage pinning base images, SLSA level), where are we targeting (specific metrics at specific dates), and what investment is required. This executive-facing communication skill is required for staff engineers who want to secure organizational investment in security programs.

---
