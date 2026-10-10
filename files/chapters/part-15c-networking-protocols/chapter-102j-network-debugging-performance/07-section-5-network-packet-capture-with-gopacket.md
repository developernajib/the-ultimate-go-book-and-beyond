## 102J.5 Network Packet Capture with gopacket

### 5.1 Passive Traffic Analysis

Passive packet capture lets you inspect raw network traffic from a Go process without modifying the application under observation, making it invaluable for diagnosing protocol-level issues that do not appear in application logs. The `gopacket` library wraps libpcap to decode Ethernet, IP, TCP, and UDP layers into typed structs, enabling analysis of packet sequences, retransmissions, and TCP state machine transitions directly in Go code.

```go
package netcapture

// NOTE: requires libpcap-dev on Linux, WinPcap/Npcap on Windows.
// go get github.com/google/gopacket
// go get github.com/google/gopacket/pcap
// go get github.com/google/gopacket/layers

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
	"github.com/google/gopacket/pcap"
)

// PacketSummary holds per-packet statistics.
type PacketSummary struct {
	Timestamp  time.Time
	SrcIP      string
	DstIP      string
	SrcPort    uint16
	DstPort    uint16
	Protocol   string
	Length     int
	TCPFlags   string
	Payload    int
}

// CaptureConfig controls packet capture behavior.
type CaptureConfig struct {
	Interface   string
	BPFFilter   string // e.g., "tcp port 8080"
	SnapLen     int32
	Promiscuous bool
	Timeout     time.Duration
	MaxPackets  int
}

// DefaultCaptureConfig captures all traffic on loopback.
func DefaultCaptureConfig(iface string) CaptureConfig {
	return CaptureConfig{
		Interface:   iface,
		BPFFilter:   "tcp",
		SnapLen:     65535,
		Promiscuous: false,
		Timeout:     pcap.BlockForever,
		MaxPackets:  1000,
	}
}

// CapturePackets captures packets and sends summaries to the channel.
func CapturePackets(cfg CaptureConfig, out chan<- PacketSummary) error {
	handle, err := pcap.OpenLive(cfg.Interface, cfg.SnapLen, cfg.Promiscuous, cfg.Timeout)
	if err != nil {
		return fmt.Errorf("open live capture on %s: %w", cfg.Interface, err)
	}
	defer handle.Close()

	if cfg.BPFFilter != "" {
		if err := handle.SetBPFFilter(cfg.BPFFilter); err != nil {
			return fmt.Errorf("set BPF filter %q: %w", cfg.BPFFilter, err)
		}
	}

	var (
		eth  layers.Ethernet
		ip4  layers.IPv4
		ip6  layers.IPv6
		tcp  layers.TCP
		udp  layers.UDP
	)

	parser := gopacket.NewDecodingLayerParser(
		layers.LayerTypeEthernet,
		&eth, &ip4, &ip6, &tcp, &udp,
	)

	decoded := make([]gopacket.LayerType, 0, 8)
	packetSource := gopacket.NewPacketSource(handle, handle.LinkType())

	count := 0
	for packet := range packetSource.Packets() {
		if cfg.MaxPackets > 0 && count >= cfg.MaxPackets {
			break
		}

		if err := parser.DecodeLayers(packet.Data(), &decoded); err != nil {
			continue
		}

		summary := PacketSummary{
			Timestamp: packet.Metadata().Timestamp,
			Length:    packet.Metadata().Length,
		}

		for _, layerType := range decoded {
			switch layerType {
			case layers.LayerTypeIPv4:
				summary.SrcIP = ip4.SrcIP.String()
				summary.DstIP = ip4.DstIP.String()
				summary.Protocol = ip4.Protocol.String()
			case layers.LayerTypeIPv6:
				summary.SrcIP = ip6.SrcIP.String()
				summary.DstIP = ip6.DstIP.String()
			case layers.LayerTypeTCP:
				summary.SrcPort = uint16(tcp.SrcPort)
				summary.DstPort = uint16(tcp.DstPort)
				summary.Payload = len(tcp.Payload)
				summary.TCPFlags = tcpFlags(tcp)
			case layers.LayerTypeUDP:
				summary.SrcPort = uint16(udp.SrcPort)
				summary.DstPort = uint16(udp.DstPort)
				summary.Payload = len(udp.Payload)
			}
		}

		out <- summary
		count++
	}

	close(out)
	return nil
}

func tcpFlags(tcp layers.TCP) string {
	flags := ""
	if tcp.SYN {
		flags += "S"
	}
	if tcp.ACK {
		flags += "A"
	}
	if tcp.FIN {
		flags += "F"
	}
	if tcp.RST {
		flags += "R"
	}
	if tcp.PSH {
		flags += "P"
	}
	if tcp.URG {
		flags += "U"
	}
	return flags
}

// FlowAggregator groups packets into flows (5-tuple).
type FlowAggregator struct {
	flows map[string]*FlowStats
	mu    sync.Mutex
}

// FlowStats tracks per-flow metrics.
type FlowStats struct {
	SrcIP     string
	DstIP     string
	SrcPort   uint16
	DstPort   uint16
	Protocol  string
	Packets   int64
	Bytes     int64
	FirstSeen time.Time
	LastSeen  time.Time
	SYNs      int
	RSTs      int
}

// FlowKey generates a canonical 5-tuple key.
func FlowKey(s PacketSummary) string {
	// Normalize direction: sort src/dst to make bidirectional flows same key
	if s.SrcIP > s.DstIP || (s.SrcIP == s.DstIP && s.SrcPort > s.DstPort) {
		return fmt.Sprintf("%s:%d↔%s:%d/%s", s.DstIP, s.DstPort, s.SrcIP, s.SrcPort, s.Protocol)
	}
	return fmt.Sprintf("%s:%d↔%s:%d/%s", s.SrcIP, s.SrcPort, s.DstIP, s.DstPort, s.Protocol)
}

func NewFlowAggregator() *FlowAggregator {
	return &FlowAggregator{flows: make(map[string]*FlowStats)}
}

// Add updates flow stats for a packet.
func (a *FlowAggregator) Add(pkt PacketSummary) {
	key := FlowKey(pkt)
	a.mu.Lock()
	defer a.mu.Unlock()

	flow, ok := a.flows[key]
	if !ok {
		flow = &FlowStats{
			SrcIP: pkt.SrcIP, DstIP: pkt.DstIP,
			SrcPort: pkt.SrcPort, DstPort: pkt.DstPort,
			Protocol:  pkt.Protocol,
			FirstSeen: pkt.Timestamp,
		}
		a.flows[key] = flow
	}

	flow.Packets++
	flow.Bytes += int64(pkt.Length)
	flow.LastSeen = pkt.Timestamp

	if strings.Contains(pkt.TCPFlags, "S") && !strings.Contains(pkt.TCPFlags, "A") {
		flow.SYNs++
	}
	if strings.Contains(pkt.TCPFlags, "R") {
		flow.RSTs++
	}
}

// TopFlows returns the N flows with highest byte count.
func (a *FlowAggregator) TopFlows(n int) []FlowStats {
	a.mu.Lock()
	defer a.mu.Unlock()

	flows := make([]FlowStats, 0, len(a.flows))
	for _, f := range a.flows {
		flows = append(flows, *f)
	}

	// Simple selection sort for top N
	for i := 0; i < n && i < len(flows); i++ {
		maxIdx := i
		for j := i + 1; j < len(flows); j++ {
			if flows[j].Bytes > flows[maxIdx].Bytes {
				maxIdx = j
			}
		}
		flows[i], flows[maxIdx] = flows[maxIdx], flows[i]
	}

	if n < len(flows) {
		return flows[:n]
	}
	return flows
}
```

### Junior → FAANG: When to Reach for Packet Capture

Packet capture is the escalation tool when application-level metrics and OS socket statistics are not sufficient to explain observed behavior. Reach for `tcpdump` or `gopacket` when: you need to confirm whether a timeout is a Go-level construct or a genuine network-level event, when TLS handshake timing does not match what `httptrace` reports, or when you suspect packet loss on a network path.

The two most common reasons to use packet capture in production debugging: confirming whether a client is receiving RST packets from the server (indicating the server forcibly closed the connection), and measuring TCP retransmission counts on a specific flow (indicating packet loss on the network path). Both are invisible to application-level logging.

Note: packet capture requires elevated permissions. In production environments, this often means running `tcpdump` on the node (not inside the container) or using a network-level monitoring tool that has pre-approved access. Know the process for requesting packet capture access in your production environment before you need it during an incident.

### Senior @ FAANG: Automated Packet Analysis for Production Monitoring

At FAANG scale, manual packet capture during incidents is too slow. The right approach is automated packet analysis that runs continuously and surfaces anomalies proactively. eBPF-based tools (BPF Compiler Collection, Cilium's Hubble, Pixie) provide per-connection packet-level metrics without the overhead of full packet capture: TCP retransmission rate, RTT per connection, bytes sent/received per pod, and connection establishment latency. These metrics surface the network-level information that `tcpdump` would show, but at scale and without capturing actual packet payloads.

The security constraint that makes `gopacket`-based raw packet capture complex in production: capturing packet payloads in a TLS-encrypted environment reveals little useful information (the payload is encrypted). For encrypted traffic, the useful signals are at the TCP level (SYN/SYN-ACK/FIN/RST timing, window sizes, retransmissions) rather than the application level. eBPF hooks at the TLS layer (after decryption, in the application's memory) can provide payload-level visibility for debugging, but require careful security review because they can capture sensitive data. FAANG security teams have strict policies about when TLS-decrypting debug tools can be used in production.

---
