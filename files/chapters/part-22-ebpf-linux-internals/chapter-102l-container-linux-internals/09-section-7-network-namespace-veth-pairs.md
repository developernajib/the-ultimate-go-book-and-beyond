## Section 7: Network Namespace + veth Pairs

Container networking is implemented by creating a veth (virtual Ethernet) pair

### Junior → FAANG: Container Networking from First Principles

The veth pair is the physical wire analog for container networking. When you create a veth pair, you get two interfaces (`veth0` and `veth1`) that are electrically connected: any packet sent into one comes out the other. Moving `veth1` into the container's network namespace creates the container's `eth0` interface. Packets from the container go through `veth1` (inside the namespace), emerge from `veth0` (on the host), and reach the host bridge (`docker0`, `cni0`, or `cbr0`). The host bridge connects to the external network via NAT (for Docker) or direct routing (for Kubernetes with CNI plugins like Calico or Cilium).

Diagnosing container networking failures requires working from the inside out. First, from inside the container, verify the interface exists (`ip link show`), has the correct IP (`ip addr show`), has the default route set (`ip route show`), and can reach the gateway (`ping <gateway-ip>`). If the gateway is unreachable, the problem is inside the container namespace. Then, from the host, verify the peer veth (`veth0`) is in the host namespace and up (`ip link show`), the bridge exists and `veth0` is attached to it, and the host can reach the bridge IP. Finally, check iptables rules that might block or misroute the traffic (`iptables-save | grep <container-ip>`).

First-job habit: use `ip netns exec <ns> <command>` to run commands inside a specific network namespace by name. For Kubernetes pods, the namespace is not named but is accessible via `/proc/<container-pid>/ns/net`. Use `nsenter -t <pid> --net <command>` to run network commands in the pod's network namespace from the host. This bypasses the need to exec into the container via kubectl and gives you full host-level tooling (tcpdump, ss, ip) inside the pod's network namespace.

Interview framing: "How does Kubernetes pod-to-pod communication work on the same node?" The answer: the source pod's `eth0` is one end of a veth pair, the other end is in the host namespace and attached to a bridge. The destination pod's `eth0` is similarly connected to the same bridge. The kernel's bridge forwarding logic delivers the packet directly at layer 2, without any routing through the host's IP stack, for pods on the same node.

### Senior @ FAANG: CNI Design Patterns and Network Policy Enforcement

CNI (Container Network Interface) plugins are Go binaries that implement a simple contract: given a network namespace path and a JSON configuration, set up networking for the container and return the assigned IP address. The plugin sequence (ADD, DEL, CHECK) is defined in the CNI spec and is the same regardless of the underlying network implementation. Understanding this contract allows platform teams to evaluate CNI plugins on their implementation merits (performance, feature set, operational complexity) rather than their marketing claims.

Cilium's CNI implementation uses eBPF to replace iptables for kube-proxy's service load balancing and for network policy enforcement. The architectural advantage is that eBPF programs attached to the veth host-side interface can forward packets to the correct pod IP at the earliest possible point in the stack, before the kernel's routing and conntrack subsystems process them. This reduces per-packet latency by 30-50% compared to iptables-based forwarding for services with many backends. The ADR for CNI selection must benchmark this performance difference under the organization's traffic patterns, not just in synthetic benchmarks.

Network policy enforcement is a security-critical function that must be implemented correctly under all failure modes. When a CNI plugin fails to install a network policy rule (due to a race condition during pod startup, an iptables failure, or an eBPF program load error), the pod must start in the correct security posture (default-deny for strict network policies) rather than open-access. Cilium achieves this by applying a "deny-all" policy to new pods until the full policy is installed, then relaxing to the specific policy. Platform teams must verify this behavior in integration tests by simulating CNI plugin failures during pod startup and verifying that the pod cannot make unauthorized connections during the window between startup and policy installation.

The veth pair lifecycle has a leak risk that becomes a production issue at scale. When a pod is deleted, the kubelet deletes the pod's network namespace and calls the CNI plugin's DEL command to clean up the veth and IP allocation. If the kubelet is interrupted between namespace deletion and CNI DEL, the host-side veth (`veth0`) persists as an orphaned interface with no peer. Over weeks on a busy node with frequent pod churn, hundreds of orphaned veth interfaces can accumulate, each consuming kernel routing table entries. Platform teams monitor orphaned veth count with a periodic `ip link show | grep veth | wc -l` check correlated against the expected number of running pods, and run a cleanup job when orphaned veths are detected.

---, two virtual interfaces connected like a pipe, and placing one end inside the container's network namespace while leaving the other end on the host. Traffic entering one interface emerges from the other, enabling the container to communicate with the host bridge and through it with the external network. The code below creates a network namespace, sets up the veth pair, assigns IP addresses, and brings up the interfaces, replicating what CNI plugins like Flannel or Calico do on each pod creation.

```go
package netns

import (
	"fmt"
	"net"
	"os/exec"

	"golang.org/x/sys/unix"
)

// NetworkNamespace manages a container's network namespace
type NetworkNamespace struct {
	name    string
	hostVeth string // veth interface on host side
	contVeth string // veth interface in container
	HostIP  net.IP
	ContIP  net.IP
}

// Setup creates a network namespace with a veth pair
func (n *NetworkNamespace) Setup() error {
	// Create named network namespace
	// In production: use netlink library (vishvananda/netlink)
	// For clarity, showing ip commands equivalent:

	steps := [][]string{
		// Create netns
		{"ip", "netns", "add", n.name},
		// Create veth pair
		{"ip", "link", "add", n.hostVeth, "type", "veth", "peer", "name", n.contVeth},
		// Move container end into namespace
		{"ip", "link", "set", n.contVeth, "netns", n.name},
		// Set up host side
		{"ip", "addr", "add", n.HostIP.String() + "/24", "dev", n.hostVeth},
		{"ip", "link", "set", n.hostVeth, "up"},
		// Set up container side
		{"ip", "netns", "exec", n.name, "ip", "addr", "add",
			n.ContIP.String() + "/24", "dev", n.contVeth},
		{"ip", "netns", "exec", n.name, "ip", "link", "set", n.contVeth, "up"},
		{"ip", "netns", "exec", n.name, "ip", "link", "set", "lo", "up"},
		// Set default route in container
		{"ip", "netns", "exec", n.name, "ip", "route", "add",
			"default", "via", n.HostIP.String()},
	}

	for _, step := range steps {
		cmd := exec.Command(step[0], step[1:]...)
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("step %v: %w (%s)", step, err, out)
		}
	}

	// Enable NAT for outbound traffic
	natRules := [][]string{
		{"iptables", "-t", "nat", "-A", "POSTROUTING",
			"-s", n.ContIP.String() + "/24", "-j", "MASQUERADE"},
		{"iptables", "-A", "FORWARD", "-i", n.hostVeth, "-j", "ACCEPT"},
		{"iptables", "-A", "FORWARD", "-o", n.hostVeth, "-j", "ACCEPT"},
	}

	for _, rule := range natRules {
		exec.Command(rule[0], rule[1:]...).Run()
	}

	return nil
}

// Teardown removes the network namespace
func (n *NetworkNamespace) Teardown() error {
	exec.Command("ip", "netns", "del", n.name).Run()
	exec.Command("ip", "link", "del", n.hostVeth).Run()
	return nil
}

// RunInNetNS runs a function inside the network namespace
func (n *NetworkNamespace) RunInNetNS(fn func() error) error {
	// Save current namespace
	curNS, err := unix.Open("/proc/self/ns/net", unix.O_RDONLY, 0)
	if err != nil {
		return fmt.Errorf("open current netns: %w", err)
	}
	defer unix.Close(curNS)

	// Open target namespace
	targetNS, err := unix.Open(
		fmt.Sprintf("/var/run/netns/%s", n.name), unix.O_RDONLY, 0)
	if err != nil {
		return fmt.Errorf("open target netns: %w", err)
	}
	defer unix.Close(targetNS)

	// Enter target namespace
	if err := unix.Setns(targetNS, unix.CLONE_NEWNET); err != nil {
		return fmt.Errorf("enter netns: %w", err)
	}

	// Run function
	runErr := fn()

	// Restore original namespace
	unix.Setns(curNS, unix.CLONE_NEWNET)

	return runErr
}
```

---
