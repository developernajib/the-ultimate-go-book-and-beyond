## Supply Chain Security for C++ Dependencies

In March 2024, a backdoor was discovered in `xz-utils` version 5.6.0, a compression library used by OpenSSH on several Linux distributions. The attacker spent two years establishing trust in the project, gradually took over maintainership, and inserted code that would have given them remote code execution on any system running the backdoored version of sshd. The backdoor was caught by accident, by a Microsoft engineer investigating an unexplained 500ms latency in SSH connections.

This is not a theoretical threat. It happened to a widely-used, well-regarded library with an active maintainer community. C++ projects face heightened exposure because the ecosystem lacks the centralized, audited registry that Go's module proxy provides.

### Why C++ Supply Chain Is Harder

In Go, every dependency's source is fetched through the Go module proxy (sum.golang.org), which stores a tamper-evident log of every module version ever published. `go.sum` contains cryptographic hashes of every package your build depends on, both directly and transitively. Any deviation fails the build.

C++ has no equivalent default. The dominant package managers, vcpkg and Conan, support pinning and hash verification, but they are opt-in. Teams that skip these mechanisms are pulling source from GitHub with no integrity verification at build time.

### vcpkg: Baseline Versioning and Hash Verification

vcpkg's `vcpkg.json` supports a `builtin-baseline` that pins the exact version set from the vcpkg registry. Every archive downloaded by vcpkg is verified against a SHA512 hash stored in the portfiles, a compromise of the upstream server that produces a different binary will be caught.

```json
// vcpkg.json, production dependency manifest
{
    "name": "myapp",
    "version": "1.0.0",
    "builtin-baseline": "3265c187c74714c2c0541551f85cfd2de1bfaa3a",
    "dependencies": [
        {
            "name": "libsodium",
            "version>=": "1.0.19"
        },
        {
            "name": "fmt",
            "version>=": "10.2.1"
        },
        {
            "name": "openssl",
            "version>=": "3.3.0"
        },
        {
            "name": "abseil",
            "version>=": "20240116.2"
        }
    ],
    "overrides": [
        {
            "name": "zlib",
            "version": "1.3.1"
        }
    ]
}
```

The `builtin-baseline` is a commit hash in the vcpkg registry, it pins the exact version of every port definition, including the SHA512 hashes of upstream archives. Reproducible builds use this in combination with binary caching:

```bash
# Reproducible install: uses exact versions from baseline
vcpkg install --x-manifest-root=. --feature-flags=versions

# Export exact lock file for audit
vcpkg x-history libsodium

# Verify installed package hashes
vcpkg hash path/to/archive.tar.gz
```

For private packages, vcpkg supports custom registries, a Git repository containing port definitions with your own hash verification. Internal libraries should use this rather than being fetched directly from GitHub.

### Conan: Lock Files for Reproducible Builds

Conan's lock files capture the complete dependency graph including resolved versions, package IDs, and build configurations. Checking the lock file into source control makes builds reproducible across machines and time.

```bash
# Generate lock file from current dependency resolution
conan lock create conanfile.py --lockfile-out=conan.lock

# Install using exact locked versions
conan install . --lockfile=conan.lock

# Diff two lock files to understand what changed
conan lock diff old.lock new.lock
```

```python
# conanfile.py, with version pinning
from conan import ConanFile
from conan.tools.cmake import cmake_layout

class MyApp(ConanFile):
    requires = [
        "libsodium/1.0.19",
        "openssl/3.3.1",
        "fmt/10.2.1",
        "abseil/20240116.2",
    ]
    generators = "CMakeDeps", "CMakeToolchain"
    settings = "os", "compiler", "build_type", "arch"

    def layout(self):
        cmake_layout(self)
```

Using Artifactory as a private Conan remote with access control means that your builds only pull from packages you control and have audited, not from the public Conan Center that anyone can submit to.

### Bazel: SHA256 Hash Pinning

Bazel's `http_archive` rule requires explicit SHA256 hashes for all external downloads. The build fails if the download does not match, there is no way to accidentally pull an unverified dependency.

```python
# WORKSPACE, all external dependencies require sha256
load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

http_archive(
    name = "abseil_cpp",
    sha256 = "dcf71b9cba8dc0ca9940c4b316a0c796be8fab42410d6d1a8ac16a59ca78b88b",
    strip_prefix = "abseil-cpp-20240116.2",
    urls = [
        "https://github.com/abseil/abseil-cpp/archive/refs/tags/20240116.2.tar.gz",
        "https://mirror.example.com/abseil/20240116.2.tar.gz",  # private mirror
    ],
)

http_archive(
    name = "libsodium",
    sha256 = "6f504490b342a4f8a4c4a02fc9b866cbef8622d5df6626a76d70b53d0b4c47f0",
    strip_prefix = "libsodium-1.0.19",
    build_file = "//third_party:libsodium.BUILD",
    urls = [
        "https://download.libsodium.org/libsodium/releases/libsodium-1.0.19.tar.gz",
    ],
)
```

The `urls` list should include a private mirror, if GitHub is unavailable or the upstream URL changes, the build fails gracefully against the mirror rather than fetching from an untrusted alternate source.

### SBOM: Software Bill of Materials

Knowing what you ship requires knowing every library it contains. A Software Bill of Materials (SBOM) enumerates all dependencies, their versions, and their licenses in a machine-readable format.

```bash
# Generate SBOM using syft (CycloneDX format)
syft dir:./vendor -o cyclonedx-json > sbom.json

# Generate SBOM using vcpkg
vcpkg x-generate-default-port-manifest sbom.json

# Submit to GUAC (Graph for Understanding Artifact Composition)
# for supply chain graph analysis
```

```xml
<!-- CycloneDX SBOM fragment -->
<?xml version="1.0" encoding="UTF-8"?>
<bom xmlns="http://cyclonedx.org/schema/bom/1.4">
    <metadata>
        <timestamp>2024-03-15T12:00:00Z</timestamp>
    </metadata>
    <components>
        <component type="library">
            <name>libsodium</name>
            <version>1.0.19</version>
            <purl>pkg:github/jedisct1/libsodium@1.0.19</purl>
            <hashes>
                <hash alg="SHA-256">6f504490...</hash>
            </hashes>
        </component>
    </components>
</bom>
```

### Vulnerability Scanning

Known vulnerabilities in C++ dependencies are tracked in the OSV (Open Source Vulnerabilities) database, which aggregates NVD, GitHub Advisories, and other sources.

```bash
# osv-scanner: check all dependencies against OSV database
osv-scanner --lockfile=vcpkg.json

# trivy: container and dependency scanning with C++ support
trivy fs --scanners vuln .

# GitHub Dependabot: automatic PRs for vulnerable dependencies
# Supported for vcpkg (via vcpkg.json) and Conan since 2023
```

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: "vcpkg"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 10
```

### Reproducible Builds

A reproducible build produces bit-identical output from the same source and toolchain, regardless of when or where it is built. This lets you verify that a distributed binary matches the claimed source.

```bash
# Build with reproducibility flags
clang++ -fdebug-prefix-map=$PWD=. \
        -fmacro-prefix-map=$PWD=. \
        -Wdate-time \
        -o myapp src/main.cpp

# Compare two builds
diffoscope build1/myapp build2/myapp
# Should produce no output if builds are reproducible
```

Reproducible builds are enforced by Debian, Arch Linux, and Nix. They are an advanced goal but worthwhile for anything that ships binaries to users who cannot build from source.

### Code Signing

Release binaries should be signed so users can verify they came from you and were not tampered with in transit.

```bash
# GPG signing of release tarballs
gpg --armor --detach-sign myapp-1.0.0-linux-amd64.tar.gz

# Sigstore cosign: keyless signing using OIDC identity
cosign sign-blob --oidc-issuer https://accounts.google.com \
    myapp-1.0.0-linux-amd64.tar.gz

# Verify
cosign verify-blob --certificate-oidc-issuer https://accounts.google.com \
    --certificate-identity developer@example.com \
    myapp-1.0.0-linux-amd64.tar.gz
```

In Go, `go.sum` provides hash verification for all module downloads automatically, and `govulncheck` scans for known CVEs in all transitive dependencies with a single command. The equivalent in C++ requires combining vcpkg/Conan pinning with osv-scanner and a CI check. The primitives are all present, they require deliberate integration.

---
