## 102J.6 Production Network Diagnostics CLI

### 6.1 Integrated Diagnostic Tool

An integrated CLI tool that combines DNS probing, TCP connection testing, TLS verification, and HTTP timing waterfall into a single command dramatically reduces mean time to diagnosis in production incidents. The tool below accepts a target URL as input, runs each diagnostic phase in sequence, and emits a structured `DiagnosticResult` that can be printed for human consumption or serialized as JSON for automated alerting pipelines.

```go
package netdebug

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"
)

// DiagnosticResult is the output of a full network diagnostic run.
type DiagnosticResult struct {
	Timestamp  time.Time
	Target     string
	DNS        *DNSResult
	Timings    *RequestTimings
	TCPStats   *TCPStatSummary
	FDCount    int
	Warnings   []string
	Errors     []string
}

// RunDiagnostics performs a comprehensive network check.
func RunDiagnostics(ctx context.Context, target string) (*DiagnosticResult, error) {
	result := &DiagnosticResult{
		Timestamp: time.Now(),
		Target:    target,
	}

	// DNS probe
	probe := NewDNSProbe(5 * time.Second)
	dnsResult := probe.LookupHost(ctx, extractHost(target))
	result.DNS = &dnsResult

	if dnsResult.Error != nil {
		result.Errors = append(result.Errors, fmt.Sprintf("DNS: %v", dnsResult.Error))
	} else if dnsResult.Latency > 100*time.Millisecond {
		result.Warnings = append(result.Warnings,
			fmt.Sprintf("High DNS latency: %v", dnsResult.Latency))
	}

	// HTTP request tracing
	client := ConfigureHTTPClient(UserFacingTimeouts)
	timings, err := TraceRequest(ctx, client, "GET", target)
	result.Timings = timings
	if err != nil {
		result.Errors = append(result.Errors, fmt.Sprintf("HTTP: %v", err))
	} else {
		// Analyze timings
		if timings.TLSHandshake > 500*time.Millisecond {
			result.Warnings = append(result.Warnings,
				fmt.Sprintf("High TLS latency: %v - check cert chain length, OCSP stapling", timings.TLSHandshake))
		}
		if timings.ServerProcess > time.Second {
			result.Warnings = append(result.Warnings,
				fmt.Sprintf("Slow server response: %v - check server load or query optimization", timings.ServerProcess))
		}
	}

	// TCP connection table (Linux only)
	if entries, err := ParseProcNetTCP(); err == nil {
		summary := SummarizeTCP(entries)
		result.TCPStats = &summary
		result.Warnings = append(result.Warnings, DiagnoseConnectionTable(summary)...)
	}

	// File descriptor count
	result.FDCount = FDCount()
	if result.FDCount > 5000 {
		result.Warnings = append(result.Warnings,
			fmt.Sprintf("High FD count: %d - potential leak", result.FDCount))
	}

	// Timeout audit
	issues := AuditHTTPClientTimeouts(client, UserFacingTimeouts)
	for _, issue := range issues {
		if issue.Severity == "CRITICAL" || issue.Severity == "HIGH" {
			result.Warnings = append(result.Warnings,
				fmt.Sprintf("Timeout [%s]: %s", issue.Severity, issue.Reason))
		}
	}

	return result, nil
}

func (r *DiagnosticResult) Report() string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "=== Network Diagnostic Report ===\n")
	fmt.Fprintf(&sb, "Target:    %s\n", r.Target)
	fmt.Fprintf(&sb, "Timestamp: %s\n\n", r.Timestamp.Format(time.RFC3339))

	if r.DNS != nil {
		status := "✓"
		if r.DNS.Error != nil {
			status = "✗"
		}
		fmt.Fprintf(&sb, "DNS %s: %v (%v)\n", status, strings.Join(r.DNS.Addrs, ", "), r.DNS.Latency)
	}

	if r.Timings != nil {
		fmt.Fprintln(&sb)
		fmt.Fprint(&sb, r.Timings.Waterfall())
	}

	if r.TCPStats != nil {
		fmt.Fprintf(&sb, "\nTCP Connections:\n")
		for state, count := range r.TCPStats.ByState {
			fmt.Fprintf(&sb, "  %-20s: %d\n", state, count)
		}
	}

	if r.FDCount > 0 {
		fmt.Fprintf(&sb, "\nOpen FDs: %d\n", r.FDCount)
	}

	if len(r.Warnings) > 0 {
		fmt.Fprintf(&sb, "\nWarnings:\n")
		for _, w := range r.Warnings {
			fmt.Fprintf(&sb, "  ⚠  %s\n", w)
		}
	}

	if len(r.Errors) > 0 {
		fmt.Fprintf(&sb, "\nErrors:\n")
		for _, e := range r.Errors {
			fmt.Fprintf(&sb, "  ✗  %s\n", e)
		}
	}

	if len(r.Warnings) == 0 && len(r.Errors) == 0 {
		fmt.Fprintf(&sb, "\n✓ No issues detected\n")
	}

	return sb.String()
}

func extractHost(rawURL string) string {
	// Simple extraction: strip scheme and path
	u := rawURL
	if idx := strings.Index(u, "://"); idx >= 0 {
		u = u[idx+3:]
	}
	if idx := strings.IndexByte(u, '/'); idx >= 0 {
		u = u[:idx]
	}
	if idx := strings.IndexByte(u, ':'); idx >= 0 {
		u = u[:idx]
	}
	return u
}

func main() {
	target := flag.String("target", "https://example.com", "URL to diagnose")
	timeout := flag.Duration("timeout", 30*time.Second, "Overall timeout")
	flag.Parse()

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	result, err := RunDiagnostics(ctx, *target)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Diagnostic error: %v\n", err)
	}

	fmt.Print(result.Report())

	if len(result.Errors) > 0 {
		os.Exit(1)
	}
}
```

### Junior → FAANG: Building Tools That Your Team Will Actually Use

A diagnostic CLI is most valuable when it is usable by anyone on the team, not just the engineer who built it. The design principles: output structured data (JSON or a well-formatted table) that can be parsed by other tools, include a `--help` flag with examples, provide sensible defaults so a novice can run it without reading documentation, and make the most common diagnostic path the zero-argument default.

The habit of building tools with usability in mind distinguishes engineers who multiply team effectiveness from those who only solve their own problems. A diagnostic CLI that only you know how to use is a personal productivity tool. One that the entire team uses during incidents is a reliability investment.

Before submitting a diagnostic tool for code review, test it with a teammate who was not involved in building it. If they can figure out how to use it without asking you, it is ready.

### Senior @ FAANG: Diagnostic Tooling as Platform Infrastructure

At FAANG, production diagnostic tooling is platform infrastructure with the same requirements as any internal service: documentation, versioning, release process, and on-call support. A diagnostic CLI that has been distributed to 200 engineers must have a migration path when its output format changes, a deprecation notice before flags are removed, and a support channel for when it does not work in a specific environment (particular OS version, container runtime, network configuration).

The governance model for diagnostic tooling: the platform team owns the canonical diagnostic tool. Service teams can contribute commands and diagnostic modules through a PR process with defined acceptance criteria. The platform team reviews for correctness, security (does the tool request permissions it does not need? does it log sensitive connection data?), and cross-environment compatibility (works in containers, works on bare metal, works in CI).

The L7 signal in platform interviews: candidates who describe diagnostic tooling as a product with a lifecycle, not just a script that one engineer wrote, are demonstrating staff-level platform thinking.

---
