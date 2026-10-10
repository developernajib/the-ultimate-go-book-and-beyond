## 110.1 Software Supply Chain Overview

### What is Supply Chain Security?

The software supply chain includes all components that go into your application:

```
Your Application
├── Direct dependencies (go.mod)
├── Transitive dependencies (indirect)
├── Build tools (Go compiler, Docker)
├── Base images (alpine, distroless)
├── CI/CD pipeline tools
└── Deployment infrastructure
```

### Attack Vectors

**1. Dependency Confusion**
- Attacker publishes malicious package with same name as internal package
- Build system downloads public version instead of private

**2. Typosquatting**
- Package names similar to popular libraries (e.g., `gorila` vs `gorilla`)

**3. Compromised Maintainer Accounts**
- Attacker gains access to maintainer credentials
- Pushes malicious code to legitimate package

**4. Compromised Build Pipeline**
- CI/CD system compromised to inject malicious code during build

### Real-World Incidents

**SolarWinds (2020)**
- Build system compromise
- Malicious code injected into signed updates
- Affected thousands of organizations

**Codecov (2021)**
- Bash uploader script compromised
- Credentials stolen from CI/CD environments

**ua-parser-js (2021)**
- npm package with 8M weekly downloads compromised
- Cryptocurrency miners and credential stealers injected

### Junior → FAANG: Understanding the Supply Chain Threat Model

The supply chain threat model is fundamentally different from application vulnerability threat models. In a supply chain attack, the attacker targets the tools and dependencies you trust, not your own code. This changes the defenses needed.

**Gap to close:** Understand the three main supply chain attack vectors: (1) dependency confusion (attacker publishes a package with the same name as your private module in a public registry, and your build system picks it up), (2) typosquatting (attacker publishes `gogithuub/some-popular-lib` hoping a developer makes a typo), (3) account takeover (attacker compromises the credentials of a legitimate maintainer and publishes a malicious version of a real library). Each requires different defenses.

**Go-specific protections:** Go's module proxy and checksum database (`sum.golang.org`) provide integrity verification for public modules. The checksum database is a transparency log: every module version published is recorded, and you can verify that the module you downloaded matches the record. This protects against compromised CDN nodes or MITM attacks. Keep `GOSUMDB` enabled (the default) and set `GOPRIVATE` (or the finer-grained `GONOSUMDB`) only for private modules that should never be looked up in the public transparency log.

**Interview framing:** When asked about supply chain security in Go, describe the defense-in-depth stack: `go.sum` for integrity verification, `govulncheck` for known vulnerabilities, module proxy (`GOPROXY`) configuration to prevent dependency confusion, and SBOM generation for incident response. This four-layer answer covers the major supply chain attack vectors.

### Senior @ FAANG: Supply Chain Risk as Organizational Risk

At senior level, supply chain risk is quantified and managed as organizational risk, not just technical risk. The SolarWinds attack illustrated that supply chain compromises can affect thousands of organizations simultaneously through a single vendor relationship.

**Vendor risk assessment:** For dependencies that are critical to your application (used in security-sensitive code paths, or in the build pipeline itself), conduct vendor risk assessments: who maintains the package? What is their security disclosure track record? Do they have 2FA enabled on their repository and registry accounts? Are their releases signed? These questions convert informal trust into documented risk decisions.

**Dependency graph reduction:** Every dependency is an attack surface. Staff engineers regularly audit the dependency graph and remove unused or redundant dependencies. The target is the smallest dependency graph that satisfies the application's requirements. Each removed dependency reduces the supply chain attack surface. Track dependency count as a metric: a growing dependency count without a corresponding growth in functionality signals dependency accumulation that should be reviewed.

**SLSA provenance as a vendor requirement:** For high-value software (security tooling, infrastructure automation, build tools), require that vendors provide SLSA-compliant provenance for their artifacts. This provenance allows you to verify that the artifact was built from the stated source on an approved build platform and was not tampered with after build. Making provenance a vendor requirement creates market pressure for secure supply chain practices and protects your organization from supply chain attacks on your tools.

---
