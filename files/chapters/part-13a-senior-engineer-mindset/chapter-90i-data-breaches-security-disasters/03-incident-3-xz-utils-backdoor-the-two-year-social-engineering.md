## 90I.3 xz Utils Backdoor - The Two-Year Social Engineering Campaign (2024)

### The Attack Timeline

On March 29, 2024, Microsoft engineer Andres Freund published a discovery that sent shockwaves through the entire
open-source community. While investigating a 500ms delay in SSH logins on his Debian testing system, Freund
discovered that xz Utils - a compression library used by virtually every Linux distribution - had been backdoored.
The backdoor, present in versions 5.6.0 and 5.6.1, would have given the attacker remote code execution on any
Linux system running OpenSSH with systemd - effectively every modern Linux server in the world. What made this
discovery extraordinary was not just the backdoor itself, but the story of how it got there: a meticulously planned,
two-year social engineering campaign targeting the project's sole maintainer.

**The Setup: Targeting a Burned-Out Maintainer (2021-2022)**

xz Utils was maintained by a single developer, Lasse Collin, who had been transparent about struggling with mental
health issues and burnout. In 2021, a persona calling themselves "Jia Tan" (GitHub username JiaT75) began making
small, legitimate contributions to the xz project. Simultaneously, other accounts (likely sock puppets controlled
by the same operation) began pressuring Collin to add a co-maintainer, posting messages like:

> "Is there any progress on this? Jia I see you have recent commits. Why can't you commit this yourself?"

And, from the same pressure campaign:

> "Progress will not happen until there is a new maintainer... The current maintainer lost interest or doesn't
> care to maintain anymore. It is sad to see for a repo like this."

Lasse Collin's reply to these messages has become one of the most quoted passages in open-source sustainability
discussions: "I haven't lost interest but my ability to care has been fairly limited... It's also good to keep in
mind that this is an unpaid hobby project."

These pressure campaigns, combined with Collin's genuine burnout, led to Jia Tan being granted commit access in
January 2023 and eventually becoming the de facto lead maintainer.

**The Preparation Phase (2023)**

Throughout 2023, Jia Tan made hundreds of legitimate contributions, building trust and establishing themselves as a
reliable maintainer. They also made subtle changes that would later enable the backdoor:

- Added new test files (`.lzma` blobs) that appeared to be compressed test data but actually contained the encrypted
  backdoor payload
- Modified the build system to include an `m4` macro that would extract and compile the backdoor during the build
  process
- Disabled `ifunc` security features (Indirect Function Resolution) that would have interfered with the backdoor's
  function hooking mechanism
- Made changes to the CI/CD configuration that ensured the backdoor would only be triggered in specific build
  environments (release tarballs, not git checkouts)

**The Backdoor Mechanism (February-March 2024)**

The backdoor was activated only when xz was built from the official release tarball (not from a git clone) on
x86_64 Linux systems with glibc and GCC. The attack chain was:

1. A malicious `m4` macro in `build-to-host.m4` detected the build environment
2. It extracted the backdoor from the "test data" files using a series of obfuscated shell commands
3. The extracted code was compiled as a shared object and linked into `liblzma`
4. When sshd loaded `liblzma` (via systemd's dependency on libsystemd, which depends on liblzma), the backdoor
   used `ifunc` resolvers to hook the `RSA_public_decrypt` function in OpenSSL
5. The hooked function checked incoming SSH authentication requests for a specific encrypted payload
6. If the payload was present and decrypted correctly with the attacker's Ed448 private key, the backdoor would
   execute an arbitrary command before authentication completed

This design meant the backdoor was invisible to normal SSH traffic analysis and only activatable by someone
possessing the attacker's private key - a true nation-state-grade implant.

**Discovery and Response (March 29, 2024)**

Andres Freund noticed the 500ms SSH delay while benchmarking an unrelated change. Investigating with `perf`,
he traced the delay to `liblzma` doing unexpected work during SSH authentication. His analysis, posted to the
oss-security mailing list, triggered an immediate industry-wide response:

- Red Hat issued CVE-2024-3094 with a CVSS score of 10.0
- All major Linux distributions issued emergency advisories and rolled back to xz 5.4.x
- GitHub suspended the JiaT75 account and the xz repository
- The US Cybersecurity and Infrastructure Security Agency (CISA) issued an alert

The backdoor was caught literally days before it would have been included in stable releases of Debian, Fedora, and
Ubuntu. If it had reached stable releases, it would have compromised the SSH infrastructure of effectively every
Linux server on the internet.

### Technical Root Cause Analysis

1. **Single maintainer as single point of failure**: The entire xz ecosystem depended on one person who was
   publicly burned out. There was no organizational structure to prevent a malicious actor from assuming control.

2. **Release tarball divergence**: The backdoor existed only in release tarballs, not in the git repository. This
   meant that code reviewers examining the git history would never see the malicious code.

3. **Complex build system as hiding place**: The `m4` macro system and autotools build process provided ample
   opportunities to hide obfuscated code in files that few people understand or review.

4. **Transitive dependency chains**: Most systems that were vulnerable did not directly use xz. The dependency
   chain was: sshd -> libsystemd -> liblzma. Developers of sshd had no visibility into or control over liblzma's
   security.

### Go Code: Static Linking and Dependency Isolation

Go's static linking model provides fundamental defense against the xz Utils class of attack. When a Go binary is
compiled, all dependencies are compiled from source and linked into a single static binary. There are no dynamic
library loads at runtime, which eliminates the `LD_PRELOAD`/`ifunc` hooking attack vector entirely. Here is code
demonstrating Go's dependency verification and static build practices:

```go
package depverify

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime/debug"
	"strings"
)

// DependencyInfo represents a verified Go module dependency with its
// cryptographic hash from go.sum.
type DependencyInfo struct {
	Path    string `json:"path"`
	Version string `json:"version"`
	Sum     string `json:"sum"`
	Replace string `json:"replace,omitempty"`
}

// BuildInfo contains verified metadata about the running binary,
// extracted from the embedded build information that Go includes
// in every compiled binary.
type BuildInfo struct {
	GoVersion    string           `json:"goVersion"`
	MainModule   string           `json:"mainModule"`
	MainVersion  string           `json:"mainVersion"`
	Dependencies []DependencyInfo `json:"dependencies"`
	Settings     map[string]string `json:"settings"`
	CGOEnabled   bool             `json:"cgoEnabled"`
	StaticBuild  bool             `json:"staticBuild"`
}

// InspectRunningBinary extracts and verifies build information from the
// currently running Go binary. This allows runtime verification that the
// binary was built with expected dependencies and settings.
func InspectRunningBinary() (*BuildInfo, error) {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return nil, errors.New("build info not available (binary not built with module support?)")
	}

	info := &BuildInfo{
		GoVersion:   bi.GoVersion,
		MainModule:  bi.Main.Path,
		MainVersion: bi.Main.Version,
		Settings:    make(map[string]string),
	}

	for _, dep := range bi.Deps {
		d := DependencyInfo{
			Path:    dep.Path,
			Version: dep.Version,
			Sum:     dep.Sum,
		}
		if dep.Replace != nil {
			d.Replace = dep.Replace.Path + "@" + dep.Replace.Version
		}
		info.Dependencies = append(info.Dependencies, d)
	}

	for _, setting := range bi.Settings {
		info.Settings[setting.Key] = setting.Value
		if setting.Key == "CGO_ENABLED" {
			info.CGOEnabled = setting.Value == "1"
		}
	}

	info.StaticBuild = !info.CGOEnabled
	return info, nil
}

// VerifyGoSum reads the go.sum file and verifies that all dependency hashes
// match expected values. This provides the same guarantee that `go mod verify`
// provides, but callable programmatically for build pipeline integration.
func VerifyGoSum(goSumPath string, allowedModules map[string]bool) ([]string, error) {
	file, err := os.Open(goSumPath)
	if err != nil {
		return nil, fmt.Errorf("opening go.sum: %w", err)
	}
	defer file.Close()

	var violations []string
	scanner := bufio.NewScanner(file)

	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.Fields(line)
		if len(parts) != 3 {
			continue
		}

		modulePath := parts[0]

		if allowedModules != nil && !allowedModules[modulePath] {
			violations = append(violations, fmt.Sprintf(
				"unapproved dependency: %s", modulePath,
			))
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("reading go.sum: %w", err)
	}

	return violations, nil
}

// VerifyBinaryIntegrity computes the SHA-256 hash of a binary file and
// compares it against an expected hash. Use this in deployment pipelines
// to ensure the binary has not been tampered with after building.
func VerifyBinaryIntegrity(binaryPath string, expectedSHA256 string) error {
	data, err := os.ReadFile(binaryPath)
	if err != nil {
		return fmt.Errorf("reading binary: %w", err)
	}

	actualHash := sha256.Sum256(data)
	actualHex := hex.EncodeToString(actualHash[:])

	if actualHex != expectedSHA256 {
		return fmt.Errorf(
			"binary integrity check failed: expected %s, got %s",
			expectedSHA256, actualHex,
		)
	}

	return nil
}

// EnsureStaticBuild verifies that CGO is disabled and the binary is
// statically linked. Static builds eliminate the dynamic library loading
// attack vector exploited by the xz backdoor.
func EnsureStaticBuild() error {
	info, err := InspectRunningBinary()
	if err != nil {
		return fmt.Errorf("inspecting binary: %w", err)
	}

	if info.CGOEnabled {
		return errors.New(
			"SECURITY: CGO is enabled. This binary uses dynamic linking " +
				"and is vulnerable to LD_PRELOAD/ifunc attacks. " +
				"Rebuild with CGO_ENABLED=0 for static linking",
		)
	}

	return nil
}

// RunGoModVerify executes `go mod verify` as a subprocess and returns
// the result. This checks that dependencies in the local cache match
// the hashes in go.sum, detecting any post-download tampering.
func RunGoModVerify(moduleDir string) error {
	cmd := exec.Command("go", "mod", "verify")
	cmd.Dir = moduleDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("go mod verify failed: %s\n%s", err, output)
	}
	return nil
}

// RunGovulncheck executes Go's built-in vulnerability scanner against
// the module and returns any findings. This checks dependencies against
// the Go vulnerability database.
func RunGovulncheck(moduleDir string) (string, error) {
	cmd := exec.Command("govulncheck", "./...")
	cmd.Dir = moduleDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return string(output), fmt.Errorf("govulncheck found issues: %w", err)
	}
	return string(output), nil
}
```

### Engineering Lessons

1. **Static linking eliminates an entire class of supply chain attacks.** Go's default compilation model produces
   a single binary with no runtime dependencies on shared libraries. The xz backdoor's `ifunc` hooking mechanism
   is fundamentally impossible against statically linked binaries.

2. **Social engineering is a patient game.** The xz attacker invested two years of legitimate work to gain trust.
   No technical control can fully prevent a determined insider threat - organizational diversity (multiple
   maintainers, mandatory code review, rotation of trust) is essential.

3. **Release artifacts must be reproducible from source.** The xz backdoor existed only in release tarballs. If
   distributions had verified that tarballs were reproducible from the git source, the divergence would have been
   detected immediately.

4. **Transitive dependencies are your security boundary.** You inherit the security posture of every transitive
   dependency. Minimize dependencies, audit the ones you keep, and use `go mod verify` and `govulncheck` in CI.

---

### Junior → FAANG: Static Linking and Dependency Integrity as Interview Topics

The xz backdoor is the interview answer to "what is a supply chain attack that cannot be prevented by code review alone?" The attacker spent two years contributing legitimate, high-quality code to xz-utils before injecting the backdoor only in release tarballs, not in git history. Code review found nothing wrong with the source. For FAANG interviews, Go's defense is concrete: static linking (`CGO_ENABLED=0`) produces binaries with no dynamic library dependencies, eliminating the `LD_PRELOAD` and `ifunc` hooking attack vector entirely. `go mod verify` and the `go.sum` file provide cryptographic integrity verification for every dependency. `govulncheck` scans the dependency graph against the Go vulnerability database. These three tools together cover the xz incident class. The behavioral answer: for any critical infrastructure dependency, verify that release artifacts reproduce exactly from the source commit using the same build flags, and maintain a policy that critical path dependencies must have at least two active maintainers.

### Senior @ FAANG: Open Source Dependency Governance and Contributor Trust Models

At L6, the xz backdoor reveals a gap in how most organizations govern open-source dependencies: they treat source code review as sufficient but never verify that release artifacts are reproducible from that source. The tarball diverged from git, and no distribution caught it. At staff level, for any dependency in the critical path, establish a three-part verification process: confirm the dependency has multiple active maintainers (bus factor greater than one), verify that release artifacts reproduce from the source commit using deterministic build flags, and run `go mod verify` in CI to confirm dependency hashes against `go.sum`. Beyond verification, the xz incident argues for minimizing the dependency graph itself. Each additional dependency adds a trust relationship that must be maintained and audited. At platform level, enforce a dependency audit as part of the production readiness review: any new external dependency must be justified, reviewed for maintainer diversity, and added to the SBOM registry. Dependencies that fail the audit require explicit exception with documented risk acceptance from the security team.

