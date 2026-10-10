## 90G.17 Datadog 51-Hour Outage (March 2023) - When systemd Deletes Your Network

*A routine OS-level update triggered systemd to remove Cilium-managed network routes, and pods across the
fleet lost connectivity. Nobody had anticipated the interaction between systemd-networkd and Cilium's
eBPF-based networking. (As described in Datadog's public incident retrospective.)*

### The Incident

In March 2023, Datadog - one of the world's leading observability platforms, the very company people use to
monitor their infrastructure - experienced an outage lasting approximately **27 hours**. The irony was not lost
on the industry: the monitoring company could not monitor itself.

The root cause involved a subtle and dangerous interaction between two infrastructure components:

1. **Cilium** - a Kubernetes CNI (Container Network Interface) plugin that uses eBPF to manage pod networking
2. **systemd-networkd** - the Linux system service manager's network management component

During a routine operating system update, systemd-networkd was restarted. When systemd-networkd starts, it
reconciles its view of network routes with what it expects - and it **deletes any routes it did not create**.
Cilium had programmed custom network routes for Kubernetes pod-to-pod communication using eBPF. These routes
were invisible to systemd-networkd's configuration, so systemd-networkd classified them as "stale" and
deleted them.

The result: pods across the Kubernetes cluster instantly lost network connectivity to each other. Services
could not communicate. Datadog's own monitoring infrastructure, built on the same Kubernetes cluster, was
also affected - creating the familiar pattern where recovery tools depend on the failing system.

### Root Cause: The Configuration Ownership Problem

The failure stemmed from two infrastructure components each believing they were the authoritative owner of network routes on the same machine. When systemd-networkd restarted and reconciled its state, it destroyed routes that Cilium had created, because neither component was aware of the other's ownership claims.

```
┌─────────────────────────────────────────────────────────────────────────┐
│              THE CONFIGURATION OWNERSHIP CONFLICT                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────────┐      ┌──────────────────────┐                 │
│  │    systemd-networkd  │       │       Cilium          │               │
│  │                      │        │                        │             │
│  │  "I own all network  │       │  "I own pod network   │               │
│  │   routes on this     │       │   routes via eBPF     │               │
│  │   machine"           │       │   programs"           │               │
│  │                      │        │                        │             │
│  │  On restart:         │       │  Creates routes:      │               │
│  │  - Read my config    │       │  - Pod CIDR routes    │               │
│  │  - Delete anything   │       │  - Service routes     │               │
│  │    NOT in my config  │       │  - Policy routes      │               │
│  └──────────┬───────────┘      └──────────┬───────────┘                 │
│             │                              │                            │
│             │    CONFLICT                  │                            │
│             ▼                              ▼                            │
│  ┌──────────────────────────────────────────────────────┐               │
│  │               Linux Routing Table                    │               │
│  │                                                      │               │
│  │  Cilium routes: 10.0.0.0/24 via veth_abc123          │               │
│  │  Cilium routes: 10.0.1.0/24 via veth_def456          │               │
│  │                                                      │               │
│  │  systemd-networkd: "I didn't create these. DELETE."  │               │
│  └──────────────────────────────────────────────────────┘               │
│                                                                         │
│  RESULT: All pod-to-pod networking destroyed instantly.                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### Go Implementation: Network Route Guardian

The core defense is an explicit ownership registry that tracks which component created each route. When systemd-networkd restarts and attempts a reconciliation sweep, the registry blocks deletions of routes it did not register, turning the implicit assumption of exclusive ownership into an enforced invariant. The `RouteGuardian` runs a parallel reconciliation loop that detects routes deleted by any component and restores them within a single check interval, bounding the blast radius of any future restart event.

```go
package routeguard

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Route represents a network route on a Linux system.
type Route struct {
	Destination string // CIDR, e.g., "10.0.0.0/24"
	Gateway     string // next hop, e.g., "10.0.0.1"
	Interface   string // e.g., "veth_abc123"
	Source      string // which component created this route
	Priority    int
	CreatedAt   time.Time
}

// RouteOwnership tracks which system component owns which routes.
type RouteOwnership struct {
	mu     sync.RWMutex
	routes map[string]*Route // destination CIDR to Route
	owners map[string]string // destination CIDR to owner component name
	logger *slog.Logger
}

// NewRouteOwnership creates a route ownership tracker.
func NewRouteOwnership(logger *slog.Logger) *RouteOwnership {
	return &RouteOwnership{
		routes: make(map[string]*Route),
		owners: make(map[string]string),
		logger: logger,
	}
}

// Register declares ownership of a route by a component.
func (ro *RouteOwnership) Register(owner string, route *Route) error {
	ro.mu.Lock()
	defer ro.mu.Unlock()

	existing, exists := ro.owners[route.Destination]
	if exists && existing != owner {
		return fmt.Errorf("route %s already owned by %s, cannot assign to %s",
			route.Destination, existing, owner)
	}

	ro.routes[route.Destination] = route
	ro.owners[route.Destination] = owner
	ro.logger.Info("route registered",
		"destination", route.Destination,
		"owner", owner,
		"interface", route.Interface,
	)
	return nil
}

// CanDelete checks if a component is allowed to delete a route.
func (ro *RouteOwnership) CanDelete(requester string, destination string) bool {
	ro.mu.RLock()
	defer ro.mu.RUnlock()

	owner, exists := ro.owners[destination]
	if !exists {
		ro.logger.Warn("deletion requested for untracked route",
			"requester", requester,
			"destination", destination,
		)
		return true
	}

	if owner != requester {
		ro.logger.Error("BLOCKED: unauthorized route deletion attempt",
			"requester", requester,
			"owner", owner,
			"destination", destination,
		)
		return false
	}
	return true
}

// RouteGuardian watches the routing table and restores deleted routes.
type RouteGuardian struct {
	ownership     *RouteOwnership
	getRoutesFn   func(ctx context.Context) ([]Route, error)
	addRouteFn    func(ctx context.Context, route *Route) error
	checkInterval time.Duration
	logger        *slog.Logger
}

// NewRouteGuardian creates a guardian that monitors and restores routes.
func NewRouteGuardian(
	ownership *RouteOwnership,
	getRoutesFn func(ctx context.Context) ([]Route, error),
	addRouteFn func(ctx context.Context, route *Route) error,
	checkInterval time.Duration,
	logger *slog.Logger,
) *RouteGuardian {
	return &RouteGuardian{
		ownership:     ownership,
		getRoutesFn:   getRoutesFn,
		addRouteFn:    addRouteFn,
		checkInterval: checkInterval,
		logger:        logger,
	}
}

// Run starts the guardian loop that detects and restores missing routes.
func (rg *RouteGuardian) Run(ctx context.Context) error {
	ticker := time.NewTicker(rg.checkInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := rg.reconcile(ctx); err != nil {
				rg.logger.Error("route reconciliation failed", "error", err)
			}
		}
	}
}

// reconcile compares expected routes against actual routes and restores missing ones.
func (rg *RouteGuardian) reconcile(ctx context.Context) error {
	currentRoutes, err := rg.getRoutesFn(ctx)
	if err != nil {
		return fmt.Errorf("failed to get current routes: %w", err)
	}

	currentSet := make(map[string]bool)
	for _, r := range currentRoutes {
		currentSet[r.Destination] = true
	}

	rg.ownership.mu.RLock()
	defer rg.ownership.mu.RUnlock()

	restoredCount := 0
	for dest, route := range rg.ownership.routes {
		if !currentSet[dest] {
			rg.logger.Warn("registered route missing - restoring",
				"destination", dest,
				"owner", rg.ownership.owners[dest],
				"interface", route.Interface,
			)
			if err := rg.addRouteFn(ctx, route); err != nil {
				rg.logger.Error("failed to restore route",
					"destination", dest, "error", err)
				continue
			}
			restoredCount++
		}
	}

	if restoredCount > 0 {
		rg.logger.Info("route reconciliation complete",
			"restored", restoredCount,
		)
	}
	return nil
}

// SystemdNetworkdSafeRestart demonstrates how to safely restart networkd
// without destroying routes owned by other components.
type SystemdNetworkdSafeRestart struct {
	ownership *RouteOwnership
	logger    *slog.Logger
}

// PreRestart captures all routes that must be preserved across the restart.
func (s *SystemdNetworkdSafeRestart) PreRestart(ctx context.Context,
	getRoutesFn func(ctx context.Context) ([]Route, error),
) ([]Route, error) {
	routes, err := getRoutesFn(ctx)
	if err != nil {
		return nil, err
	}

	var preserve []Route
	for _, r := range routes {
		if !s.ownership.CanDelete("systemd-networkd", r.Destination) {
			preserve = append(preserve, r)
			s.logger.Info("route marked for preservation across restart",
				"destination", r.Destination,
				"owner", r.Source,
			)
		}
	}
	return preserve, nil
}

// PostRestart restores all preserved routes after networkd has restarted.
func (s *SystemdNetworkdSafeRestart) PostRestart(ctx context.Context,
	preserved []Route,
	addRouteFn func(ctx context.Context, route *Route) error,
) error {
	for i := range preserved {
		if err := addRouteFn(ctx, &preserved[i]); err != nil {
			s.logger.Error("failed to restore route after restart",
				"destination", preserved[i].Destination, "error", err)
			return err
		}
	}
	s.logger.Info("all preserved routes restored", "count", len(preserved))
	return nil
}
```

### Key Lessons for Go Engineers

1. **Configuration ownership must be explicit** - when two systems both believe they own the same resource
   (network routes, config files, DNS entries), conflict is inevitable. Build ownership registries.
2. **System-level updates can destroy application-level state** - OS package updates, systemd restarts, and
   kernel upgrades can wipe out state that applications assume is persistent. Design for state loss.
3. **eBPF-based networking is invisible to traditional tools** - routes managed by Cilium/eBPF may not
   appear in standard configuration files that systemd reads. This invisibility creates a blind spot.
4. **Monitor the monitoring** - when your observability platform is the one having the outage, you need
   independent, out-of-band monitoring that does not depend on the primary monitoring stack.

### Exercises

1. Build a **route ownership daemon** in Go that uses netlink to watch the Linux routing table in real-time
   and blocks deletions of routes owned by other components.
2. Implement a **pre-restart hook system** that captures and restores critical state across service restarts,
   using a Unix domain socket protocol for coordination between systemd and applications.
3. Design a **canary OS update pipeline** that applies OS updates to a single node, validates all network
   routes and pod connectivity, then proceeds to the next node only on success.

---

### Junior → FAANG: Implicit Ownership Conflicts as a System Design Anti-Pattern

The Datadog outage is the interview answer to "what are the risks of shared mutable infrastructure state?" Two systems (systemd-networkd and Cilium) both modified the routing table without coordinating ownership. When systemd restarted, it applied its view of correct routes by deleting routes it did not own. This is the distributed systems equivalent of two goroutines writing to a shared map without a mutex. The defense is the ownership registry pattern: before any system modifies shared infrastructure state, it checks a registry to determine if it owns that resource. For interviews, frame this as a concrete design principle: every shared resource (route, DNS record, certificate, port, database row) must have exactly one owner at any point in time. State changes to that resource flow through the owner. Systems that need to read the resource observe it, but only the owner writes it. The `RouteOwnership` and `RouteGuardian` implementations in this section demonstrate the pattern in working Go code.

### Senior @ FAANG: OS Update Governance and Infrastructure State Reconciliation as Platform Standards

At L6, the Datadog outage is a configuration drift incident at the infrastructure layer. systemd-networkd's view of correct routing state had drifted from the actual operating state maintained by Cilium. When systemd was given authority to act (through a restart triggered by a package update), it reconciled toward its own view and destroyed the Cilium state. The root cause is not the package update or the systemd restart. It is that the OS update pipeline did not validate post-update network state before marking the node as healthy.

The staff-level response is to define infrastructure state as a governed resource with explicit reconciliation protocol. Every layer that manages node state (OS packages, kernel modules, systemd units, CNI plugins, eBPF programs) must expose a state validation interface: a binary health check that confirms the layer's view of the world is consistent with what the node is actually doing. The OS update pipeline calls each layer's validation interface in dependency order after applying updates, blocks promotion to the next node if any validation fails, and rolls back the update if validation cannot be achieved within a timeout.

This requires a platform investment: a node state validation framework that each infrastructure component registers with, and a canary OS update controller (the pattern in Exercise 3 above, elevated to production-grade platform tooling) that enforces the validation gate. The investment is high, but the alternative is a 51-hour outage at an observability company that cannot observe its own outage. Measure the investment by its return: at Datadog's scale (hundreds of thousands of monitored hosts), one prevented multi-day outage covers the engineering cost of the platform tooling many times over. Present this trade-off to leadership as a risk-adjusted ROI, not as infrastructure maintenance work.

