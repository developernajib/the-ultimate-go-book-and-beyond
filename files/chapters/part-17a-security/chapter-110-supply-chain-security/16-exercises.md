## Exercises

1. **SBOM Generation and Validation Pipeline**: Write a Go program that shells out to `syft` to generate an SPDX-JSON SBOM for the current module, parses the resulting JSON, and prints a report listing every dependency with a known CVE by cross-referencing the OSV API (`api.osv.dev/v1/query`). Expected outcome: a single binary that produces a human-readable vulnerability summary from SBOM data, runnable in CI with a non-zero exit code when critical CVEs are found.

2. **Sigstore Keyless Container Signing**: Integrate `cosign` keyless signing into a Go-based CI helper that: builds a Docker image using the Docker SDK, pushes it to a registry, signs it via `cosign sign` with OIDC identity (GitHub Actions or Google Workload Identity), and then immediately verifies the signature with `cosign verify`. Expected outcome: every image pushed by the pipeline has a Rekor transparency log entry and fails verification if the signature is missing or tampered.

3. **Dependency Vulnerability Scanner with Policy Enforcement**: Build a Go CLI that runs `govulncheck -json ./...` against a target module, parses the output, and enforces a configurable severity policy from a YAML file (e.g., `fail_on: [CRITICAL, HIGH]`). The tool must produce a SARIF report for GitHub Code Scanning integration and exit non-zero only when policy violations exist. Expected outcome: a scanner that can be dropped into any Go project's CI pipeline without code changes, driven entirely by the policy YAML.

4. **Reproducible Build Verifier**: Write a Go program that builds the same module twice using `CGO_ENABLED=0 go build -trimpath` with identical `GOFLAGS` and compares the resulting binary SHA-256 hashes. If hashes differ, the tool must diff the `strings` output of both binaries to identify non-deterministic embedded data (e.g., timestamps, random identifiers). Expected outcome: a verifier that confirms reproducibility or pinpoints the specific source of non-determinism.

5. **SLSA Provenance Attestation Verifier**: Implement a Go tool that fetches a container image's SLSA provenance attestation from a registry using the OCI referrers API, decodes the in-toto statement, and validates that `builder.id` matches an allow-listed GitHub Actions workflow URL and that the statement's `predicateType` is `"https://slsa.dev/provenance/v1"`. Expected outcome: a policy-enforcement tool that rejects images lacking valid SLSA Level 2+ provenance, suitable for use as a Kubernetes admission webhook.

6. **Private Module Proxy with Integrity Logging**: Implement a minimal Go module proxy (implementing the `GOPROXY` protocol: `$module/@v/list`, `$module/@v/$version.info`, `.mod`, `.zip`) that forwards requests to `proxy.golang.org`, caches responses locally, and writes a tamper-evident SHA-256 log entry for every module version served. Expected outcome: an auditable proxy that records every dependency fetch with cryptographic hashes, enabling post-incident verification that no dependency was silently substituted.

**Next Chapter**: Chapter 111 (Zero Trust Architecture) explores implementing zero trust security principles in Go applications.

### Junior → FAANG: Exercise 6 as a Standout Portfolio Project

Exercise 6 (private module proxy with integrity logging) is the most complex in this chapter and the most impressive as a portfolio project. A working Go module proxy that logs every dependency fetch with cryptographic hashes is a production-quality security tool.

**Gap to close:** Understand the GOPROXY protocol before implementing: the proxy must implement three endpoints per module version (`.info`, `.mod`, `.zip`). The Go toolchain calls these endpoints in order. Your proxy fetches from the upstream proxy, logs the response hash, and serves the cached response. This architecture (transparent proxy with audit logging) is a pattern that applies beyond Go modules to any dependency management system.

**Implementation advice:** Start with the three endpoints for a single module, verify that `go get` resolves through your proxy, and then add the integrity logging. Trying to implement everything at once is a common mistake. Incremental implementation with testing at each step is the production engineering approach.

### Senior @ FAANG: Using These Exercises to Identify L6 Candidates

For senior engineering interviews, these exercises serve as take-home problems that reveal architectural thinking and security depth.

**Exercise 6 evaluation criteria for L6:** A complete L6 solution for the proxy with integrity logging includes: correct GOPROXY protocol implementation (all three endpoints), a tamper-evident log using hash chaining (each entry's hash includes the previous entry's hash), concurrent-safe log writing (multiple proxy requests can occur in parallel), a `Verify` method that detects any tampering in O(n) time, and a fuzzer that confirms detection. Candidates who produce this complete solution with tests demonstrate the technical depth expected at L6.

**Design question escalation:** After a candidate submits the proxy exercise, ask: "Your organization wants to use this proxy for all Go builds across 50 services. What changes would you make to make it production-ready?" This escalation tests: availability (single point of failure, how to make HA), authentication (which services can fetch which modules), performance (caching strategy, CDN for module ZIPs), and observability (metrics for cache hit rate, fetch latency, error rate). The answer reveals whether the candidate thinks in systems (L6) or in components (L4).

---
