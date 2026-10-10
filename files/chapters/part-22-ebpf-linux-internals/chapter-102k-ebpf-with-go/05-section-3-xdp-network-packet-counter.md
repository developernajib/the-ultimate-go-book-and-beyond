## Section 3: XDP Network Packet Counter

XDP (eXpress Data Path) programs run at the earliest point in the Linux network stack, inside the NIC driver, before any kernel networking layers allocate memory for a socket buffer. This makes XDP the most efficient location for packet counting, traffic shaping, and DDoS mitigation because rejected packets never reach the more expensive protocol stack. The program below counts packets per IP protocol, tracks per-port statistics, and implements an IP blocklist that drops matching packets in a single hash table lookup.

```c
// bpf/xdp_counter.c - Count packets by protocol using XDP
//go:build ignore

#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// Packet counters by protocol
struct {
    __uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
    __uint(max_entries, 256); // One entry per IP protocol
    __type(key, __u32);
    __type(value, __u64);
} proto_count SEC(".maps");

// Dropped source IPs (blocklist)
struct {
    __uint(type, BPF_MAP_TYPE_LRU_HASH);
    __uint(max_entries, 10000);
    __type(key, __u32);    // source IP
    __type(value, __u8);   // 1 = blocked
} blocklist SEC(".maps");

// Port stats: dst_port -> packet count
struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 65536);
    __type(key, __u16);
    __type(value, __u64);
} port_count SEC(".maps");

SEC("xdp")
int xdp_count_packets(struct xdp_md *ctx)
{
    void *data     = (void *)(long)ctx->data;
    void *data_end = (void *)(long)ctx->data_end;

    // Parse Ethernet header
    struct ethhdr *eth = data;
    if ((void *)(eth + 1) > data_end)
        return XDP_PASS;

    if (bpf_ntohs(eth->h_proto) != ETH_P_IP)
        return XDP_PASS;

    // Parse IP header
    struct iphdr *ip = (void *)(eth + 1);
    if ((void *)(ip + 1) > data_end)
        return XDP_PASS;

    // Check blocklist
    __u32 src_ip = ip->saddr;
    __u8 *blocked = bpf_map_lookup_elem(&blocklist, &src_ip);
    if (blocked && *blocked)
        return XDP_DROP;  // Drop blocked IPs

    // Count by protocol
    __u32 proto = ip->protocol;
    __u64 *count = bpf_map_lookup_elem(&proto_count, &proto);
    if (count)
        (*count)++;

    // Count TCP/UDP by destination port
    if (ip->protocol == IPPROTO_TCP) {
        struct tcphdr *tcp = (void *)(ip + 1);
        if ((void *)(tcp + 1) > data_end)
            return XDP_PASS;
        __u16 dst_port = bpf_ntohs(tcp->dest);
        __u64 *port_cnt = bpf_map_lookup_elem(&port_count, &dst_port);
        if (port_cnt) {
            (*port_cnt)++;
        } else {
            __u64 initial = 1;
            bpf_map_update_elem(&port_count, &dst_port, &initial, BPF_NOEXIST);
        }
    }

    return XDP_PASS;
}

char LICENSE[] SEC("license") = "GPL";
```

```go
package xdpcounter

import (
	"cmp"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/rlimit"
)

// XDPCounter attaches to a network interface and counts packets
type XDPCounter struct {
	objs  *XdpCounterObjects
	xdp   link.Link
	iface *net.Interface
}

func NewXDPCounter(ifaceName string) (*XDPCounter, error) {
	if err := rlimit.RemoveMemlock(); err != nil {
		return nil, err
	}

	iface, err := net.InterfaceByName(ifaceName)
	if err != nil {
		return nil, fmt.Errorf("interface %s: %w", ifaceName, err)
	}

	objs := &XdpCounterObjects{}
	if err := LoadXdpCounterObjects(objs, nil); err != nil {
		return nil, fmt.Errorf("load objects: %w", err)
	}

	// Attach XDP program to interface (native driver mode for best performance)
	xdpLink, err := link.AttachXDP(link.XDPOptions{
		Program:   objs.XdpCountPackets,
		Interface: iface.Index,
	})
	if err != nil {
		objs.Close()
		return nil, fmt.Errorf("attach XDP: %w", err)
	}

	return &XDPCounter{
		objs:  objs,
		xdp:   xdpLink,
		iface: iface,
	}, nil
}

// BlockIP adds an IP to the blocklist
func (c *XDPCounter) BlockIP(ip netip.Addr) error {
	key := ip.As4()
	var keyU32 uint32
	keyU32 = uint32(key[0])<<24 | uint32(key[1])<<16 | uint32(key[2])<<8 | uint32(key[3])
	value := uint8(1)
	return c.objs.Blocklist.Put(&keyU32, &value)
}

// UnblockIP removes an IP from the blocklist
func (c *XDPCounter) UnblockIP(ip netip.Addr) error {
	key := ip.As4()
	var keyU32 uint32
	keyU32 = uint32(key[0])<<24 | uint32(key[1])<<16 | uint32(key[2])<<8 | uint32(key[3])
	return c.objs.Blocklist.Delete(&keyU32)
}

// ProtoStats returns packet counts per IP protocol
func (c *XDPCounter) ProtoStats() map[string]uint64 {
	protoNames := map[uint32]string{
		1:  "ICMP",
		6:  "TCP",
		17: "UDP",
		58: "ICMPv6",
	}

	result := make(map[string]uint64)
	var key, value uint32
	var perCPUValues []uint64

	iter := c.objs.ProtoCount.Iterate()
	for iter.Next(&key, &perCPUValues) {
		var total uint64
		for _, v := range perCPUValues {
			total += v
		}
		name, ok := protoNames[key]
		if !ok {
			name = fmt.Sprintf("proto_%d", key)
		}
		if total > 0 {
			result[name] = total
		}
	}
	return result
}

// TopPorts returns the top N destination ports by packet count
func (c *XDPCounter) TopPorts(n int) []PortStat {
	type entry struct {
		port  uint16
		count uint64
	}

	var entries []entry
	var key uint16
	var value uint64

	iter := c.objs.PortCount.Iterate()
	for iter.Next(&key, &value) {
		entries = append(entries, entry{key, value})
	}

	slices.SortFunc(entries, func(a, b entry) int {
		return cmp.Compare(b.count, a.count)
	})

	if n > len(entries) {
		n = len(entries)
	}

	result := make([]PortStat, n)
	for i := range n {
		result[i] = PortStat{Port: entries[i].port, Packets: entries[i].count}
	}
	return result
}

type PortStat struct {
	Port    uint16
	Packets uint64
}

func (c *XDPCounter) Close() {
	c.xdp.Close()
	c.objs.Close()
}

// Print displays current statistics
func (c *XDPCounter) Print() {
	fmt.Printf("\n=== XDP Stats: %s ===\n", c.iface.Name)
	fmt.Println("Protocol Counts:")
	for proto, count := range c.ProtoStats() {
		fmt.Printf("  %-8s: %d\n", proto, count)
	}

	fmt.Println("\nTop 10 Destination Ports:")
	for _, ps := range c.TopPorts(10) {
		fmt.Printf("  Port %-6d: %d packets\n", ps.Port, ps.Packets)
	}
}
```

### Junior → FAANG: XDP Fundamentals and First-Job Packet Processing

XDP is the entry point to kernel-bypass networking without leaving the kernel. The critical concept to internalize before writing XDP programs is the `xdp_md` context struct: it provides `data` and `data_end` pointers that bound the packet buffer in memory. Every memory access in an XDP program must be bounds-checked against `data_end`, or the verifier rejects it. This is not optional boilerplate: it is the safety mechanism that prevents XDP programs from reading beyond the packet buffer into arbitrary kernel memory.

The return code semantics are the most important thing to memorize for both correctness and interviews. `XDP_DROP` discards the packet before any allocation, which is the basis for DDoS mitigation. `XDP_PASS` hands the packet to the normal kernel network stack, which is the safe default. `XDP_TX` retransmits the packet out the same interface, useful for reflection attacks or hairpin routing. `XDP_REDIRECT` sends the packet to another interface or CPU, which is the basis for high-performance load balancers. Getting these wrong in production causes silent packet loss or routing loops.

A first-job habit: always test XDP programs in `XDP_FLAGS_SKB_MODE` (generic XDP) first, which runs the program after the driver has already allocated the `sk_buff`. Generic mode is slower but works on any interface type, including virtual interfaces and loopback. Once the logic is correct, switch to native XDP mode (`XDP_FLAGS_DRV_MODE`) for production performance. Testing only in native mode on a real NIC makes local development impossible for most developers.

Interview framing: "How would you implement a 10 Gbps IP blocklist that doesn't add latency to legitimate traffic?" Describe an XDP program with a `BPF_MAP_TYPE_LPM_TRIE` for CIDR matching of blocked prefixes, returning `XDP_DROP` for matches and `XDP_PASS` otherwise. Note that the LPM trie lookup is O(prefix length), typically 32 iterations for IPv4, and fits comfortably within the XDP processing budget.

### Senior @ FAANG: XDP at Scale: DDoS Mitigation, Load Balancing, and Platform Design

XDP-based DDoS mitigation at FAANG scale requires a control plane that updates the blocklist map in real time as threat intelligence feeds publish new malicious prefixes. The architecture is: a Go daemon subscribes to a threat intelligence Pub/Sub topic, parses new CIDR blocks, and updates the `BPF_MAP_TYPE_LPM_TRIE` via the `cilium/ebpf` map API. The key design decision is atomic update granularity: individual map updates are atomic but not transactional, so a burst of 1000 new prefixes is applied one at a time, not as a batch. For this reason, production blocklist systems maintain two maps and use a control map to signal which is "live," implementing a double-buffer swap.

Load balancing with XDP and `XDP_REDIRECT` requires understanding `bpf_redirect_map` and `BPF_MAP_TYPE_DEVMAP` or `BPF_MAP_TYPE_CPUMAP`. Redirecting to a `DEVMAP` sends the packet directly to another NIC's transmit queue, bypassing the kernel network stack entirely. This is the basis for Meta's Katran load balancer, which handles hundreds of Gbps of traffic on commodity hardware using XDP. The ADR for deploying XDP-based load balancing must address how the backend server list is maintained in the `DEVMAP` during rolling updates, because removing a backend from the map while connections are in flight causes those connections to be dropped.

XDP and the kernel's existing iptables/nftables rules coexist but interact in ways that require careful documentation. An XDP program running in native mode runs before conntrack, iptables, and routing. Packets dropped in XDP are invisible to `iptables -L -v -n` counters, which confuses operators who are used to iptables as the source of truth for packet counts. Platform teams must provide alternative observability: per-XDP-program packet counters in a `BPF_MAP_TYPE_PERCPU_ARRAY`, aggregated by the Go daemon and published to the same metrics system as iptables counters, with clear documentation of the precedence ordering.

Performance profiling of XDP programs with `bpftool prog profile` reveals the cycle cost of each operation: a hash map lookup costs roughly 50-100 cycles, an LPM trie lookup costs 100-200 cycles, and a packet header parse costs 20-50 cycles. At 10 Gbps with 64-byte packets, you have approximately 600 cycles per packet budget before you saturate the CPU. Staff engineers design XDP programs to stay within this budget by minimizing map lookups, using per-CPU arrays for hot counters (eliminating atomic operations), and using early-exit logic to skip complex processing for non-matching traffic.

The testing strategy for XDP programs must include traffic generators that can produce packets at line rate. `pktgen` in the kernel or `TRex` in user space are the standard tools for this. Unit testing XDP programs is possible with the `BPF_PROG_TEST_RUN` syscall, which allows passing synthetic packets to an XDP program and checking the return code and modified packet contents without a real network interface. Platform teams integrate `BPF_PROG_TEST_RUN` into their Go test suites using `cilium/ebpf`'s `prog.Test()` method, enabling CI-level testing of XDP logic without requiring a NIC.

---
