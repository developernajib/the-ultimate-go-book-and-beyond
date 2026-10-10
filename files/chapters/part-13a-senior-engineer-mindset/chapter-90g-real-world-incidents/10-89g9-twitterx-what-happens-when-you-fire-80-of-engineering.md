## 90G.9 Twitter/X: What Happens When You Fire 80% of Engineering

### The Incident

Between late 2022 and 2024, Twitter (rebranded to X) reduced its engineering staff by approximately 80%. This
was not a targeted reduction - it affected engineers across infrastructure, platform, trust and safety, and
product teams. The Sacramento data center was closed. Multiple outages followed.

**Timeline of Degradation:**

```
2022 Oct     Acquisition; immediate layoffs begin
2022 Nov     ~50% of staff laid off or quit
2022 Dec     Additional departures (voluntary + involuntary)
2023 Feb     Major outage: API errors, timeline loading failures
2023 Mar     Outage: Twitter Spaces, DMs partially down
2023 Jun     Rate limiting incident (self-inflicted)
2023 Dec     Extended outage affecting multiple features
2024         Continued intermittent issues, revenue ~50% below peak
```

**What Was Lost:**

```
┌───────────────────────────────────────────────────────────────────────────┐
│                  Institutional Knowledge Loss                             │
│                                                                           │
│  ┌──────────────────────────────────────┐                                 │
│  │       Before (7,500 total employees) │                                 │
│  │                                      │                                 │
│  │  ┌──────────┐  ┌──────────┐          │                                 │
│  │  │ Infra    │  │ Platform │          │                                 │
│  │  │ Team A   │──│ Team B   │──┐       │                                 │
│  │  │ (knows   │  │ (knows   │  │       │                                 │
│  │  │  why     │  │  how     │  │       │                                 │
│  │  │  cache   │  │  auth    │  │       │                                 │
│  │  │  TTL=7s) │  │  works)  │  │       │                                 │
│  │  └──────────┘  └──────────┘  │       │                                 │
│  │       │              │       │       │                                 │
│  │       ▼              ▼       ▼       │                                 │
│  │  Undocumented dependencies between   │                                 │
│  │  200+ microservices, known only      │                                 │
│  │  to the people who built them        │                                 │
│  └──────────────────────────────────────┘                                 │
│                                                                           │
│  ┌──────────────────────────────────────┐                                 │
│  │       After (~1,500 engineers)       │                                 │
│  │                                      │                                 │
│  │  ┌──────────┐  ┌──────────┐          │                                 │
│  │  │ Infra    │  │ Platform │          │                                 │
│  │  │ ???      │  │ ???      │          │                                 │
│  │  │ (nobody  │  │ (nobody  │          │                                 │
│  │  │  knows   │  │  knows   │          │                                 │
│  │  │  why     │  │  how)    │          │                                 │
│  │  │  TTL=7s) │  │          │          │                                 │
│  │  └──────────┘  └──────────┘          │                                 │
│  │                                      │                                 │
│  │  Hidden microservice dependencies    │                                 │
│  │  are now UNKNOWN dependencies        │                                 │
│  │  Runbooks reference people who left  │                                 │
│  │  On-call rotation has gaps           │                                 │
│  └──────────────────────────────────────┘                                 │
└───────────────────────────────────────────────────────────────────────────┘
```

### The Microservice Dependency Problem

Twitter's architecture consisted of over 200 microservices with complex interdependencies. Many of these
dependencies were implicit - not documented in any architecture diagram or dependency graph. They existed only in
the knowledge of the engineers who built and maintained them.

```go
package depgraph

import (
	"log/slog"
    "slices"
	"sort"
	"sync"
	"time"
)

// ServiceDependencyGraph discovers and tracks microservice dependencies
// through runtime observation, catching hidden dependencies that are
// not in any architecture diagram.
type ServiceDependencyGraph struct {
	mu           sync.RWMutex
	services     map[string]*ServiceNode
	edges        map[string]map[string]*DependencyEdge
	logger       *slog.Logger
}

// ServiceNode represents a microservice in the dependency graph.
type ServiceNode struct {
	Name         string
	Team         string
	OnCallRotation string
	Criticality  string // "critical", "high", "medium", "low"
	LastSeen     time.Time
}

// DependencyEdge represents a runtime-observed dependency between services.
type DependencyEdge struct {
	From           string
	To             string
	RequestCount   int64
	ErrorCount     int64
	LastObserved   time.Time
	MeanLatency    time.Duration
	P99Latency     time.Duration
	IsDocumented   bool
	DiscoveredAt   time.Time
}

// NewServiceDependencyGraph creates a new dependency tracker.
func NewServiceDependencyGraph(logger *slog.Logger) *ServiceDependencyGraph {
	return &ServiceDependencyGraph{
		services: make(map[string]*ServiceNode),
		edges:    make(map[string]map[string]*DependencyEdge),
		logger:   logger,
	}
}

// RecordCall records an observed call from one service to another.
// This should be called from service mesh / sidecar proxy telemetry.
func (g *ServiceDependencyGraph) RecordCall(from, to string, latency time.Duration, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	now := time.Now()

	// Ensure nodes exist
	if _, ok := g.services[from]; !ok {
		g.services[from] = &ServiceNode{Name: from, LastSeen: now}
	}
	if _, ok := g.services[to]; !ok {
		g.services[to] = &ServiceNode{Name: to, LastSeen: now}
	}
	g.services[from].LastSeen = now
	g.services[to].LastSeen = now

	// Ensure edge map exists
	if _, ok := g.edges[from]; !ok {
		g.edges[from] = make(map[string]*DependencyEdge)
	}

	edge, exists := g.edges[from][to]
	if !exists {
		edge = &DependencyEdge{
			From:         from,
			To:           to,
			DiscoveredAt: now,
			IsDocumented: false,
		}
		g.edges[from][to] = edge

		g.logger.Warn("NEW dependency discovered at runtime",
			"from", from, "to", to,
			"documented", false,
			"action", "verify this dependency is intentional and add to architecture docs")
	}

	edge.RequestCount++
	edge.LastObserved = now
	if err != nil {
		edge.ErrorCount++
	}

	// Update latency (exponential moving average)
	if edge.MeanLatency == 0 {
		edge.MeanLatency = latency
	} else {
		edge.MeanLatency = edge.MeanLatency/2 + latency/2
	}
	if latency > edge.P99Latency {
		edge.P99Latency = latency
	}
}

// FindUndocumentedDependencies returns all runtime-observed dependencies
// that are not marked as documented.
func (g *ServiceDependencyGraph) FindUndocumentedDependencies() []*DependencyEdge {
	g.mu.RLock()
	defer g.mu.RUnlock()

	var undocumented []*DependencyEdge
	for _, targets := range g.edges {
		for _, edge := range targets {
			if !edge.IsDocumented {
				undocumented = append(undocumented, edge)
			}
		}
	}

	sort.Slice(undocumented, func(i, j int) bool {
		return undocumented[i].RequestCount > undocumented[j].RequestCount
	})

	return undocumented
}

// FindCriticalPath returns the services that form the critical path
// for a given entry service (e.g., what MUST work for login to succeed).
func (g *ServiceDependencyGraph) FindCriticalPath(entryService string) []string {
	g.mu.RLock()
	defer g.mu.RUnlock()

	visited := make(map[string]bool)
	var path []string

	var dfs func(service string)
	dfs = func(service string) {
		if visited[service] {
			return
		}
		visited[service] = true
		path = append(path, service)

		if deps, ok := g.edges[service]; ok {
			for target, edge := range deps {
				// Only follow high-traffic edges (likely critical)
				if edge.RequestCount > 100 {
					dfs(target)
				}
			}
		}
	}

	dfs(entryService)
	return path
}

// ImpactAnalysis returns all services that would be affected if a given
// service goes down.
func (g *ServiceDependencyGraph) ImpactAnalysis(failedService string) []string {
	g.mu.RLock()
	defer g.mu.RUnlock()

	// Find all services that depend ON the failed service (reverse edges)
	affected := make(map[string]bool)
	var findDependents func(service string)
	findDependents = func(service string) {
		for from, targets := range g.edges {
			if _, ok := targets[service]; ok {
				if !affected[from] {
					affected[from] = true
					findDependents(from) // transitive dependents
				}
			}
		}
	}

	findDependents(failedService)

	result := make([]string, 0, len(affected))
	for svc := range affected {
		result = append(result, svc)
	}
	slices.Sort(result)
	return result
}

// GenerateOwnershipReport identifies services with no known team owner.
// This is the Twitter/X problem: when 80% of engineering leaves,
// which services have NO remaining owner?
func (g *ServiceDependencyGraph) GenerateOwnershipReport() *OwnershipReport {
	g.mu.RLock()
	defer g.mu.RUnlock()

	report := &OwnershipReport{
		TotalServices: len(g.services),
	}

	for _, svc := range g.services {
		if svc.Team == "" || svc.OnCallRotation == "" {
			report.Orphaned = append(report.Orphaned, svc.Name)
		}
	}

	slices.Sort(report.Orphaned)
	report.OrphanedCount = len(report.Orphaned)
	return report
}

// OwnershipReport summarizes service ownership status.
type OwnershipReport struct {
	TotalServices int
	OrphanedCount int
	Orphaned      []string
}
```

### Key Lessons

**Lesson 1: Institutional knowledge is the most valuable and least documented asset.** The engineers who left
Twitter knew why specific configuration values were set, which microservices had hidden dependencies, what the
failure modes were, and how to recover from incidents. None of this was thoroughly documented.

**Lesson 2: Microservice dependencies must be discovered, not just documented.** Architecture diagrams become
stale the moment they are drawn. Runtime dependency discovery - observing actual service-to-service calls - is the
only way to maintain an accurate dependency graph.

**Lesson 3: Revenue follows reliability.** Twitter's revenue dropped approximately 50% from its peak. While
multiple factors contributed, degraded service reliability certainly affected advertiser confidence and user
engagement. Reliability is not a cost center - it is a revenue enabler.

### Junior → FAANG: Institutional Knowledge as an Engineering Artifact

The Twitter case illustrates that undocumented knowledge is a liability. For junior engineers, the lesson is to document as you learn: when you discover why a configuration value is set a certain way, add a comment. When you figure out why a service has an unusual behavior, write it in the runbook. This habit, applied consistently over years, is what separates teams that survive organizational change from those that do not.

The runtime dependency discovery pattern in this section is a concrete interview answer to "how do you maintain an accurate architecture diagram as a system evolves?" The answer is: you don't maintain it manually. You discover it at runtime from service mesh telemetry, and you flag new dependencies as they appear.

### Senior @ FAANG: Knowledge Preservation as a Platform Concern

At L6, institutional knowledge preservation is a governance responsibility. The dependency graph discovery system in this section is a platform tool: it continuously maps which services call which other services, flags undocumented dependencies, generates ownership reports showing orphaned services, and provides impact analysis for planned changes. Building and maintaining this system is a staff-level contribution that makes the entire org more resilient to personnel change.

The Twitter incident is also a case study in the limits of "move fast" culture. The staff engineer's role is to be the voice that says "if we cut this team, we lose the knowledge of how these 40 services interact, and we will discover the gaps when something breaks at 3 AM." That argument requires data: the dependency graph, the ownership map, and the impact analysis. Without data, it is an opinion. With data, it is an engineering recommendation.

---
