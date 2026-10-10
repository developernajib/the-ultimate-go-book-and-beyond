## 75.11 Company Case Studies

### Uber: Ride Assignment

A ride-hailing platform must decide, continuously, which of the incoming ride requests to serve with the drivers it has. A greedy baseline ranks rides by an efficiency metric, such as fare divided by total distance (including the driver's travel to the pickup point), and takes the highest-efficiency rides until the drivers run out.

Be clear about what this baseline does and does not do, because the gap is the interesting part. Selecting which rides to serve is not the same problem as deciding which driver takes which ride. The latter is bipartite matching on a cost matrix, and greedy does not solve it optimally: pairing the globally best ride and driver first can strand a driver who was the only reasonable option for some other ride. That problem has a real algorithm, the Hungarian algorithm, at O(n^3). The code below is deliberately the simpler thing, ride selection, and it is shown as a ranking baseline rather than an optimal matcher.

```go
// A greedy ride-selection baseline for a ride-hailing platform.
package matching

import (
    "cmp"
    "slices"
)

type Ride struct {
    ID         string
    Distance   float64
    FareCents  int64
    DriverDist float64 // Distance from the nearest available driver.
}

// SelectRides ranks rides by fare per total distance travelled and returns the
// best availableDrivers of them. It selects which rides to serve, and does not
// decide which driver serves which ride. That is an assignment problem.
//
// Sorts rides in place. Time: O(n log n), Space: O(log n) for the sort's stack.
func SelectRides(rides []Ride, availableDrivers int) []Ride {
    // Efficiency = fare / (ride distance + deadhead distance to pickup).
    // Cross-multiplied instead of divided so that a zero total distance yields
    // no Inf or NaN, which would make the comparator inconsistent.
    slices.SortFunc(rides, func(a, b Ride) int {
        return cmp.Compare(float64(b.FareCents)*(a.Distance+a.DriverDist), float64(a.FareCents)*(b.Distance+b.DriverDist))
    })

    if len(rides) > availableDrivers {
        return rides[:availableDrivers]
    }
    return rides
}
```

### Netflix: Server Load Balancing

A streaming service must distribute incoming requests across servers so that no single server becomes the bottleneck. A greedy strategy sorts requests by size (largest first) and assigns each to the server with the least current load. This is exactly the Longest Processing Time (LPT) heuristic for scheduling on identical machines, and it comes with a real guarantee: the makespan is within a factor of 4/3 - 1/(3m) of optimal on m machines, so under 4/3 and improving as m grows. Note what the guarantee requires, because it is easy to quote and hard to earn: every job known up front, sizes accurate, machines identical. Runtime is O(n log n) for the sort plus O(n * m) for assignment with the linear scan below, which a min-heap keyed on load would reduce to O(n log m).

```go
// A greedy LPT load balancer.
// Time: O(n log n + n*m), Space: O(n + m)
func BalanceLoad(requests []int, numServers int) [][]int {
    if numServers <= 0 {
        return nil
    }

    servers := make([][]int, numServers)
    loads := make([]int, numServers)

    // Sort a copy, largest first, so the caller's slice is left alone.
    sorted := slices.Clone(requests)
    slices.SortFunc(sorted, func(a, b int) int {
        return cmp.Compare(b, a)
    })

    // Assign each request to the least loaded server.
    for _, req := range sorted {
        minIdx := 0
        for i := 1; i < numServers; i++ {
            if loads[i] < loads[minIdx] {
                minIdx = i
            }
        }
        servers[minIdx] = append(servers[minIdx], req)
        loads[minIdx] += req
    }

    return servers
}
```

---

### Junior → FAANG: Reading Company Case Studies as Interview Signals

These case studies (Uber ride assignment, Netflix load balancing) are useful for two reasons. First, they show how greedy algorithms appear in real systems, which helps you contextualize dry algorithm problems. Second, they give you talking points in behavioral and system design interviews when asked "tell me about a time you applied an algorithm in practice."

When studying the ride-hailing case study, notice that the efficiency metric combines two costs (driver travel distance and ride distance). This is a ratio-based greedy, in the same family as fractional knapsack. But do not carry fractional knapsack's optimality proof over to it. Fractional knapsack is optimal because items are divisible, and rides are not: a ride is taken or it is not, which makes selection the 0/1 case, where ratio greedy is a heuristic and nothing more. Ranking by ratio here buys a sensible baseline, not a guarantee.

The independence question is worth being honest about too. Ride selection and driver assignment are separable only if any driver can serve any ride at the stated cost. The moment `DriverDist` is specific to a driver, choosing who takes ride A changes the cost of ride B, the choices are coupled, and you are in bipartite matching rather than sorting. Push further, to a driver serving several rides in sequence, and it becomes a vehicle routing problem, which is NP-hard. This is the honest progression: sort, then match, then route, with the guarantee weakening at every step.

For load balancing, LPT's bound is 4/3 - 1/(3m) on m machines. Quoting the exact form rather than a rounded "4/3" is a good interview signal, because it shows you know the bound is a theorem with conditions attached rather than a slogan.

### Senior @ FAANG: Case Studies as Architecture Review Templates

Company case studies like these should be read as compressed architecture review templates. The Uber ride assignment case implicitly involves several design decisions that a staff engineer would make explicit: the time window for batch assignment (greedy on a batch of 100 rides vs. online assignment per ride), the definition of the efficiency metric (does it include driver rating, trip type, or surge pricing?), the fairness constraint (prevent assigning all efficient rides to a few drivers while others starve), and the fallback when the greedy assignment produces a suboptimal market-level outcome.

**Fairness vs. efficiency in two-sided markets.** The tension between greedy efficiency maximization and participant fairness is a well-studied problem in two-sided marketplaces generally. A purely greedy assignment maximizes a platform-level metric such as revenue per driver-hour, but nothing in the objective prevents it from concentrating the good rides on a small subset of drivers while the rest starve. Greedy optimizes what you asked for, which is the problem. The usual response is to make fairness an explicit constraint rather than hoping efficiency delivers it as a side effect, for example by bounding how far any driver's assignment quality may drift from the median. The moment you do that, it is constrained optimization and no longer a sort, and the constraint is where the implementation difficulty lives.

**Load balancing at scale.** The LPT heuristic in the case study works on a static set of requests. Real streaming traffic is nothing like that: requests arrive continuously, servers fail, capacities differ, and no one knows a request's cost before serving it. Production load balancers are correspondingly layered, typically combining consistent hashing for cache locality, health-aware weighted balancing for failure resilience, and circuit breakers for overload protection. "Assign to the least loaded server" is at most one layer of that stack, and its 4/3 makespan bound does not survive the trip: the bound is a theorem about the offline problem where all jobs and sizes are known in advance. In the online case with dynamic arrivals, the bound degrades, and the system relies on the other layers to compensate. A staff engineer designing such a system documents which layer handles which failure mode and what the SLA impact is when each layer degrades.

---

### Beyond Pure Greedy: Metaheuristic Optimization & The Artificial Bee Colony (ABC) Algorithm

In production systems, greedy strategies fail when the cost landscape is multimodal (containing multiple local minima) or non-convex. When scheduling jobs across heterogenous clusters, routing network packets across non-linear congestion graphs, or tuning database cache parameters, making the locally optimal choice at each step almost always leads to premature convergence at a mediocre local optimum.

In [I Built A Procedurally Generated Colony Simulator In Golang To Watch Bee Foraging Behavior](https://medium.com/@saedarm/i-built-a-procedurally-generated-colony-simulator-in-golang-to-watch-bee-foraging-behavior-98cb2ec665a3), S.A. Routh demonstrates how decentralized metaheuristic algorithms - specifically the Artificial Bee Colony (ABC) algorithm developed by Derviş Karaboğa - solve complex optimization problems where greedy approaches stall.

#### 1. The Tripartite Optimization Architecture

The ABC algorithm divides candidate exploration into three distinct phases that balance local neighborhood exploitation against global stochastic exploration:

```
┌────────────────────────────────────────────────────────────────────────┐
│             ARTIFICIAL BEE COLONY (ABC) OPTIMIZATION LOOP              │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Phase 1: EMPLOYED BEES (Exploitation)                                 │
│  Each bee searches around its known food source:                       │
│  v_ij = x_ij + φ_ij * (x_ij - x_kj)                                    │
│  Greedy update: if fitness(v) > fitness(x), replace x; else trials++   │
│                                                                        │
│  Phase 2: ONLOOKER BEES (Reinforcement Selection)                      │
│  Bees at the hive evaluate fitness probabilities:                      │
│  P_i = fitness_i / Σ(fitness)                                          │
│  Roulette-wheel selection allocates more workers to higher-yield sites │
│                                                                        │
│  Phase 3: SCOUT BEES (Escaping Local Minima)                           │
│  If trials > abandonment_limit:                                        │
│  Discard trapped solution!                                             │
│  Spawn new random position uniformly across solution space             │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

#### 2. Go Implementation: Multimodal Optimization Engine

Below is a self-contained Go implementation of the Artificial Bee Colony algorithm optimizing a multidimensional non-linear objective function:

```go
package abc

import (
	"math"
	"math/rand"
	"time"
)

// ObjectiveFunc evaluates the fitness of a candidate parameter vector.
// Returns a cost value to minimize.
type ObjectiveFunc func(params []float64) float64

// Solution represents a candidate solution in the search space.
type Solution struct {
	Params  []float64
	Cost    float64
	Fitness float64
	Trials  int
}

// Config controls ABC search parameters.
type Config struct {
	ColonySize   int     // Number of food sources (employed bees)
	Dimensions   int     // Number of variables to optimize
	MaxCycles    int     // Maximum iterations
	Limit        int     // Abandonment threshold to convert to Scout
	LowerBound   float64 // Minimum parameter bound
	UpperBound   float64 // Maximum parameter bound
}

type Colony struct {
	cfg       Config
	obj       ObjectiveFunc
	sources   []Solution
	best      Solution
	rng       *rand.Rand
}

func NewColony(cfg Config, obj ObjectiveFunc) *Colony {
	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	c := &Colony{
		cfg:     cfg,
		obj:     obj,
		sources: make([]Solution, cfg.ColonySize),
		rng:     r,
	}

	for i := 0; i < cfg.ColonySize; i++ {
		c.sources[i] = c.randomSolution()
		if i == 0 || c.sources[i].Cost < c.best.Cost {
			c.best = c.sources[i]
		}
	}

	return c
}

func (c *Colony) randomSolution() Solution {
	params := make([]float64, c.cfg.Dimensions)
	for d := 0; d < c.cfg.Dimensions; d++ {
		params[d] = c.cfg.LowerBound + c.rng.Float64()*(c.cfg.UpperBound-c.cfg.LowerBound)
	}
	cost := c.obj(params)
	return Solution{
		Params:  params,
		Cost:    cost,
		Fitness: calculateFitness(cost),
		Trials:  0,
	}
}

func calculateFitness(cost float64) float64 {
	if cost >= 0 {
		return 1.0 / (1.0 + cost)
	}
	return 1.0 + math.Abs(cost)
}

// Step executes one generation of Employed, Onlooker, and Scout phases.
func (c *Colony) Step() {
	// Phase 1: Employed Bees (Local neighborhood search)
	for i := 0; i < c.cfg.ColonySize; i++ {
		c.exploreNeighborhood(i)
	}

	// Phase 2: Onlooker Bees (Roulette-wheel selection)
	totalFitness := 0.0
	for i := 0; i < c.cfg.ColonySize; i++ {
		totalFitness += c.sources[i].Fitness
	}

	for i := 0; i < c.cfg.ColonySize; i++ {
		prob := c.sources[i].Fitness / totalFitness
		if c.rng.Float64() < prob {
			c.exploreNeighborhood(i)
		}
	}

	// Phase 3: Scout Bees (Abandonment of exhausted local minima)
	for i := 0; i < c.cfg.ColonySize; i++ {
		if c.sources[i].Trials > c.cfg.Limit {
			c.sources[i] = c.randomSolution()
		}
	}
}

func (c *Colony) exploreNeighborhood(idx int) {
	s := &c.sources[idx]

	// Choose random neighbor distinct from idx
	neighborIdx := c.rng.Intn(c.cfg.ColonySize)
	for neighborIdx == idx {
		neighborIdx = c.rng.Intn(c.cfg.ColonySize)
	}

	// Perturb random parameter dimension
	paramIdx := c.rng.Intn(c.cfg.Dimensions)
	phi := (c.rng.Float64() * 2.0) - 1.0 // Range [-1.0, 1.0]

	candidateParams := make([]float64, c.cfg.Dimensions)
	copy(candidateParams, s.Params)
	candidateParams[paramIdx] += phi * (s.Params[paramIdx] - c.sources[neighborIdx].Params[paramIdx])

	// Clamp within bounds
	candidateParams[paramIdx] = math.Max(c.cfg.LowerBound, math.Min(c.cfg.UpperBound, candidateParams[paramIdx]))

	candidateCost := c.obj(candidateParams)
	candidateFitness := calculateFitness(candidateCost)

	// Greedy selection between candidate and current
	if candidateFitness > s.Fitness {
		s.Params = candidateParams
		s.Cost = candidateCost
		s.Fitness = candidateFitness
		s.Trials = 0

		if candidateCost < c.best.Cost {
			c.best = *s
		}
	} else {
		s.Trials++
	}
}
```

#### 3. Algorithmic Trade-Off Matrix

| Strategy | Exploitation Power | Exploration (Escape) Power | Convergence Speed | Implementation Complexity |
|---|---|---|---|---|
| **Pure Greedy (e.g., LPT)** | Immediate | Zero (stuck in first local valley) | O(N log N) | Very Low |
| **Gradient Descent** | High (in convex space) | Zero (diverges in jagged landscapes) | Fast | Low |
| **Simulated Annealing** | Moderate | High early, decays with temperature | Moderate | Low |
| **Artificial Bee Colony (ABC)** | High (via Onlooker bees) | High (Scout bees continuously reset stagnant lines) | Amortized steady | Moderate |

When designing optimization engines in production Go services - whether balancing warehouse worker picking paths or optimizing container packing budgets across Kubernetes nodes - understanding the limits of pure greedy choices and applying metaheuristics prevents deadlocked local minima.
