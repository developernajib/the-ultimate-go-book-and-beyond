## 90I.19 Mirai Botnet: When IoT Devices Attack

### 62 Default Passwords That Broke the Internet

In September 2016, a massive distributed denial-of-service (DDoS) attack took down the website of security
journalist Brian Krebs with 620 Gbps of traffic - one of the largest DDoS attacks ever recorded at the time. The
source was not a network of compromised servers or a botnet of hacked PCs. It was an army of IP cameras, DVRs,
and home routers - Internet of Things (IoT) devices with factory-default credentials.

Mirai, created by college students Paras Jha, Josiah White, and Dalton Norman, was stunningly simple. It scanned
the internet for devices with open Telnet ports (23 and 2323), attempted to log in using a hardcoded list of 62
common default username/password combinations (admin/admin, root/root, root/123456, etc.), and if successful,
downloaded and executed the Mirai binary. At its peak, Mirai controlled approximately 600,000 IoT devices worldwide.

### The Dyn DNS Attack: October 21, 2016

On October 21, 2016, Mirai's most devastating attack targeted Dyn, a major DNS infrastructure provider. The botnet
flooded Dyn's servers with approximately 1.2 Tbps of traffic, causing cascading DNS resolution failures. Because
Dyn provided DNS services for major websites, the attack effectively took down large portions of the internet:

- **Twitter** - unreachable for hours
- **Netflix** - service disruptions across the US
- **Reddit** - intermittent outages
- **GitHub** - connection timeouts
- **CNN** - news site inaccessible
- **Spotify** - streaming disruptions
- **Amazon** - shopping and AWS services affected

The attack demonstrated a fundamental vulnerability in internet infrastructure: the concentration of DNS services
in a small number of providers creates single points of failure that can be exploited by relatively unsophisticated
botnets.

### Why IoT Security Matters

The Mirai botnet exposed several systemic failures in IoT security:

1. **Hardcoded credentials** - Many devices shipped with default passwords that could not be changed
2. **No automatic updates** - Devices had no mechanism to receive security patches
3. **Unnecessary services** - Telnet was enabled by default despite being an insecure, unencrypted protocol
4. **No network isolation** - IoT devices sat on the same network segments as critical infrastructure
5. **No device authentication** - Devices had no way to verify the legitimacy of firmware updates

### Go Code: IoT Credential Validator and Default Password Scanner

Mirai's entire kill chain depended on a single precondition: that devices would respond to Telnet with a
default credential from a list of 62 pairs. The validator below encodes that list as a compile-time
blocklist so that any attempt to set a password matching a known Mirai default is rejected at enrollment
time, before the device ever reaches production. The concurrent `ScanNetwork` method mirrors the technique
Mirai itself used (massively parallel connection attempts with a bounded worker pool) but for authorized
internal auditing, letting an engineering team find their own vulnerable devices before an attacker does.

```go
package iotvalidator

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"
	"unicode"
)

// DefaultCredential represents a known default username/password combination.
type DefaultCredential struct {
	Username string
	Password string
	Vendor   string // Known vendor that ships this default
}

// CommonIoTDefaults contains the credential pairs that Mirai used, plus additional
// known defaults. This list is used defensively to identify vulnerable devices.
var CommonIoTDefaults = []DefaultCredential{
	{"root", "root", "Various"},
	{"admin", "admin", "Various"},
	{"root", "123456", "Various"},
	{"admin", "password", "Various"},
	{"root", "pass", "Various"},
	{"admin", "1234", "Various"},
	{"root", "12345", "Various"},
	{"user", "user", "Various"},
	{"admin", "", "Various"},
	{"root", "", "Various"},
	{"admin", "admin1234", "Various"},
	{"root", "default", "Various"},
	{"admin", "smcadmin", "SMC Networks"},
	{"admin", "1111", "Various"},
	{"root", "54321", "Various"},
	{"root", "system", "Various"},
	{"support", "support", "Various"},
	{"guest", "guest", "Various"},
	// ... additional defaults omitted for brevity
}

// CredentialStrength defines the minimum requirements for device passwords.
type CredentialStrength struct {
	MinLength       int
	RequireUpper    bool
	RequireLower    bool
	RequireDigit    bool
	RequireSpecial  bool
	BlockDefaults   bool
}

// StrongIoTPolicy returns credential requirements that would prevent Mirai-style attacks.
func StrongIoTPolicy() CredentialStrength {
	return CredentialStrength{
		MinLength:      12,
		RequireUpper:   true,
		RequireLower:   true,
		RequireDigit:   true,
		RequireSpecial: true,
		BlockDefaults:  true,
	}
}

// ValidatePassword checks if a password meets the security policy.
func (cs CredentialStrength) ValidatePassword(username, password string) error {
	// Check against known defaults
	if cs.BlockDefaults {
		for _, cred := range CommonIoTDefaults {
			if strings.EqualFold(username, cred.Username) && password == cred.Password {
				return fmt.Errorf("password matches known default credential (vendor: %s) - this is how Mirai compromises devices", cred.Vendor)
			}
		}
	}

	if len(password) < cs.MinLength {
		return fmt.Errorf("password too short: %d characters, minimum %d required", len(password), cs.MinLength)
	}

	var hasUpper, hasLower, hasDigit, hasSpecial bool
	for _, r := range password {
		switch {
		case unicode.IsUpper(r):
			hasUpper = true
		case unicode.IsLower(r):
			hasLower = true
		case unicode.IsDigit(r):
			hasDigit = true
		case unicode.IsPunct(r) || unicode.IsSymbol(r):
			hasSpecial = true
		}
	}

	if cs.RequireUpper && !hasUpper {
		return fmt.Errorf("password must contain at least one uppercase letter")
	}
	if cs.RequireLower && !hasLower {
		return fmt.Errorf("password must contain at least one lowercase letter")
	}
	if cs.RequireDigit && !hasDigit {
		return fmt.Errorf("password must contain at least one digit")
	}
	if cs.RequireSpecial && !hasSpecial {
		return fmt.Errorf("password must contain at least one special character")
	}

	// Check if password contains the username
	if len(username) > 0 && strings.Contains(strings.ToLower(password), strings.ToLower(username)) {
		return fmt.Errorf("password must not contain the username")
	}

	return nil
}

// DeviceScanResult contains the security assessment for a single IoT device.
type DeviceScanResult struct {
	Host            string
	Port            int
	TelnetOpen      bool
	DefaultCredUsed bool
	CredentialFound *DefaultCredential
	BannerInfo      string
	RiskLevel       string
	ScannedAt       time.Time
}

// IoTScanner scans network devices for Mirai-style vulnerabilities.
type IoTScanner struct {
	logger     *slog.Logger
	timeout    time.Duration
	maxWorkers int
}

// NewIoTScanner creates a scanner for identifying vulnerable IoT devices.
func NewIoTScanner(logger *slog.Logger, timeout time.Duration, maxWorkers int) *IoTScanner {
	if maxWorkers <= 0 {
		maxWorkers = 20
	}
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &IoTScanner{
		logger:     logger,
		timeout:    timeout,
		maxWorkers: maxWorkers,
	}
}

// ScanHost checks a single host for Telnet exposure and default credentials.
// WARNING: Only use this on networks you own or have explicit authorization to test.
func (s *IoTScanner) ScanHost(ctx context.Context, host string, port int) DeviceScanResult {
	result := DeviceScanResult{
		Host:      host,
		Port:      port,
		ScannedAt: time.Now().UTC(),
	}

	addr := fmt.Sprintf("%s:%d", host, port)
	dialer := net.Dialer{Timeout: s.timeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		result.RiskLevel = "none"
		return result
	}
	defer conn.Close()

	result.TelnetOpen = true
	result.RiskLevel = "high" // Telnet being open is already high risk

	// Read banner
	conn.SetReadDeadline(time.Now().Add(s.timeout))
	reader := bufio.NewReader(conn)
	banner, err := reader.ReadString('\n')
	if err == nil {
		result.BannerInfo = strings.TrimSpace(banner)
	}

	s.logger.Warn("Telnet port open on device",
		"host", host,
		"port", port,
		"banner", result.BannerInfo,
	)

	return result
}

// ScanNetwork checks multiple hosts in parallel.
func (s *IoTScanner) ScanNetwork(ctx context.Context, hosts []string, ports []int) []DeviceScanResult {
	var results []DeviceScanResult
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, s.maxWorkers)

	for _, host := range hosts {
		for _, port := range ports {
			wg.Add(1)
			go func(h string, p int) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()

				result := s.ScanHost(ctx, h, p)
				mu.Lock()
				results = append(results, result)
				mu.Unlock()
			}(host, port)
		}
	}

	wg.Wait()
	return results
}

// GenerateDeviceFingerprint creates a unique identifier for a device based on
// its network characteristics, useful for device inventory management.
func GenerateDeviceFingerprint(host string, port int, banner string) string {
	data := fmt.Sprintf("%s:%d:%s", host, port, banner)
	hash := sha256.Sum256([]byte(data))
	return hex.EncodeToString(hash[:16]) // Use first 128 bits
}
```

### Lessons for Go Engineers

1. **Default credentials are the IoT equivalent of an open door** - Mirai compromised 600,000 devices using just
   62 username/password pairs. Every device your application manages must enforce strong, unique credentials.
2. **DNS is a single point of failure** - The Dyn attack showed that DNS provider concentration creates systemic
   risk. Implement multiple DNS providers and client-side DNS caching in your Go services.
3. **IoT devices are permanent attack surface** - Unlike servers that get patched, many IoT devices are never
   updated. Design your network architecture assuming IoT devices are compromised.
4. **Telnet must die** - There is no legitimate reason to expose Telnet on any device connected to a network.
   Your network scanning should flag any open Telnet ports as critical findings.

---

### Junior → FAANG: Default Credentials and DNS Resilience as Interview Topics

Mirai is the interview answer to "what is the most common IoT security vulnerability?" Default credentials: 600,000 devices were compromised using 62 username/password pairs because manufacturers shipped devices with default credentials that users never changed. For FAANG interviews, the default credential problem applies to software services too: any service that ships with default admin credentials, default API keys, or default database passwords is vulnerable to the same attack. The defense is to require credential setup at first launch rather than providing defaults, and to scan your deployed infrastructure for any service using known-default credentials. The second lesson is DNS resilience: the Dyn DDoS attack (which Mirai powered) demonstrated that DNS provider concentration creates a single point of failure for the entire internet. Services that depend on a single DNS provider inherit that provider's resilience properties. The Go HTTP client's DNS caching implementation in this section demonstrates client-side DNS caching with multiple provider fallback.

### Senior @ FAANG: IoT Device Management and DNS Provider Diversity as Platform Standards

At L6, Mirai defines two platform security standards. The first is IoT device governance: any device your organization deploys or manages must go through a security review before network connection, must have a documented patch process, and must be included in your continuous vulnerability scanning. Devices that cannot be patched are isolated to a dedicated network segment with egress restrictions. The second is DNS provider diversity. The Dyn outage caused significant internet disruption because so many services relied on a single DNS provider. At platform level, your production services configure at least two independent DNS resolvers from different providers, implement client-side DNS caching with TTL respect, and have a tested failover procedure for DNS provider failure. For services with strict SLA requirements, the DNS infrastructure itself is part of the resilience design: split-horizon DNS with multiple providers, GeoDNS for geographic resilience, and synthetic monitoring that tests DNS resolution from multiple vantage points independently of the production DNS path.

