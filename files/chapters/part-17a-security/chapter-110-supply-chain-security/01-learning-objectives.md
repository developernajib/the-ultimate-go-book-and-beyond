## Learning Objectives

By the end of this chapter, you will:

- Understand software supply chain attack vectors and real-world incidents
- Use `govulncheck` to scan dependencies for known vulnerabilities
- Generate and validate Software Bill of Materials (SBOM)
- Build reproducible binaries with consistent hashes
- Implement SLSA (Supply-chain Levels for Software Artifacts) framework
- Scan and sign container images for production deployment
- Secure private module distribution and authentication
- Integrate automated dependency scanning into CI/CD pipelines

### Junior → FAANG: Mapping Objectives to Concrete Skills

Each learning objective maps to a specific tool or technique that appears in supply chain security interviews and code reviews. Juniors who can name both the objective and the implementation are interview-ready.

**Gap to close:** The most commonly tested objective is dependency scanning. Know how `govulncheck` works (it analyzes your call graph, not just your imports, to find reachable vulnerabilities), what it produces (a report of affected packages and the CVE details), and how to integrate it in CI (it returns a non-zero exit code when vulnerabilities are found, which fails the CI job). Many juniors know about vulnerability scanning in theory but have never actually run `govulncheck` against a real codebase.

**Interview framing:** When asked "how do you detect vulnerabilities in your Go dependencies?", describe the three-layer approach: `govulncheck` for known CVEs in reachable code, `go list -m all` to audit the dependency list for unexpected additions, and `go.sum` verification to ensure integrity. Three layers is a stronger answer than one tool.

### Senior @ FAANG: Supply Chain Learning Objectives as Organizational Capabilities

At senior level, these objectives are not just personal skills: they are organizational capabilities that you are responsible for building and maintaining.

**Capability assessment:** For each objective, assess your organization's current maturity: is this done? is it automated? is it enforced? is it measured? An objective that is "done" by one team but not automated across all teams is a maturity gap. A staff engineer's job is to raise the whole organization's maturity level on each objective, not just their own team's.

**Tool standardization:** When multiple teams use different tools for the same objective (one team uses `govulncheck`, another uses `nancy`, another uses Snyk), you have fragmentation that complicates auditing and governance. Standardize on a single tool per objective, document the rationale, and provide a shared CI template that all teams can adopt. This reduces the operational burden on individual teams while increasing organizational compliance.

---
