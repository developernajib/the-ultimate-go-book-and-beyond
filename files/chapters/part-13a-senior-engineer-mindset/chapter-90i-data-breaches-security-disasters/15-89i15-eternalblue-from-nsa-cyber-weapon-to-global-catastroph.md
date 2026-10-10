## 90I.15 EternalBlue: From NSA Cyber Weapon to Global Catastrophe

### The Origin: NSA's Tailored Access Operations

EternalBlue was not born in a criminal underground or a rogue hacker's basement. It was developed by the United
States National Security Agency's elite hacking unit, Tailored Access Operations (TAO), as a classified cyber
weapon. The exploit targeted CVE-2017-0144, a critical buffer overflow vulnerability in Microsoft's Server Message
Block version 1 (SMBv1) protocol - the file-sharing protocol used by virtually every Windows machine on the planet.

SMBv1, designed in the 1980s, was never built for the modern internet. It lacked encryption, had weak authentication,
and contained numerous memory safety issues that were artifacts of an era when network security meant physical
isolation. The NSA discovered that a specially crafted SMB transaction request could overflow a kernel pool buffer,
allowing arbitrary code execution with SYSTEM privileges - the highest level of access on a Windows machine. This
was not just a vulnerability. It was a skeleton key to every unpatched Windows computer reachable over a network.

The NSA held this vulnerability secret for at least five years, using it for intelligence operations across the globe.
During this period, every Windows system on Earth remained vulnerable - not because no patch existed, but because
the agency responsible for "signals intelligence" chose offensive capability over defensive disclosure. This decision
would have consequences measured in billions of dollars and hundreds of thousands of compromised systems.

### The Shadow Brokers Leak

On August 13, 2016, a mysterious group calling themselves "The Shadow Brokers" announced they had stolen a cache of
cyber weapons from the NSA's Equation Group (widely believed to be TAO). Over the following months, they released
tools in waves, each more damaging than the last.

On April 14, 2017, the Shadow Brokers released their most devastating dump: a collection of Windows exploits
including EternalBlue, EternalRomance, EternalSynergy, and DoublePulsar (a backdoor implant). The release included
fully weaponized exploit code ready for immediate use.

Microsoft had been tipped off - likely by the NSA once the theft was confirmed - and released patch MS17-010 on
March 14, 2017, exactly one month before the Shadow Brokers dump. But the gap between patch availability and
actual deployment would prove catastrophic. Enterprises move slowly. Legacy systems cannot always be updated.
Many organizations had no patching process at all.

### The Vulnerabilities Equities Process Debate

EternalBlue ignited a fierce debate about the US government's Vulnerabilities Equities Process (VEP) - the policy
framework for deciding whether to disclose discovered vulnerabilities or retain them for intelligence use.

Critics argued that stockpiling zero-days creates an inherent national security risk: any vulnerability the NSA
hoards could be stolen (as happened) or independently discovered by adversaries. The value of the exploit
diminishes with time as systems are updated, but the risk persists until every vulnerable system is patched.

Defenders of the VEP argued that signals intelligence saves lives and that the NSA discloses the majority of
vulnerabilities it discovers. But EternalBlue demonstrated the catastrophic downside: when a stockpiled weapon leaks,
the damage dwarfs whatever intelligence value it provided.

The combined damage from WannaCry ($4-8 billion) and NotPetya ($10+ billion) - both powered by EternalBlue - far
exceeded any plausible intelligence benefit from keeping the vulnerability secret.

### The Technical Vulnerability: CVE-2017-0144

The vulnerability existed in the way SMBv1 handled transaction requests. When processing a `TRANS2_OPEN2` sub-command,
the SMB server failed to properly validate the size of certain fields, leading to a kernel pool buffer overflow. An
attacker could send specially crafted packets that overwrote adjacent memory in the Windows kernel pool, achieving
arbitrary code execution with SYSTEM-level privileges.

The exploit was particularly dangerous because:
1. **No authentication required** - the attacker only needed network access to port 445
2. **Kernel-level execution** - code ran with the highest possible privileges
3. **Wormable** - it could spread automatically without user interaction
4. **Ubiquitous target** - SMBv1 was enabled by default on all Windows versions

### Go Code: SMB Connection Validator and Exposure Scanner

The key to containing EternalBlue exposure is knowing which hosts on your network still respond to SMBv1 negotiate requests before an attacker finds them first. The validator below sends a raw SMB negotiate packet listing both the SMBv1 `NT LM 0.12` dialect and the SMBv2/3 dialects, then inspects the response's 4-byte signature field: `0xFF 0x53 0x4D 0x42` identifies an SMBv1 response and marks the host as immediately vulnerable, while `0xFE 0x53 0x4D 0x42` indicates SMBv2 or later and triggers dialect and signing-flag parsing to assess whether the stronger version is also properly hardened.

```go
package smbvalidator

import (
	"context"
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"
)

// SMBVersion represents the SMB protocol version detected on a host.
type SMBVersion int

const (
	SMBVersionUnknown SMBVersion = iota
	SMBv1Only
	SMBv2
	SMBv3
	SMBv3Encrypted
)

func (v SMBVersion) String() string {
	switch v {
	case SMBv1Only:
		return "SMBv1 (VULNERABLE - must disable)"
	case SMBv2:
		return "SMBv2 (outdated - upgrade recommended)"
	case SMBv3:
		return "SMBv3 (acceptable)"
	case SMBv3Encrypted:
		return "SMBv3 with encryption (recommended)"
	default:
		return "Unknown"
	}
}

// ScanResult contains the findings for a single host.
type ScanResult struct {
	Host        string
	Port        int
	Open        bool
	Version     SMBVersion
	Signing     bool
	Encryption  bool
	Vulnerable  bool
	Error       error
	ScannedAt   time.Time
}

// SMBValidator scans network hosts to identify dangerous SMB configurations.
type SMBValidator struct {
	logger      *slog.Logger
	timeout     time.Duration
	maxWorkers  int
}

// NewSMBValidator creates a validator with the given configuration.
func NewSMBValidator(logger *slog.Logger, timeout time.Duration, maxWorkers int) *SMBValidator {
	if maxWorkers <= 0 {
		maxWorkers = 10
	}
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &SMBValidator{
		logger:     logger,
		timeout:    timeout,
		maxWorkers: maxWorkers,
	}
}

// SMB negotiate protocol request header for detecting SMBv1 support.
// This sends a minimal negotiate request to determine which dialects the server supports.
var smbNegotiateRequest = []byte{
	// NetBIOS session header
	0x00, 0x00, 0x00, 0x54, // length (will be recalculated)
	// SMB Header
	0xFF, 0x53, 0x4D, 0x42, // Server Component: SMB
	0x72,                   // Command: Negotiate Protocol
	0x00, 0x00, 0x00, 0x00, // Status
	0x18,                   // Flags
	0x01, 0x28,             // Flags2
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Extra
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Extra
	0x00, 0x00, 0x00, 0x00, // Tree ID, Process ID
	0x00, 0x00,             // User ID
	0x00, 0x00,             // Multiplex ID
	// Negotiate Protocol Request
	0x00,       // Word Count
	0x31, 0x00, // Byte Count
	// Dialect: NT LM 0.12 (SMBv1)
	0x02, 0x4E, 0x54, 0x20, 0x4C, 0x4D, 0x20, 0x30,
	0x2E, 0x31, 0x32, 0x00,
	// Dialect: SMB 2.002
	0x02, 0x53, 0x4D, 0x42, 0x20, 0x32, 0x2E, 0x30,
	0x30, 0x32, 0x00,
	// Dialect: SMB 2.???
	0x02, 0x53, 0x4D, 0x42, 0x20, 0x32, 0x2E, 0x3F,
	0x3F, 0x3F, 0x00,
}

// ValidateHost checks a single host for SMB exposure and vulnerability indicators.
func (v *SMBValidator) ValidateHost(ctx context.Context, host string, port int) ScanResult {
	result := ScanResult{
		Host:      host,
		Port:      port,
		ScannedAt: time.Now().UTC(),
	}

	addr := fmt.Sprintf("%s:%d", host, port)

	// Attempt TCP connection with timeout
	dialer := net.Dialer{Timeout: v.timeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		result.Error = fmt.Errorf("connection failed: %w", err)
		return result
	}
	defer conn.Close()

	result.Open = true

	// Set read/write deadline
	deadline := time.Now().Add(v.timeout)
	conn.SetDeadline(deadline)

	// Send SMB negotiate request
	_, err = conn.Write(smbNegotiateRequest)
	if err != nil {
		result.Error = fmt.Errorf("failed to send negotiate: %w", err)
		return result
	}

	// Read response
	respBuf := make([]byte, 1024)
	n, err := conn.Read(respBuf)
	if err != nil {
		result.Error = fmt.Errorf("failed to read response: %w", err)
		return result
	}

	if n < 36 {
		result.Error = fmt.Errorf("response too short: %d bytes", n)
		return result
	}

	// Parse the response to determine SMB version
	// Check for SMB1 signature (0xFF, 'S', 'M', 'B')
	if n >= 8 && respBuf[4] == 0xFF && respBuf[5] == 0x53 && respBuf[6] == 0x4D && respBuf[7] == 0x42 {
		result.Version = SMBv1Only
		result.Vulnerable = true
		v.logger.Warn("SMBv1 detected - host is vulnerable to EternalBlue",
			"host", host, "port", port)
	}

	// Check for SMB2/3 signature (0xFE, 'S', 'M', 'B')
	if n >= 8 && respBuf[4] == 0xFE && respBuf[5] == 0x53 && respBuf[6] == 0x4D && respBuf[7] == 0x42 {
		// Parse dialect from negotiate response to determine exact version
		if n >= 72 {
			dialect := binary.LittleEndian.Uint16(respBuf[72:74])
			switch {
			case dialect >= 0x0311:
				result.Version = SMBv3Encrypted
				result.Encryption = true
			case dialect >= 0x0300:
				result.Version = SMBv3
			default:
				result.Version = SMBv2
			}
		}

		// Check if signing is required (SecurityMode field)
		if n >= 70 {
			secMode := binary.LittleEndian.Uint16(respBuf[70:72])
			result.Signing = (secMode & 0x02) != 0 // NEGOTIATE_SIGNING_REQUIRED
		}
	}

	return result
}

// ScanNetwork validates all hosts in parallel and returns results.
func (v *SMBValidator) ScanNetwork(ctx context.Context, hosts []string, port int) []ScanResult {
	results := make([]ScanResult, len(hosts))
	var wg sync.WaitGroup
	sem := make(chan struct{}, v.maxWorkers)

	for i, host := range hosts {
		wg.Add(1)
		go func(idx int, h string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			results[idx] = v.ValidateHost(ctx, h, port)
		}(i, host)
	}

	wg.Wait()
	return results
}

// EnforceSMBv1Disabled checks results and returns an error if any host has SMBv1 enabled.
func EnforceSMBv1Disabled(results []ScanResult) error {
	var vulnerable []string
	for _, r := range results {
		if r.Vulnerable {
			vulnerable = append(vulnerable, fmt.Sprintf("%s:%d", r.Host, r.Port))
		}
	}
	if len(vulnerable) > 0 {
		return fmt.Errorf("CRITICAL: %d hosts have SMBv1 enabled (vulnerable to EternalBlue): %v",
			len(vulnerable), vulnerable)
	}
	return nil
}

// HardenedTLSConfig returns a hardened TLS configuration that disables legacy protocols.
func HardenedTLSConfig() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS13,
		CipherSuites: []uint16{
			tls.TLS_AES_256_GCM_SHA384,
			tls.TLS_CHACHA20_POLY1305_SHA256,
			tls.TLS_AES_128_GCM_SHA256,
		},
		PreferServerCipherSuites: true,
	}
}
```

### Lessons for Go Engineers

1. **Legacy protocols are liabilities** - SMBv1 should have been disabled years before EternalBlue. Your systems
   must actively detect and block legacy protocol usage, not just avoid using them yourself.
2. **Vulnerability stockpiling is a systemic risk** - Whether it is a government agency or your own security team
   sitting on a known vulnerability, every day a bug goes unpatched is a day the attack surface remains open.
3. **Patch deployment speed is a security metric** - Microsoft patched CVE-2017-0144 a month before the exploit
   leaked, yet hundreds of thousands of systems were compromised. Automated patching pipelines are not optional.
4. **Network scanning must be continuous** - The Go scanner above should run as a scheduled job, not a one-time
   audit. New vulnerable systems appear constantly as machines are provisioned, restored from backup, or connected
   to the network.

---

### Junior → FAANG: Legacy Protocol Risk and Patch Deployment Speed as Interview Topics

EternalBlue is the interview answer to "how do you handle legacy protocol risk?" SMBv1 had known security flaws for years but remained enabled by default on millions of Windows systems because disabling it broke legacy compatibility. For FAANG interviews, the lesson is: legacy protocol support is a security liability that must be actively managed, not ignored. In Go services, this means: detect and block connections using deprecated TLS versions (require TLS 1.2 minimum, prefer TLS 1.3), disable cipher suites with known weaknesses, and never add compatibility workarounds for clients that refuse to upgrade. The second lesson is patch deployment speed as a security metric. Microsoft patched the SMBv1 vulnerability a month before EternalBlue was released publicly, yet hundreds of thousands of systems remained unpatched. Automated patch deployment with a defined SLA for critical patches (24-48 hours for CVSS 9+) is a security requirement, not an operational preference.

### Senior @ FAANG: Vulnerability Stockpiling Risk and Continuous Network Scanning as Platform Standards

At L6, EternalBlue raises a policy question: should organizations with vulnerability research capabilities stockpile zero-days for offensive use? The NSA's decision to stockpile EternalBlue rather than report it to Microsoft meant that hundreds of thousands of systems remained vulnerable for years. When Shadow Brokers leaked the exploits, the attack surface was immediately weaponized. At staff level, if your organization has a security research function that discovers vulnerabilities in third-party software, you establish a responsible disclosure policy: vulnerabilities in software your users depend on are reported to the vendor within a defined window (typically 90 days) regardless of their offensive utility. This is not just ethical: it is risk management. A stockpiled zero-day is a liability that becomes your problem the moment it leaks. The continuous network scanning platform (the Go scanner in this section running as a scheduled job against your entire fleet) is the operational capability that detects vulnerable systems before attackers do.

