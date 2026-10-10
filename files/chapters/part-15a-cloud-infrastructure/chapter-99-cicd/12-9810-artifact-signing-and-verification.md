## 99.12 Artifact Signing and Verification

### Container Image Signing with Cosign

```yaml
# .github/workflows/sign.yaml
name: Build and Sign

on:
  push:
    tags: ['v*']

jobs:
  build-sign:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write  # Needed for OIDC

    steps:
      - uses: actions/checkout@v4

      - name: Install Cosign
        uses: sigstore/cosign-installer@v3

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        id: build
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.ref_name }}

      - name: Sign image with cosign
        run: |
          cosign sign --yes \
            ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}

      - name: Verify signature
        run: |
          cosign verify \
            --certificate-identity-regexp="https://github.com/${{ github.repository }}/*" \
            --certificate-oidc-issuer="https://token.actions.githubusercontent.com" \
            ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}
```

### Binary Signing with GoReleaser

GoReleaser automates the full release pipeline, cross-compiling for multiple OS/arch targets, packaging archives, generating a `checksums.txt` file, and then invoking `cosign sign-blob` to attach a cryptographic signature and certificate to the checksum file rather than every individual binary. Signing the checksum file is sufficient because verifying that one file against its Sigstore certificate proves the integrity of every binary listed inside it, keeping the release asset count manageable without weakening the trust chain.

```yaml
# .goreleaser.yaml
version: 1

before:
  hooks:
    - go mod tidy
    - go generate ./...

builds:
  - env:
      - CGO_ENABLED=0
    goos:
      - linux
      - darwin
      - windows
    goarch:
      - amd64
      - arm64
    ldflags:
      - -s -w
      - -X main.Version={{.Version}}
      - -X main.Commit={{.Commit}}
      - -X main.Date={{.Date}}

archives:
  - format: tar.gz
    format_overrides:
      - goos: windows
        format: zip

checksum:
  name_template: 'checksums.txt'

signs:
  - cmd: cosign
    signature: "${artifact}.sig"
    certificate: "${artifact}.pem"
    args:
      - sign-blob
      - --yes
      - --output-signature=${signature}
      - --output-certificate=${certificate}
      - ${artifact}
    artifacts: checksum

docker_signs:
  - cmd: cosign
    args:
      - sign
      - --yes
      - ${artifact}
    artifacts: all

dockers:
  - image_templates:
      - "ghcr.io/myorg/myapp:{{ .Tag }}"
      - "ghcr.io/myorg/myapp:latest"
    dockerfile: Dockerfile
    build_flag_templates:
      - "--label=org.opencontainers.image.created={{.Date}}"
      - "--label=org.opencontainers.image.revision={{.FullCommit}}"
      - "--label=org.opencontainers.image.version={{.Version}}"

release:
  github:
    owner: myorg
    name: myapp
  prerelease: auto
  draft: false
```

```yaml
# .github/workflows/release.yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write
  packages: write
  id-token: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.27'

      - name: Install Cosign
        uses: sigstore/cosign-installer@v3

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Run GoReleaser
        uses: goreleaser/goreleaser-action@v5
        with:
          version: latest
          args: release --clean
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

### Junior → FAANG: Artifact Signing as Security Hygiene

Artifact signing answers the question: can you prove that this container image (or binary) was built from this specific source commit in this specific CI run? Without signing, an attacker who gains write access to your container registry can push a malicious image with the same tag as your legitimate image, and the deployment system has no way to detect the substitution.

cosign with Sigstore is the current industry standard for container image signing. The keyless signing flow (where cosign uses the GitHub Actions OIDC token to create a short-lived certificate for the signature, rather than requiring a long-lived private key) is simpler to operate than key-based signing and provides stronger security guarantees because there is no long-lived private key to manage or rotate.

First-job habit: add image signing to the CI pipeline immediately after the push step. The signature is stored in the same registry alongside the image (as an OCI artifact). Verifying the signature before deploying (`cosign verify`) closes the loop and ensures the deployment system only runs images that came from your CI pipeline.

### Senior @ FAANG: Artifact Signing as Supply-Chain Security Infrastructure

At staff level, artifact signing is part of a broader supply-chain security architecture (often called SLSA, Supply-chain Levels for Software Artifacts). SLSA defines a maturity model from Level 0 (no guarantees) to Level 4 (hermetic, reproducible builds with full provenance).

The practical SLSA roadmap: SLSA Level 1 is provenance attestation (a signed document describing how the artifact was built). SLSA Level 2 adds signatures from a hosted CI/CD system (GitHub Actions, GitLab CI). SLSA Level 3 adds a hardened build environment (no access to secrets beyond those needed for the build, two-person review for build pipeline changes). SLSA Level 4 is hermetic, reproducible builds, which requires the significant build system investment described in the Bazel and reproducible builds sections.

The admission control integration is the enforcement layer: the Kubernetes admission controller verifies the cosign signature and provenance attestation before allowing a pod to run. This requires the cosign public key (or the Rekor transparency log entry) to be available to the admission controller and policy rules that specify which signatures are required for which namespaces. Designing this verification policy and maintaining it as signing keys rotate is a platform security engineering responsibility that needs dedicated operational procedures.
