## 90I.16 WannaCry: The Ransomware That Shut Down Hospitals

### The Attack: May 12, 2017

WannaCry was not a sophisticated piece of malware. It was a relatively crude ransomware payload bolted onto the
most powerful network exploit ever leaked: EternalBlue. The combination of a devastating propagation mechanism
with a simple encryption payload created what became the largest ransomware attack in history.

On May 12, 2017, WannaCry began spreading at approximately 07:44 UTC. Within hours, it had infected over 200,000
computers across 150 countries. The worm spread by scanning for hosts with SMBv1 exposed on port 445, exploiting
EternalBlue to gain code execution, then installing the DoublePulsar backdoor to download and execute the
ransomware payload. Each infected machine immediately began scanning for new targets, creating exponential growth.

### The Kill Chain: EternalBlue + DoublePulsar

The infection process followed a precise sequence:

1. **Scanning** - The worm generated random IP addresses and attempted to connect to TCP port 445
2. **Exploitation** - EternalBlue was used to exploit the SMBv1 buffer overflow
3. **Implant Installation** - DoublePulsar, a kernel-mode backdoor, was installed into the SMB dispatch table
4. **Payload Delivery** - The ransomware binary was injected via DoublePulsar into a user-mode process
5. **Encryption** - Files were encrypted with AES-128-CBC, with the AES key encrypted by RSA-2048
6. **Propagation** - The worm module continued scanning for new targets from the newly infected host
7. **Ransom Demand** - Users saw a demand for $300-600 in Bitcoin, with a 7-day countdown

### NHS Devastation

The UK's National Health Service was the most visible victim. Over 70,000 devices were infected across 80 NHS
organizations, including hospitals, GP surgeries, and trusts. Ambulances were diverted. Surgeries were canceled.
Patient records became inaccessible. Staff reverted to paper and pen. The NHS was particularly vulnerable because
many systems still ran Windows XP (which had reached end-of-life in 2014) and because hospital networks often lacked
proper segmentation.

The attack demonstrated that ransomware is not just a financial crime - when it hits healthcare infrastructure, it
becomes a threat to human life.

### Marcus Hutchins and the Kill Switch

At 22 years old, British security researcher Marcus Hutchins (known online as "MalwareTech") noticed something
unusual in the WannaCry binary. Before encrypting files, the malware attempted to connect to a specific unregistered
domain: `iuqerfsodp9ifjaposdfjhgosurijfaewrwergwea.com`. If the connection succeeded, the malware would exit without
encrypting anything.

Hutchins registered the domain for $10.69. Instantly, every new WannaCry infection that could reach the internet
would check the domain, receive a response, and halt. The kill switch did not decrypt already-infected machines, but
it stopped the exponential growth of new infections.

The kill switch was likely an anti-analysis technique: malware sandboxes often respond to all DNS queries, so
checking an absurd domain was a way to detect if the malware was running in a sandbox. WannaCry's authors made the
critical mistake of hardcoding a single domain rather than using a domain generation algorithm (DGA).

### Attribution: North Korea's Lazarus Group

The US, UK, Canada, New Zealand, Australia, and Japan officially attributed WannaCry to North Korea's Lazarus Group,
the same state-sponsored hacking unit responsible for the 2014 Sony Pictures hack and the 2016 Bangladesh Bank heist
($81 million stolen via SWIFT). The attribution was based on code similarities, shared infrastructure, and signals
intelligence.

WannaCry generated only about $140,000 in Bitcoin ransom payments - trivial compared to its global impact of $4-8
billion in damages. This disproportion suggests the attack may have been intended as a destructive operation that
happened to use ransomware as cover, or simply that the operators were more skilled at exploitation than monetization.

### Go Code: Network Worm Detection System

WannaCry's propagation was detectable from its network behavior alone: a single host connecting to hundreds of random IPs on port 445 within seconds, with the overwhelming majority of attempts failing because most random addresses had no Windows service running. The detector below tracks connection events per source IP within a sliding time window and fires a `critical` alert when a host simultaneously exceeds a unique-target threshold and an 80% failure rate (the signature of automated scanning), while a secondary check catches the exponential rate doubling that characterizes a worm accelerating through newly infected machines.

```go
package wormdetect

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"net"
	"sync"
	"time"
)

// ConnectionEvent represents a single observed network connection attempt.
type ConnectionEvent struct {
	SourceIP    net.IP
	DestIP      net.IP
	DestPort    uint16
	Timestamp   time.Time
	Success     bool
}

// WormIndicator represents a detected indicator of worm-like behavior.
type WormIndicator struct {
	SourceIP         net.IP
	IndicatorType    string
	Severity         string // "low", "medium", "high", "critical"
	Description      string
	ConnectionCount  int
	UniqueTargets    int
	FailureRate      float64
	DetectedAt       time.Time
}

// WormDetector analyzes network connection patterns to identify worm propagation.
type WormDetector struct {
	mu               sync.RWMutex
	logger           *slog.Logger
	connections      map[string][]ConnectionEvent // sourceIP -> events
	alertCallback    func(WormIndicator)
	scanThreshold    int           // connections per window to trigger alert
	failureThreshold float64       // failure rate to flag as scanning
	window           time.Duration // observation window
}

// NewWormDetector creates a detector with configurable thresholds.
func NewWormDetector(logger *slog.Logger, alertFn func(WormIndicator)) *WormDetector {
	return &WormDetector{
		logger:           logger,
		connections:      make(map[string][]ConnectionEvent),
		alertCallback:    alertFn,
		scanThreshold:    50,    // 50 unique targets per window
		failureThreshold: 0.80,  // 80% failure rate indicates scanning
		window:           60 * time.Second,
	}
}

// RecordConnection records a new connection event and checks for worm indicators.
func (d *WormDetector) RecordConnection(event ConnectionEvent) {
	d.mu.Lock()
	key := event.SourceIP.String()
	d.connections[key] = append(d.connections[key], event)
	d.mu.Unlock()

	d.analyze(event.SourceIP)
}

// analyze checks a source IP for worm-like behavior patterns.
func (d *WormDetector) analyze(sourceIP net.IP) {
	d.mu.RLock()
	events := d.connections[sourceIP.String()]
	d.mu.RUnlock()

	now := time.Now()
	cutoff := now.Add(-d.window)

	// Filter to events within the observation window
	var recent []ConnectionEvent
	for _, e := range events {
		if e.Timestamp.After(cutoff) {
			recent = append(recent, e)
		}
	}

	if len(recent) < 5 {
		return // Not enough data
	}

	// Count unique destination IPs and failure rate
	uniqueTargets := make(map[string]bool)
	var failures int
	portCounts := make(map[uint16]int)
	for _, e := range recent {
		uniqueTargets[e.DestIP.String()] = true
		portCounts[e.DestPort]++
		if !e.Success {
			failures++
		}
	}

	failureRate := float64(failures) / float64(len(recent))
	numTargets := len(uniqueTargets)

	// Detection: High connection rate to many unique IPs with high failure rate
	// This is the classic worm scanning pattern
	if numTargets >= d.scanThreshold && failureRate >= d.failureThreshold {
		indicator := WormIndicator{
			SourceIP:        sourceIP,
			IndicatorType:   "network_scan",
			Severity:        "critical",
			Description:     fmt.Sprintf("Host scanning %d unique targets with %.1f%% failure rate - worm propagation suspected", numTargets, failureRate*100),
			ConnectionCount: len(recent),
			UniqueTargets:   numTargets,
			FailureRate:     failureRate,
			DetectedAt:      now,
		}
		d.logger.Error("WORM BEHAVIOR DETECTED",
			"source_ip", sourceIP.String(),
			"unique_targets", numTargets,
			"failure_rate", failureRate,
		)
		if d.alertCallback != nil {
			d.alertCallback(indicator)
		}
	}

	// Detection: Single port focus (worms target specific service ports)
	for port, count := range portCounts {
		portRatio := float64(count) / float64(len(recent))
		if portRatio > 0.90 && numTargets > 20 {
			indicator := WormIndicator{
				SourceIP:        sourceIP,
				IndicatorType:   "single_port_scan",
				Severity:        "high",
				Description:     fmt.Sprintf("Host targeting port %d on %d hosts (%.0f%% of connections) - service-specific worm pattern", port, numTargets, portRatio*100),
				ConnectionCount: count,
				UniqueTargets:   numTargets,
				DetectedAt:      now,
			}
			d.logger.Warn("Single-port scanning detected",
				"source_ip", sourceIP.String(),
				"port", port,
				"targets", numTargets,
			)
			if d.alertCallback != nil {
				d.alertCallback(indicator)
			}
		}
	}

	// Detection: Exponential growth in connection rate (worm acceleration)
	if len(recent) > 10 {
		firstHalf := recent[:len(recent)/2]
		secondHalf := recent[len(recent)/2:]

		if len(firstHalf) > 0 && len(secondHalf) > 0 {
			firstDuration := firstHalf[len(firstHalf)-1].Timestamp.Sub(firstHalf[0].Timestamp)
			secondDuration := secondHalf[len(secondHalf)-1].Timestamp.Sub(secondHalf[0].Timestamp)

			if firstDuration > 0 && secondDuration > 0 {
				firstRate := float64(len(firstHalf)) / firstDuration.Seconds()
				secondRate := float64(len(secondHalf)) / secondDuration.Seconds()

				if secondRate > firstRate*2 && !math.IsInf(secondRate, 0) {
					d.logger.Warn("Exponential connection rate increase detected",
						"source_ip", sourceIP.String(),
						"first_half_rate", firstRate,
						"second_half_rate", secondRate,
					)
				}
			}
		}
	}
}

// Prune removes old connection events to prevent unbounded memory growth.
func (d *WormDetector) Prune(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.mu.Lock()
			cutoff := time.Now().Add(-d.window * 2)
			for key, events := range d.connections {
				var kept []ConnectionEvent
				for _, e := range events {
					if e.Timestamp.After(cutoff) {
						kept = append(kept, e)
					}
				}
				if len(kept) == 0 {
					delete(d.connections, key)
				} else {
					d.connections[key] = kept
				}
			}
			d.mu.Unlock()
		}
	}
}
```

### Lessons for Go Engineers

1. **Kill switches should be part of your incident response toolkit** - WannaCry was stopped by a $10.69 domain
   registration. Design your systems with circuit breakers and emergency shutoffs that can halt propagation.
2. **Network segmentation is non-negotiable** - The NHS's flat network topology allowed WannaCry to spread laterally
   across thousands of devices. Microsegmentation limits blast radius.
3. **Behavioral detection catches what signatures miss** - The worm detector above identifies propagation patterns
   regardless of the specific exploit used. Focus on detecting behaviors, not specific malware signatures.
4. **Legacy systems are attack vectors** - Windows XP machines in NHS hospitals were the primary entry points.
   Maintain an inventory of all systems and their patch status.

---

### Junior → FAANG: Network Segmentation and Kill Switch Design as Interview Topics

WannaCry is the interview answer to "how does network segmentation limit blast radius?" The NHS's flat network topology allowed WannaCry to propagate laterally from a single infected Windows XP machine across thousands of connected devices in minutes. If the network had been segmented (patient monitoring systems isolated from administrative systems, which were isolated from internet-facing services), a single compromised machine could not have infected systems in unrelated network zones. For FAANG interviews, network segmentation is an architectural defense that applies to software-defined networks in the same way it applies to physical networks: each microservice communicates only with its declared dependencies, outbound connections are allowlisted, and lateral movement requires explicit network policy changes that are reviewed and audited. The kill switch story (a $10.69 domain registration stopped the global spread) is the interview answer to "how do you design emergency shutoffs into a system?" Circuit breakers, feature flags, and deployment kill switches are the software equivalents.

### Senior @ FAANG: Behavioral Detection and Ransomware Resilience as Platform Standards

At L6, WannaCry defines two platform security standards. The first is behavioral detection over signature-based detection. The worm detector in this section identifies ransomware propagation patterns (SMB connection attempts to new hosts, rapid file modification rates, file extension changes) regardless of the specific malware variant. Signature-based detection (antivirus matching known bad file hashes) fails against new variants and zero-days. Behavioral detection catches propagation patterns that are consistent across all ransomware, including variants not yet in any signature database. At platform level, this means network behavior analytics that establish baselines and alert on deviations: a host that has never made SMB connections suddenly making SMB connections to 1,000 new hosts is an anomaly that warrants immediate investigation regardless of whether any file on that host matches a known malware signature. The second standard is ransomware-resilient backup architecture: immutable, versioned backups stored in a network location that is not reachable from any production system. The backup system's write access is one-directional: production can push to backup storage, but nothing in the production network can modify or delete backup data.

