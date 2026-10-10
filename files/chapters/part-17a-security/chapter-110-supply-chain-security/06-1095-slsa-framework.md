## 110.5 SLSA Framework

### SLSA Levels

SLSA (Supply-chain Levels for Software Artifacts) defines a graduated framework of controls for securing the software build pipeline against tampering and unauthorized modification. The v1.0 specification defines four build track levels, L0 through L3.

```
Level 0: No guarantees
├── Level 1: Provenance exists
│   └── Build process documented in generated provenance
├── Level 2: Hosted build platform
│   ├── Builds run on a hosted build service
│   └── Provenance signed by the platform
└── Level 3: Hardened builds
    ├── Isolated, ephemeral build environments
    └── Provenance is non-forgeable
```

### Build Provenance Generation

Build provenance records the inputs, environment, and process used to produce an artifact, enabling consumers to independently verify that the binary they received matches the published source. The following workflow generates a SLSA Level 3 provenance attestation for Go release artifacts using the SLSA GitHub generator reusable workflow.

```yaml
# .github/workflows/slsa.yml
name: SLSA Build

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: read
  id-token: write  # For signing

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      hashes: ${{ steps.hash.outputs.hashes }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Build binary
        run: |
          go build -trimpath -ldflags="-s -w" -o app ./cmd/server

      - name: Generate hash
        id: hash
        run: |
          echo "hashes=$(sha256sum app | base64 -w0)" >> "$GITHUB_OUTPUT"

      - name: Upload binary
        uses: actions/upload-artifact@v4
        with:
          name: app
          path: app

  provenance:
    needs: [build]
    permissions:
      actions: read
      id-token: write
      contents: write
    uses: slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v1.9.0
    with:
      base64-subjects: "${{ needs.build.outputs.hashes }}"
      upload-assets: true
```

### Junior → FAANG: SLSA as a Security Maturity Model

SLSA (Supply-chain Levels for Software Artifacts) provides a common vocabulary for discussing build security maturity. Understanding the levels and what each one requires is increasingly expected knowledge at security-conscious companies.

**Gap to close:** Know the SLSA v1.0 build levels in plain language. Level 1: build provenance is generated (you know what was built, when, and from what source). Level 2: builds run on a hosted platform that signs the provenance (you can verify who ran the build). Level 3: the build platform is hardened (the build runs in an isolated environment, no persistent credentials, provenance is non-forgeable). The earlier v0.1 draft had a Level 4 covering hermetic, reproducible builds and two-party review, but v1.0 caps the build track at Level 3. Most organizations are currently at Level 0 (no provenance) or Level 1. Level 3 is the current aspirational target for FAANG companies.

**First-job application:** When setting up a new GitHub Actions workflow for a Go release, use the `slsa-framework/slsa-github-generator` action. It produces SLSA Level 3 provenance for free as part of your existing GitHub Actions pipeline. This is the lowest-friction path to SLSA Level 3 for public GitHub repositories.

**Interview framing:** When asked about software supply chain security, mention SLSA and describe the level your organization is at. If you do not know, that is an honest answer, but follow it with "the first step I would take is to add provenance generation to our release pipeline, which achieves SLSA Level 1." This shows initiative and knowledge.

### Senior @ FAANG: SLSA as an Organizational Roadmap

At senior level, SLSA is a roadmap for building organizational capability, not just a framework for individual projects. Staff engineers define the organization's SLSA target, the timeline to achieve it, and the investment required.

**Cost-benefit of each SLSA level:** Level 1 is nearly free (add a provenance generation step to CI). Level 2 requires build platform support for signing (GitHub Actions, Cloud Build, and similar platforms provide this). Level 3 requires a hardened build platform with isolated builds and no persistent credentials: this requires significant CI/CD infrastructure investment but is achievable on major cloud-native build platforms. Beyond Level 3, the practices from the old draft Level 4 (hermetic, reproducible builds and two-party source review) remain worthwhile hardening even though v1.0 caps the build track at Level 3, and their engineering investment is the highest. Document the cost-benefit for each level and the business justification for your target level.

**SLSA as a customer signal:** Customers who are themselves regulated (financial services, healthcare, government) increasingly ask about supply chain security practices during vendor evaluations. SLSA documentation and provenance artifacts are tangible evidence of supply chain security maturity that non-technical evaluators can assess. Staff engineers who have implemented SLSA Level 3 and documented the implementation can point to it as evidence of security maturity in customer conversations, sales engineering calls, and compliance audits.

**Cross-function SLSA implementation:** Achieving SLSA Level 3 requires coordination across engineering (build pipeline changes), security (policy definition), platform (infrastructure hardening), and legal/compliance (documentation for audits). Staff engineers drive this cross-functional coordination. The technical aspects are often the easiest part: the harder work is aligning stakeholders, getting buy-in for infrastructure investment, and ensuring the compliance documentation accurately reflects the implementation.

---
