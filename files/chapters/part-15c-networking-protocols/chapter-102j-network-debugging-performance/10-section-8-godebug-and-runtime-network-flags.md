## 102J.8 GODEBUG and Runtime Network Flags

### 8.1 Runtime Environment Variables for Network Debugging

Go exposes a collection of `GODEBUG` environment variables that enable verbose logging of internal network subsystem behavior without recompiling the program. Setting `http2debug=2` logs every HTTP/2 frame, `netdns=go+2` logs the pure-Go resolver's DNS decisions, and `netdns=cgo` switches to the system resolver to rule out resolver-specific behavior. The catalog below documents the most useful flags alongside the diagnostic questions each one helps answer.

```go
package netdebug

import (
	"fmt"
)

// GodebugNetworkFlags lists useful GODEBUG settings for network debugging.
var GodebugNetworkFlags = map[string]string{
	"http2debug=1":  "Log HTTP/2 framing in summary form",
	"http2debug=2":  "Log HTTP/2 framing in verbose detail (headers, frame bytes)",
	"http2client=0": "Disable the HTTP/2 client (isolate HTTP/2-specific bugs)",
	"http2server=0": "Disable the HTTP/2 server (force HTTP/1.1 for comparison)",
	"tls10server=1": "Re-enable TLS 1.0 server support (compatibility testing only)",
	"tlsrsakex=1":   "Enable RSA key exchange for TLS 1.2 (insecure, testing only)",
	"netdns=go":     "Force pure-Go DNS resolver",
	"netdns=cgo":    "Force CGo-based system DNS resolver",
	"netdns=go+1":   "Pure-Go DNS resolver + debug logging",
	"netdns=cgo+2":  "CGo DNS resolver + verbose debug logging",
}

// PrintGodebugHelp prints all available network GODEBUG flags.
func PrintGodebugHelp() {
	fmt.Println("Useful GODEBUG flags for network debugging:")
	fmt.Println("Usage: GODEBUG=flag1=val,flag2=val ./binary")
	fmt.Println()
	for flag, desc := range GodebugNetworkFlags {
		fmt.Printf("  %-30s %s\n", flag, desc)
	}
}

// SetHTTP2Debug enables HTTP/2 debug logging at runtime.
// Level 1 = frame summaries, 2 = full frame content.
func SetHTTP2Debug(level int) {
	if level < 1 || level > 2 {
		return
	}
	// This must be set before net/http is used - typically via GODEBUG env.
	// Here we show how to document it - actual effect requires restart.
	fmt.Printf("To enable HTTP/2 debug at level %d, restart with:\n", level)
	fmt.Printf("  GODEBUG=http2debug=%d ./your-binary\n", level)
}

// EnvNetworkTuning prints recommended sysctl settings for high-performance networking.
func EnvNetworkTuning() {
	tunings := []struct {
		Setting string
		Value   string
		Reason  string
	}{
		{"net.ipv4.tcp_tw_reuse", "1", "Allow TIME_WAIT socket reuse for new connections"},
		{"net.ipv4.ip_local_port_range", "10000 65535", "Increase ephemeral port range"},
		{"net.core.somaxconn", "65535", "Increase listen() backlog for burst traffic"},
		{"net.ipv4.tcp_max_syn_backlog", "65535", "Increase SYN backlog for busy servers"},
		{"net.core.rmem_max", "134217728", "Max receive socket buffer (128 MiB)"},
		{"net.core.wmem_max", "134217728", "Max send socket buffer (128 MiB)"},
		{"net.ipv4.tcp_rmem", "4096 87380 67108864", "TCP receive buffer auto-tuning range"},
		{"net.ipv4.tcp_wmem", "4096 65536 67108864", "TCP send buffer auto-tuning range"},
		{"net.ipv4.tcp_fin_timeout", "15", "Reduce FIN_WAIT2 timeout (seconds)"},
		{"net.ipv4.tcp_keepalive_time", "60", "Start keepalive after 60s idle"},
		{"net.ipv4.tcp_keepalive_intvl", "10", "Keepalive probe interval (seconds)"},
		{"net.ipv4.tcp_keepalive_probes", "3", "Number of keepalive probes"},
		{"net.ipv4.tcp_congestion_control", "bbr", "BBR congestion control (Linux 4.9+)"},
	}

	fmt.Println("Recommended sysctl settings for high-performance Go networking:")
	fmt.Println()
	for _, t := range tunings {
		fmt.Printf("sysctl -w %s=%s\n", t.Setting, t.Value)
		fmt.Printf("  # %s\n\n", t.Reason)
	}
}
```

### Junior → FAANG: GODEBUG Flags as Emergency Diagnostic Tools

`GODEBUG` environment variables are the emergency tools for when standard metrics do not provide enough information. `http2debug=2` emits every HTTP/2 frame to stderr, revealing stream multiplexing behavior, flow control window updates, and protocol-level errors that are invisible to application-level logging. `netdns=go+1` shows Go's DNS resolution decisions, helping diagnose whether the pure Go resolver or the system cgo resolver is being used.

The critical constraint: these flags produce high-volume output and should never be enabled in production indefinitely. They are for short-duration diagnostic sessions: enable the flag, capture 30-60 seconds of output during the problematic behavior, disable the flag, analyze the captured output. Leaving `http2debug=2` enabled in production will fill disk and potentially impact performance.

For interviews: knowing that `GODEBUG` flags exist and can provide frame-level visibility into HTTP/2 behavior shows debugging depth that most candidates do not have. Mentioning it in a "how would you debug an HTTP/2 issue" question is a strong signal of practical experience.

### Senior @ FAANG: Runtime Flags and the Debugging Permission Model

At FAANG, enabling diagnostic flags in production requires a change control process. `GODEBUG=http2debug=2` may produce output containing request paths, headers, or timing data that is subject to data privacy regulations. Setting it on a service that processes user data requires confirming that the output is not logged to a storage system that violates data retention policies.

The platform approach: maintain a set of pre-approved `GODEBUG` configurations for common debugging scenarios, with documented output characteristics (what data is emitted, whether it contains PII), approved usage duration limits, and an automated rollback mechanism that removes the flag after the approved duration expires. Engineers requesting a diagnostic flag go through a lightweight approval workflow that confirms they understand the data privacy implications.

This permission model is not bureaucracy for its own sake. It is the difference between a debugging capability that can be used freely in production and one that causes a compliance incident the first time it is used without thinking.

---
