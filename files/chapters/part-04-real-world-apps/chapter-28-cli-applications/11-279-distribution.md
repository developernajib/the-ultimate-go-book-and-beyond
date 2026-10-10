## 28.9 Distribution

### Cross-Platform Builds

The build configuration automates compilation, testing, and code generation steps. Encoding these commands in a Makefile or shell script ensures that all contributors run identical commands and that CI uses the same process as local development. The hand-rolled script below is useful for understanding what happens during a cross-compile, in production CI in 2026, you should use **GoReleaser** (next section) which replaces all of this plus archives, checksums, SBOMs, signing, Homebrew taps, Scoop manifests, apt/rpm packages, and Docker multi-arch images in one YAML file.

```bash
#!/bin/bash
# build.sh

VERSION=$(git describe --tags --always)
LDFLAGS="-s -w -X main.Version=$VERSION"

platforms=(
    "darwin/amd64"
    "darwin/arm64"
    "linux/amd64"
    "linux/arm64"
    "windows/amd64"
)

for platform in "${platforms[@]}"; do
    GOOS="${platform%/*}"
    GOARCH="${platform#*/}"
    output="dist/myapp-${GOOS}-${GOARCH}"

    if [ "$GOOS" = "windows" ]; then
        output+=".exe"
    fi

    echo "Building $output..."
    CGO_ENABLED=0 GOOS=$GOOS GOARCH=$GOARCH go build -ldflags="$LDFLAGS" -o "$output"
done

# Create archives
cd dist
for f in myapp-*; do
    if [[ "$f" == *.exe ]]; then
        zip "${f%.exe}.zip" "$f"
    else
        tar czf "$f.tar.gz" "$f"
    fi
done
```

### Installation Script

A curl-pipe-bash installation script downloads the correct binary for the user's OS and architecture, then places it in a standard location like `/usr/local/bin`. The script detects the platform with `uname`, fetches the latest release tag from the GitHub API, and extracts the archive in one pipeline. Users can install the tool with a single command: `curl -sSL https://example.com/install.sh | bash`.

```bash
#!/bin/bash
# install.sh

set -e

REPO="username/myapp"
BINARY="myapp"
INSTALL_DIR="/usr/local/bin"

# Detect OS and arch
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case $ARCH in
    x86_64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
esac

# Get latest release
VERSION=$(curl -s "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)

# Download
URL="https://github.com/$REPO/releases/download/$VERSION/${BINARY}-${OS}-${ARCH}.tar.gz"
echo "Downloading $URL..."

curl -sL "$URL" | tar xz -C /tmp
sudo mv "/tmp/$BINARY" "$INSTALL_DIR/"
sudo chmod +x "$INSTALL_DIR/$BINARY"

echo "Installed $BINARY $VERSION to $INSTALL_DIR"
```

### GoReleaser (Recommended)

GoReleaser is the de-facto standard for releasing Go CLIs in 2026. A single `.goreleaser.yaml` describes every build matrix entry, archive format, checksum algorithm, release channel, and package manager output. One `goreleaser release` invocation on a tag push produces signed archives for every OS/arch, uploads them to GitHub Releases, updates a Homebrew tap, publishes a Scoop manifest for Windows, builds and pushes multi-arch Docker images, generates an SBOM, and (optionally) signs everything with cosign, all from one CI job.

```yaml
# .goreleaser.yaml
version: 2

before:
  hooks:
    - go mod tidy

builds:
  - env: [CGO_ENABLED=0]
    goos: [linux, darwin, windows]
    goarch: [amd64, arm64]
    ldflags:
      - -s -w -X main.Version={{.Version}} -X main.Commit={{.Commit}} -X main.Date={{.Date}}

archives:
  - formats: [tar.gz]
    name_template: "{{ .ProjectName }}_{{ .Os }}_{{ .Arch }}"
    format_overrides:
      - goos: windows
        formats: [zip]

checksum:
  name_template: "checksums.txt"
  algorithm: sha256

brews:
  - repository:
      owner: username
      name: homebrew-tap
    homepage: "https://github.com/username/myapp"
    description: "A production-ready CLI tool"
    license: "MIT"
    test: |
      system "#{bin}/myapp --version"

dockers:
  - image_templates:
      - "ghcr.io/username/myapp:{{ .Version }}-amd64"
    use: buildx
    build_flag_templates: ["--platform=linux/amd64"]

sboms:
  - artifacts: archive

signs:
  - cmd: cosign
    args: ["sign-blob", "--yes", "--output-signature=${signature}", "${artifact}"]
    artifacts: checksum
```

Trigger it from GitHub Actions on every tag:

```yaml
# .github/workflows/release.yml
on: { push: { tags: ["v*"] } }
jobs:
  goreleaser:
    runs-on: ubuntu-latest
    permissions: { contents: write, packages: write, id-token: write }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-go@v5
        with: { go-version: "1.27" }
      - uses: sigstore/cosign-installer@v3
      - uses: goreleaser/goreleaser-action@v6
        with: { args: release --clean }
        env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
```

Most production Go CLIs, `gh`, `k9s`, `syft`, `grype`, `charm`, release this way.

### Junior to FAANG: distribution basics

Cross-compilation in Go is a single command. `GOOS=linux GOARCH=amd64 go build`. This is the single biggest reason Go dominates CLI tooling. You can build a Windows binary from your Mac without installing anything Windows-related. Understand this and you have a superpower.

CGO_ENABLED=0 is the default you want for CLIs. It produces a fully static binary with no libc dependency, which runs on Alpine, scratch containers, and any Linux version. If CGO is enabled (required for `net` DNS resolution using the system resolver, for SQLite, or for any C library), the binary depends on the building system's glibc version and may fail on older Linuxes. Unless you need CGO, disable it, and document the decision.

Worked example of a first release. Tag the repo with `git tag v0.1.0 && git push --tags`. GitHub Actions runs GoReleaser. Fifteen minutes later, GitHub Releases has six archives, a checksums file, SBOM, and a Homebrew formula PR. Users can `brew install yourtap/myapp`. Total config, one `.goreleaser.yaml`. This is the single most high-value piece of tooling in the Go ecosystem.

Installation script pitfalls. `curl | bash` is widely criticized because a compromised server can inject arbitrary code. Many companies block it. If you ship one, pin versions, validate checksums, and prefer `curl | bash -s -- --verify` patterns. Alternative, tell users to `brew install`, `apt install`, or download and run. Reserve `curl | bash` for emergency install flows, not as the primary.

Interview entry point. "How do you ship a Go CLI to Windows, macOS, and Linux users?" Answer. GoReleaser on tag push. Explain the GitHub Actions integration, the archive layout, the Homebrew tap, the Scoop manifest. Bonus points for mentioning SBOM generation and cosign signing. This is standard knowledge in 2026.

### Senior at FAANG: distribution as supply chain

Staff concerns for distribution.

Supply chain security is non-negotiable. Every binary must have. SLSA level 3 provenance attestation generated by GitHub Actions. Cosign signature using keyless OIDC from the CI provider. SBOM in SPDX or CycloneDX format attached to the release. SHA-256 checksums signed by the same key. Reproducible builds verified by a second CI runner rebuilding the same commit and comparing. Without these, a nation-state xz-utils-style supply chain attack can compromise your users and you cannot detect it.

Reproducibility in practice. Three requirements. Pinned Go toolchain via `toolchain go1.27.1` in `go.mod`. Pinned dependencies via `go.mod` with `go.sum` verified in CI (`go mod verify`). Build flags `-trimpath -ldflags="-s -w -buildid= -X main.date=${SOURCE_DATE_EPOCH}"` where `SOURCE_DATE_EPOCH` comes from the git commit time. Two engineers on two different machines must produce byte-identical binaries. Audit with `sha256sum` after every release. This is the foundation of SLSA provenance.

Distribution channel matrix. Every channel has maintenance cost. The staff ADR lists channels and SLAs. "Homebrew tap updated within 15 minutes of release (automated via GoReleaser). Scoop manifest updated within 15 minutes. winget manifest updated within 24 hours (requires manual PR due to Microsoft review). apt and rpm packages published within 1 hour via nfpms. Docker image published to ghcr.io within 15 minutes. Nix flake updated within 48 hours via nixpkgs PR. curl-pipe-sh installer hosted at install.mycompany.com with 99.9 percent availability SLA." Every channel is a commitment. Do not add channels without an owner.

Homebrew governance. Your Homebrew tap is a public commitment. Users assume the latest tap version works. When a release is bad, you must yank the tap update within minutes, which requires a separate release pipeline for hotfixes. `gh` had a bad Homebrew release in 2023 that was yanked in 20 minutes via an automated rollback. Have this runbook before you need it.

winget, Scoop, Chocolatey for Windows. Windows has three competing package managers. The staff strategy. winget (Microsoft's official) for mainstream users, Scoop for developers, Chocolatey for enterprises. Submit to all three. GoReleaser supports winget and Scoop natively. Chocolatey requires a manual PR. The Windows ecosystem expects signed MSIs, so ship those too via `wixl` or `wix`.

Code signing on Windows and macOS. Unsigned binaries on macOS trigger Gatekeeper warnings that scare users. Sign with an Apple Developer ID certificate and notarize through `notarytool`. On Windows, sign with an EV code signing certificate (hardware-backed HSM, $500 per year). Without signing, Windows SmartScreen blocks your tool for days or weeks until enough users click through. Signing is a required cost of shipping to end users in 2026.

Binary size governance. Publish a size budget. "The CLI binary must not exceed 30 MB compressed, 80 MB uncompressed, on any platform. PRs adding dependencies that push size over budget require Staff engineer approval." Audit with `go tool nm` and `goweight`. Common offenders. `kubernetes/client-go` (15 MB), `aws-sdk-go-v2` service clients (variable, can be large if importing all), `google.golang.org/api` (large). Lazy-load via plugins if a single package dominates.

Release cadence. Weekly or fortnightly is the norm. `gh` releases roughly weekly. `kubectl` releases a new minor about three times a year, with patch releases monthly. Establish a cadence, communicate it, and stick to it. Unpredictable releases erode enterprise trust. Predictable releases let users plan upgrades.

Semver discipline. Major version bumps are breaking changes. Minor version bumps add features. Patch bumps fix bugs. This is not optional at FAANG scale. A breaking change in a patch release is a career-limiting incident because every downstream CI pinned to `~0.5.0` now breaks silently.

Channel strategy. Stable, beta, nightly. Stable is what we ship. Beta is what power users opt into. Nightly is what we dogfood internally. GoReleaser supports multiple channels via separate configs. Users pick their channel with `brew install myapp@beta` or a version suffix. This lets you catch regressions in beta before promoting to stable.

Deprecation of installation methods. If you drop support for 32-bit Linux or Windows 7, document the timeline. Keep the last compatible version available for download forever. Users on abandoned platforms need access to the last working version for archival reasons.

Observability of installations. Track install success rates per channel and per platform (if your installer reports back, respecting privacy). Detect install failures quickly. `gh` discovered a Windows 11 installer bug via increased failure telemetry before most users noticed.

Incident runbook for bad releases. Steps. Detect via error rate dashboards or user reports. Verify reproducibility. Revert Homebrew tap, Scoop manifest, winget manifest, and GitHub "latest release" marker. Communicate via GitHub release notes, tool-internal update check banner, and developer community channels. Publish a post-mortem with root cause. Average time to rollback across FAANG CLI platforms is 30 minutes. Aim for under an hour. Anything longer is a process maturity problem.

Cross-compilation matrix expansion. Beyond the obvious six (darwin/amd64, darwin/arm64, linux/amd64, linux/arm64, windows/amd64, windows/arm64), consider linux/386 for legacy systems, freebsd/amd64 for server ops community, and linux/ppc64le for enterprise Linux on Power. Each adds CI time and maintenance. Pick based on user analytics. If 0.1 percent of users need ppc64le and they are paying enterprise customers, ship it. Otherwise do not.

---
