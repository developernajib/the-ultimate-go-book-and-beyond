## Section 4: Linux Capabilities

Linux capabilities divide the traditional all-or-nothing root privilege into fine-grained permissions

### Junior → FAANG: Capabilities as the Permission System for Container Processes

The capability model's core concept is that "root" inside a container is not the same as "root" on the host when capabilities are dropped. A process running as UID 0 inside a container without `CAP_SYS_ADMIN` cannot call `mount()`, cannot modify network interfaces, and cannot load kernel modules. This is the mechanism that makes "run as root inside the container but drop dangerous capabilities" a reasonable security posture for workloads that require UID 0 for legacy reasons.

The four capability sets (permitted, effective, inheritable, and ambient) confuse most juniors at first. The practical model: the effective set is what the process can actually do right now. The permitted set is the ceiling of what can be in the effective set. The inheritable set is what survives across `execve`. The ambient set (Linux 4.3+) is automatically added to permitted and effective across `execve` for non-suid binaries. For container runtimes, the relevant operation is: compute the minimum required effective set for the container's init process, set the permitted set to exactly that, and set inheritable and ambient to empty unless the container's process tree specifically needs capability inheritance.

First-job habit: use `capsh --print` inside a running container to inspect the capability sets. Use `capsh --decode=<hex>` to decode the bitmask printed by `grep Cap /proc/<pid>/status`. When a container fails because of "Operation not permitted" on an operation that seems like it should work for root, check the capability sets first. `strace -e trace=capget,capset` on the failing process shows which capability check is failing.

Interview framing: "What is the difference between `CAP_NET_ADMIN` and `CAP_NET_RAW`?" The answer: `CAP_NET_RAW` allows opening raw sockets (for `ping`, packet capture, and crafting arbitrary packets) but not network interface configuration. `CAP_NET_ADMIN` allows interface configuration, routing table modification, and iptables management. `CAP_NET_ADMIN` is significantly more dangerous and is required for container network plugins but should never be granted to application containers.

### Senior @ FAANG: Capability Governance and the Principle of Least Privilege at Fleet Scale

The principle of least privilege for capabilities at FAANG means: no production container has any capability it does not need, and adding a capability to a workload requires a security review and documentation of the justification. This principle is enforced via admission controllers (OPA Gatekeeper or Kyverno policies that reject pods with capabilities not in the organization's approved list) and audited quarterly by the security team.

The most dangerous capabilities from a container escape perspective are `CAP_SYS_ADMIN` (the "super capability" that grants nearly all kernel operations), `CAP_NET_ADMIN` (allows iptables and routing manipulation that can intercept pod-to-pod traffic), `CAP_SYS_PTRACE` (allows process memory reading across namespaces), and `CAP_DAC_OVERRIDE` (bypasses file permission checks). The ADR for the organization's capability policy must specify which workloads may hold each of these capabilities, require a security architecture review for any new request, and mandate quarterly revalidation to ensure the capability is still needed.

Capability inheritance across the container's process tree is a frequently overlooked attack vector. When a container runs a shell script that forks child processes, those child processes inherit the parent's capabilities (if they are in the inheritable or ambient set). A container that needs `CAP_NET_BIND_SERVICE` for its init process to bind port 443 but then drops all capabilities before execing the application is more secure than one that leaves the capability in the ambient set, because a subprocess spawned by the application (e.g., from a shell injection vulnerability) will not inherit the binding capability.

The interaction between capabilities and the user namespace is a kernel security research topic. In a user namespace, the process has all capabilities within the namespace's scope, but those capabilities have no effect outside the namespace unless the namespace is privileged. However, bugs in the kernel's user namespace + capability interaction code have been the root cause of multiple privilege escalation CVEs. At FAANG, the security team monitors kernel CVE advisories for user namespace capability issues and maintains a hotpatch deployment pipeline that can apply kernel security patches fleet-wide within hours of a high-severity CVE publication.

File capabilities (set on the executable binary via `setcap`) are a separate mechanism from process capabilities that container platforms must manage explicitly. An executable with `cap_net_bind_service+ep` set on it can bind privileged ports without the container having any effective capabilities at start. Image scanning must check for file capabilities on all executables in container images, because a compromised image that adds a setcap binary can silently grant capabilities to processes running inside what appears to be a capability-dropped container. This is a bar-raiser security signal: understanding that the capability model has an attack surface in the image build process, not just in the runtime configuration.

---, `CAP_NET_BIND_SERVICE` to bind ports below 1024, `CAP_SYS_PTRACE` to trace processes, `CAP_NET_ADMIN` to configure network interfaces, so a container can be granted exactly the privileges it needs and nothing more. Go accesses capability management through `golang.org/x/sys/unix` by reading and writing the capability header and data structures via `Capget` and `Capset` syscalls. The code below shows how to inspect the current capability set and drop capabilities selectively before exec'ing a container's init process.

```go
package capabilities

import (
	"fmt"

	"golang.org/x/sys/unix"
)

// Capability represents a Linux capability
type Capability int

const (
	CAP_CHOWN            Capability = 0
	CAP_DAC_OVERRIDE     Capability = 1
	CAP_DAC_READ_SEARCH  Capability = 2
	CAP_FOWNER           Capability = 3
	CAP_FSETID           Capability = 4
	CAP_KILL             Capability = 5
	CAP_SETGID           Capability = 6
	CAP_SETUID           Capability = 7
	CAP_SETPCAP          Capability = 8
	CAP_NET_BIND_SERVICE Capability = 10
	CAP_NET_RAW          Capability = 13
	CAP_SYS_CHROOT       Capability = 18
	CAP_SYS_PTRACE       Capability = 19
	CAP_SYS_ADMIN        Capability = 21
	CAP_SYS_BOOT         Capability = 22
	CAP_SYS_NICE         Capability = 23
	CAP_SYS_TIME         Capability = 25
	CAP_AUDIT_WRITE      Capability = 29
	CAP_SETFCAP          Capability = 31
	CAP_NET_ADMIN        Capability = 12
)

// CapabilitySet manages process capabilities
type CapabilitySet struct {
	effective   uint64
	permitted   uint64
	inheritable uint64
}

// DropAll removes all capabilities except the specified ones
func DropAll(keep []Capability) error {
	var keepMask uint64
	for _, cap := range keep {
		keepMask |= 1 << uint(cap)
	}

	// Drop capabilities not in keepMask
	var hdr unix.CapUserHeader
	var data [2]unix.CapUserData

	hdr.Version = 0x20080522 // _LINUX_CAPABILITY_VERSION_3
	hdr.Pid = 0

	if err := unix.Capget(&hdr, &data[0]); err != nil {
		return fmt.Errorf("capget: %w", err)
	}

	// Apply mask
	data[0].Effective &= uint32(keepMask)
	data[0].Permitted &= uint32(keepMask)
	data[0].Inheritable &= uint32(keepMask)
	data[1].Effective &= uint32(keepMask >> 32)
	data[1].Permitted &= uint32(keepMask >> 32)
	data[1].Inheritable &= uint32(keepMask >> 32)

	if err := unix.Capset(&hdr, &data[0]); err != nil {
		return fmt.Errorf("capset: %w", err)
	}

	return nil
}

// MinimalCapabilities returns the minimal set for a web server
func MinimalWebServerCapabilities() []Capability {
	return []Capability{
		CAP_NET_BIND_SERVICE, // Bind to ports < 1024
		CAP_SETUID,           // Drop to unprivileged user
		CAP_SETGID,
	}
}

// HasCapability checks if the current process has a capability
func HasCapability(cap Capability) bool {
	var hdr unix.CapUserHeader
	var data [2]unix.CapUserData
	hdr.Version = 0x20080522

	if err := unix.Capget(&hdr, &data[0]); err != nil {
		return false
	}

	if cap < 32 {
		return data[0].Effective&(1<<uint(cap)) != 0
	}
	return data[1].Effective&(1<<uint(cap-32)) != 0
}
```

---
