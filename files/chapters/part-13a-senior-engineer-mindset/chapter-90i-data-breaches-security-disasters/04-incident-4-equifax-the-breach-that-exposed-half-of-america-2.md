## 90I.4 Equifax - The Breach That Exposed Half of America (2017)

### The Attack Timeline

On September 7, 2017, Equifax - one of the three major US credit reporting agencies - disclosed that attackers had
accessed the personal information of approximately 147 million Americans, including names, Social Security numbers,
birth dates, addresses, and in some cases driver's license numbers and credit card numbers. The breach remains one
of the largest and most consequential in history, not because of technical sophistication, but because of a cascade
of negligence that reads like a textbook on how not to manage security.

**Phase 1: The Unpatched Vulnerability (March 2017)**

On March 7, 2017, Apache disclosed CVE-2017-5638, a critical Remote Code Execution vulnerability in Apache Struts,
the web framework used by Equifax's consumer dispute portal. The vulnerability had a CVSS score of 10.0, and a
working exploit was available on the day of disclosure. Equifax's security team sent an internal notification about
the patch on March 8. The system administrators responsible for patching the vulnerable servers did not apply it.

**Phase 2: Initial Exploitation (May 13, 2017)**

Attackers exploited the unpatched Struts vulnerability on the consumer dispute portal on May 13, 2017 - 67 days
after the patch was available. The portal ran with elevated database privileges because it needed to access consumer
dispute records across multiple databases. The attackers gained access to Equifax's internal network.

**Phase 3: Lateral Movement (May - July 2017)**

Once inside, the attackers discovered something remarkable: Equifax stored unencrypted database credentials in plain
text configuration files. Using these credentials, they accessed 48 databases containing consumer records. They also
discovered that internal network traffic was largely unmonitored because the SSL/TLS inspection device used to
monitor encrypted traffic had been inoperative for 19 months due to an expired certificate that no one had renewed.

**Phase 4: Data Exfiltration (May - July 29, 2017)**

The attackers exfiltrated data in small batches over 76 days, moving approximately 10,000 records per query to
avoid triggering volume-based alerts. They exfiltrated the data through the same unmonitored encrypted channels,
compressing and encrypting it before sending it to external servers. The total data stolen included:
- 145.5 million Social Security numbers
- 99 million addresses
- 17.6 million driver's license numbers
- 209,000 credit card numbers
- 182,000 dispute documents (containing uploaded personal information)

**Phase 5: Discovery and Response (July 29 - September 7, 2017)**

On July 29, 2017, Equifax's IT team finally renewed the expired SSL certificate on their monitoring device. Within
24 hours, the now-functional monitoring system detected suspicious traffic patterns. Equifax engaged Mandiant for
incident response on August 2. However, they did not disclose the breach to the public until September 7 - 40 days
after discovery and 117 days after the initial compromise. During this period, several Equifax executives sold
stock worth $1.8 million (they were later cleared of insider trading charges).

### Technical Root Cause Analysis

The Equifax breach was a cascade of basic security failures:

1. **Unpatched critical vulnerability**: 67 days to patch a CVSS 10.0 vulnerability with a public exploit. This
   was a failure of patch management process, not technology.

2. **Expired SSL monitoring certificate**: The network monitoring device was blind for 19 months because a
   certificate expired and nobody noticed. No alerting on certificate expiry existed.

3. **Unencrypted credentials**: Database credentials stored in plaintext configuration files enabled rapid lateral
   movement after initial compromise.

4. **Excessive database privileges**: The web application had access to 48 databases when it needed access to far
   fewer. No principle of least privilege was applied.

5. **No network segmentation**: After breaching one web application, attackers could reach databases containing
   the most sensitive data in the company.

### Go Code: Certificate Monitoring and Expiry Alerting

The Equifax breach's most absurd failure was an expired certificate that blinded network monitoring for 19 months.
Here is a production-grade certificate monitoring system in Go:

```go
package certmonitor

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// CertStatus represents the health state of a monitored certificate.
type CertStatus int

const (
	CertStatusValid CertStatus = iota
	CertStatusExpiringSoon
	CertStatusExpired
	CertStatusError
)

// String returns a human-readable label for the certificate status.
func (cs CertStatus) String() string {
	switch cs {
	case CertStatusValid:
		return "VALID"
	case CertStatusExpiringSoon:
		return "EXPIRING_SOON"
	case CertStatusExpired:
		return "EXPIRED"
	case CertStatusError:
		return "ERROR"
	default:
		return "UNKNOWN"
	}
}

// CertCheckResult contains the outcome of a single certificate check.
type CertCheckResult struct {
	Endpoint     string        `json:"endpoint"`
	Subject      string        `json:"subject"`
	Issuer       string        `json:"issuer"`
	NotBefore    time.Time     `json:"notBefore"`
	NotAfter     time.Time     `json:"notAfter"`
	DaysUntilExp int           `json:"daysUntilExpiry"`
	Status       CertStatus    `json:"status"`
	SerialNumber string        `json:"serialNumber"`
	DNSNames     []string      `json:"dnsNames"`
	CheckedAt    time.Time     `json:"checkedAt"`
	Error        string        `json:"error,omitempty"`
}

// AlertFunc is called when a certificate requires attention.
type AlertFunc func(result CertCheckResult)

// MonitorConfig defines the monitoring behavior.
type MonitorConfig struct {
	// Endpoints is the list of host:port addresses to monitor.
	Endpoints []string

	// CheckInterval is how often to check each endpoint.
	CheckInterval time.Duration

	// WarningThreshold triggers EXPIRING_SOON status when a cert has
	// fewer than this many days until expiry.
	WarningThreshold int

	// CriticalThreshold triggers immediate alerts.
	CriticalThreshold int

	// ConnectTimeout is the maximum time to wait for TLS handshake.
	ConnectTimeout time.Duration

	// OnAlert is called whenever a certificate is not in VALID status.
	OnAlert AlertFunc
}

// Monitor continuously checks TLS certificates and alerts on expiry.
type Monitor struct {
	config  MonitorConfig
	results map[string]CertCheckResult
	mu      sync.RWMutex
}

// NewMonitor creates a certificate monitor with the given configuration.
func NewMonitor(config MonitorConfig) *Monitor {
	if config.CheckInterval == 0 {
		config.CheckInterval = 1 * time.Hour
	}
	if config.WarningThreshold == 0 {
		config.WarningThreshold = 30
	}
	if config.CriticalThreshold == 0 {
		config.CriticalThreshold = 7
	}
	if config.ConnectTimeout == 0 {
		config.ConnectTimeout = 10 * time.Second
	}

	return &Monitor{
		config:  config,
		results: make(map[string]CertCheckResult),
	}
}

// CheckEndpoint performs a single certificate check against the given endpoint.
func (m *Monitor) CheckEndpoint(ctx context.Context, endpoint string) CertCheckResult {
	result := CertCheckResult{
		Endpoint:  endpoint,
		CheckedAt: time.Now(),
	}

	dialer := &net.Dialer{Timeout: m.config.ConnectTimeout}
	conn, err := tls.DialWithDialer(dialer, "tcp", endpoint, &tls.Config{
		InsecureSkipVerify: false,
	})
	if err != nil {
		// Try again allowing expired certs so we can report details.
		conn2, err2 := tls.DialWithDialer(dialer, "tcp", endpoint, &tls.Config{
			InsecureSkipVerify: true,
		})
		if err2 != nil {
			result.Status = CertStatusError
			result.Error = fmt.Sprintf("connection failed: %v", err)
			return result
		}
		defer conn2.Close()
		return m.analyzeCert(conn2.ConnectionState().PeerCertificates, endpoint)
	}
	defer conn.Close()

	return m.analyzeCert(conn.ConnectionState().PeerCertificates, endpoint)
}

// analyzeCert examines certificate chain and determines status.
func (m *Monitor) analyzeCert(certs []*x509.Certificate, endpoint string) CertCheckResult {
	result := CertCheckResult{
		Endpoint:  endpoint,
		CheckedAt: time.Now(),
	}

	if len(certs) == 0 {
		result.Status = CertStatusError
		result.Error = "no certificates presented"
		return result
	}

	leaf := certs[0]
	result.Subject = leaf.Subject.CommonName
	result.Issuer = leaf.Issuer.CommonName
	result.NotBefore = leaf.NotBefore
	result.NotAfter = leaf.NotAfter
	result.SerialNumber = leaf.SerialNumber.String()
	result.DNSNames = leaf.DNSNames

	now := time.Now()
	daysUntilExpiry := int(leaf.NotAfter.Sub(now).Hours() / 24)
	result.DaysUntilExp = daysUntilExpiry

	switch {
	case now.After(leaf.NotAfter):
		result.Status = CertStatusExpired
		result.Error = fmt.Sprintf("certificate expired %d days ago", -daysUntilExpiry)
	case daysUntilExpiry <= m.config.CriticalThreshold:
		result.Status = CertStatusExpiringSoon
		result.Error = fmt.Sprintf("CRITICAL: expires in %d days", daysUntilExpiry)
	case daysUntilExpiry <= m.config.WarningThreshold:
		result.Status = CertStatusExpiringSoon
		result.Error = fmt.Sprintf("WARNING: expires in %d days", daysUntilExpiry)
	default:
		result.Status = CertStatusValid
	}

	return result
}

// Run starts the continuous monitoring loop. It blocks until the context
// is canceled.
func (m *Monitor) Run(ctx context.Context) error {
	// Perform an initial check immediately.
	m.checkAll(ctx)

	ticker := time.NewTicker(m.config.CheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			m.checkAll(ctx)
		}
	}
}

// checkAll checks every configured endpoint and fires alerts as needed.
func (m *Monitor) checkAll(ctx context.Context) {
	var wg sync.WaitGroup
	for _, endpoint := range m.config.Endpoints {
		wg.Add(1)
		go func(ep string) {
			defer wg.Done()
			result := m.CheckEndpoint(ctx, ep)

			m.mu.Lock()
			m.results[ep] = result
			m.mu.Unlock()

			if result.Status != CertStatusValid && m.config.OnAlert != nil {
				m.config.OnAlert(result)
			}
		}(endpoint)
	}
	wg.Wait()
}

// GetResults returns the most recent check results for all endpoints.
func (m *Monitor) GetResults() map[string]CertCheckResult {
	m.mu.RLock()
	defer m.mu.RUnlock()

	results := make(map[string]CertCheckResult, len(m.results))
	for k, v := range m.results {
		results[k] = v
	}
	return results
}

// CheckAllOnce performs a single check of all endpoints and returns results.
// Useful for health check endpoints and CI pipeline integration.
func (m *Monitor) CheckAllOnce(ctx context.Context) ([]CertCheckResult, error) {
	m.checkAll(ctx)
	results := m.GetResults()

	var allResults []CertCheckResult
	var errs []error

	for _, r := range results {
		allResults = append(allResults, r)
		if r.Status == CertStatusExpired {
			errs = append(errs, fmt.Errorf("%s: %s", r.Endpoint, r.Error))
		}
	}

	if len(errs) > 0 {
		return allResults, errors.Join(errs...)
	}
	return allResults, nil
}
```

### Engineering Lessons

1. **Patch management is a process problem, not a technology problem.** Equifax had the patch. They had the
   notification. They failed to apply it because there was no tracking, no accountability, and no automated
   verification that critical patches were deployed.

2. **Monitoring infrastructure must monitor itself.** The expired SSL certificate on the monitoring device is a
   meta-failure: the security system failed silently. Certificate monitoring, as shown above, must be automated
   with aggressive alerting thresholds.

3. **Defense in depth would have contained the blast radius.** Network segmentation, encrypted credentials,
   principle of least privilege for database access, and data-at-rest encryption - any one of these would have
   significantly limited the damage.

4. **Credential management is a solved problem.** Storing database credentials in plaintext files in 2017 is
   inexcusable. Use a secrets manager (HashiCorp Vault, AWS Secrets Manager, etc.) and rotate credentials
   automatically.

---

### Junior → FAANG: Patch Management and Certificate Monitoring as Interview Topics

The Equifax breach answers "what is the most common root cause of major data breaches?" The answer is not sophisticated zero-day exploitation: it is an unpatched vulnerability that had a public fix available for two months. For FAANG interviews, the patch management answer has three parts: automated vulnerability scanning in CI (govulncheck for Go dependencies, container image scanning for base images), a patch SLA that defines the maximum time to deploy critical patches (24-48 hours for CVSS 9+), and a patch compliance dashboard that shows which services are out of date. The Equifax monitoring failure (an expired SSL certificate on the inspection device silenced alerts for months) is the answer to "why must security monitoring systems monitor themselves?" The `Monitor` in this section implements certificate monitoring with self-reporting health checks. For FAANG security questions, certificate expiry monitoring is a standard operational requirement that demonstrates operational maturity.

### Senior @ FAANG: Patch Management as a Platform Process and Defense in Depth as an Architectural Standard

At L6, Equifax is a process failure at every layer simultaneously: unpatched vulnerability, expired monitoring certificate, no network segmentation, plaintext credentials, no encryption at rest. Each failed independently. A defense-in-depth architecture would have limited the blast radius even if the Struts vulnerability was exploited: network segmentation would have confined the attacker to the web tier, encrypted database credentials would have prevented lateral movement to the database, and encryption at rest would have made the exfiltrated data unusable. At staff level, you define defense-in-depth requirements as a production readiness standard: every service that handles sensitive data must have at least three independent controls between a perimeter compromise and data exfiltration. Documenting which three controls apply to each service is part of the security section of the production readiness review. The Equifax breach is the argument for why one control (the WAF) is not enough: when the perimeter control fails, there must be controls at the network layer, the credential layer, and the data layer that prevent cascading access.

