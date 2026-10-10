## 72.11 Company Case Studies

Real-world systems rely heavily on graph algorithms at their core. The case studies below are illustrative designs in the shape that mapping and social products use. They are not reproductions of any company's internals, which are not public, and you should present them that way in an interview rather than asserting what a specific company runs.

### Map Routing: Shortest Path with Real-Time Traffic

A routing engine models the road network as a weighted graph whose edge weights are travel times adjusted for traffic. A* extends Dijkstra's with a heuristic estimate of the remaining cost to the destination, which prunes the search dramatically: instead of expanding outward in all directions, the search is pulled toward the goal.

The heuristic here is haversine (great-circle) distance divided by an assumed speed. Read the next paragraph after the code before trusting that division, because it is the single line on which the algorithm's optimality rests.

```go
// A* routing over a road network
package routing

import (
    "container/heap"
    "math"
)

type RoadNetwork struct {
    nodes map[string]*Node
    edges map[string][]*Edge
}

type Node struct {
    ID       string
    Lat, Lng float64
}

type Edge struct {
    To       string
    Distance float64
    BaseTime float64
    Traffic  float64  // Multiplier (1.0 = normal)
}

type PathItem struct {
    NodeID   string
    Cost     float64
    EstTotal float64
    index    int
}

type PathHeap []*PathItem

func (h PathHeap) Len() int           { return len(h) }
func (h PathHeap) Less(i, j int) bool { return h[i].EstTotal < h[j].EstTotal }
func (h PathHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i]; h[i].index = i; h[j].index = j }
func (h *PathHeap) Push(x any)        { *h = append(*h, x.(*PathItem)) }
func (h *PathHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[0 : n-1]
    return x
}

// FindRoute uses A* algorithm for efficient routing
func (r *RoadNetwork) FindRoute(from, to string) ([]string, float64) {
    h := &PathHeap{}
    heap.Init(h)

    heap.Push(h, &PathItem{
        NodeID:   from,
        Cost:     0,
        EstTotal: r.heuristic(from, to),
    })

    costs := map[string]float64{from: 0}
    parent := map[string]string{}

    for h.Len() > 0 {
        curr := heap.Pop(h).(*PathItem)

        if curr.NodeID == to {
            return r.reconstructPath(parent, to), curr.Cost
        }

        for _, edge := range r.edges[curr.NodeID] {
            newCost := curr.Cost + edge.BaseTime*edge.Traffic

            if prevCost, visited := costs[edge.To]; !visited || newCost < prevCost {
                costs[edge.To] = newCost
                parent[edge.To] = curr.NodeID

                heap.Push(h, &PathItem{
                    NodeID:   edge.To,
                    Cost:     newCost,
                    EstTotal: newCost + r.heuristic(edge.To, to),
                })
            }
        }
    }

    return nil, -1
}

// heuristic estimates remaining travel time in the SAME units as Cost.
//
// maxSpeedKmh must be an upper bound on the speed achievable anywhere in
// the network. Dividing by a bound that is too low is safe (the heuristic
// just gets weaker and A* degrades toward Dijkstra). Dividing by one that
// is too high overestimates, breaks admissibility, and lets A* return a
// route that is not the fastest.
const maxSpeedKmh = 130.0

func (r *RoadNetwork) heuristic(from, to string) float64 {
    n1, n2 := r.nodes[from], r.nodes[to]
    return haversine(n1.Lat, n1.Lng, n2.Lat, n2.Lng) / maxSpeedKmh
}

func (r *RoadNetwork) reconstructPath(parent map[string]string, to string) []string {
    var path []string
    for node := to; node != ""; node = parent[node] {
        path = append([]string{node}, path...)
    }
    return path
}

func haversine(lat1, lng1, lat2, lng2 float64) float64 {
    const R = 6371
    dLat := (lat2 - lat1) * math.Pi / 180
    dLng := (lng2 - lng1) * math.Pi / 180
    a := math.Sin(dLat/2)*math.Sin(dLat/2) +
        math.Cos(lat1*math.Pi/180)*math.Cos(lat2*math.Pi/180)*math.Sin(dLng/2)*math.Sin(dLng/2)
    return 2 * R * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}
```

**The heuristic is the whole correctness argument, and it is easy to get wrong.** Two conditions matter. It must be **admissible**, never overestimating the true remaining cost, or A* can settle the goal via a worse path and return it. And the units must match: `Cost` accumulates `BaseTime * Traffic`, so the heuristic must also be a *time*, which is why the straight-line distance is divided by a speed at all.

Now notice what the divisor actually has to be. It is not the typical speed or the speed limit, it is an upper bound on any speed in the network. Divide by 100 km/h while a motorway allows 130 and the heuristic claims a trip takes longer than it can, which overestimates, which is exactly the thing that breaks A*. The failure is quiet: you still get a route, just not always the fastest one. Note also that a `Traffic` multiplier below 1.0 (faster than baseline) has the same effect, so if the model permits that, the bound must account for it.

One more detail: this implementation re-pushes on improvement and never checks whether a popped entry is stale. That is safe but wasteful, and adding `if curr.Cost > costs[curr.NodeID] { continue }` after the pop skips outdated entries. If the heuristic is also **consistent** (`h(u) <= w(u,v) + h(v)`), which haversine-over-max-speed is, then each node is settled once and no reopening is needed at all.

### Social Graph: Connection Recommendations

A "People You May Know" feature treats users as vertices and connections as edges. It explores two hops from the current user, collects the friends-of-friends who are not already direct connections, and ranks them by shared-connection count. A bounded min-heap extracts the top-K without sorting every candidate.

Watch the heap polarity, which follows the rule from Chapter 71: `Less` compares `MutualCount <`, making this a **min**-heap, and it is bounded at `limit` so the root is the weakest surviving recommendation and therefore the right one to evict. That is what keeps the k *strongest*.

```go
// "People You May Know" via 2-hop expansion and a bounded heap
package connections

import "container/heap"

type SocialGraph struct {
    connections map[string][]string
}

// FindMutualConnections finds people with most mutual friends
func (g *SocialGraph) FindMutualConnections(userID string, limit int) []Recommendation {
    directFriends := make(map[string]bool)
    for _, friend := range g.connections[userID] {
        directFriends[friend] = true
    }

    mutualCount := make(map[string]int)

    // Expand two hops. Each time a friend-of-friend is reached via a
    // different friend, that is one more mutual connection.
    for _, friend := range g.connections[userID] {
        for _, fof := range g.connections[friend] {
            if fof != userID && !directFriends[fof] {
                mutualCount[fof]++
            }
        }
    }

    // Bounded MIN-heap of size limit keeps the candidates with the
    // HIGHEST mutual counts: the root is the weakest one held, so it is
    // the one to evict when a better candidate arrives.
    h := &RecommendationHeap{}
    for candidate, count := range mutualCount { // not `userID`: that would
        // shadow the parameter and confuse every later reader
        heap.Push(h, &Recommendation{UserID: candidate, MutualCount: count})
        if h.Len() > limit {
            heap.Pop(h)
        }
    }

    // Min-heap pops ascending, so fill backwards for strongest-first.
    // Size from h.Len(), not limit: there may be fewer candidates than k.
    result := make([]Recommendation, h.Len())
    for i := len(result) - 1; i >= 0; i-- {
        result[i] = *heap.Pop(h).(*Recommendation)
    }
    return result
}

type Recommendation struct {
    UserID      string
    MutualCount int
}

type RecommendationHeap []*Recommendation

func (h RecommendationHeap) Len() int           { return len(h) }
func (h RecommendationHeap) Less(i, j int) bool { return h[i].MutualCount < h[j].MutualCount }
func (h RecommendationHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *RecommendationHeap) Push(x any)        { *h = append(*h, x.(*Recommendation)) }
func (h *RecommendationHeap) Pop() any {
    old := *h
    n := len(old)
    x := old[n-1]
    *h = old[0 : n-1]
    return x
}
```

### Junior → FAANG: Extracting Interview Insights from Case Studies

The routing example demonstrates A* with a haversine heuristic. The interview insight: **A* is Dijkstra's with a heuristic added to the priority.** The heap orders by `cost + heuristic` instead of `cost`, and setting `h(v) = 0` recovers Dijkstra's exactly, which is the cleanest way to say how they relate. The heuristic must be admissible (never overestimate) for the result to be optimal. Straight-line distance is admissible as a *distance* because no road is shorter than the great-circle path, and it stays admissible as a *time* only once divided by an upper bound on speed.

The "People You May Know" example pairs a 2-hop expansion with a bounded heap for ranking. Two honest notes. First, calling it "BFS to depth 2" is generous: there is no queue, just a nested loop, and the nested loop is the clearer way to write a fixed 2-hop expansion. Reach for real BFS when the depth is variable. Second, the counting relies on a subtlety worth stating: `mutualCount[fof]++` fires once per *distinct path* through a different friend, which is exactly the definition of a mutual connection.

Both examples combine a traversal with a ranking step, and that combination (traversal plus top-K) is a common interview follow-up shape. "Find the top-3 shortest paths" or "the 5 closest users by BFS depth" both follow it.

### Senior @ FAANG: Production Architecture Behind the Case Studies

The A* above is a simplified engine. A production routing stack layers several things on top, and the layering itself is the transferable lesson.

A hierarchy layer comes first. Contraction hierarchies (or a similar preprocessing scheme) precompute shortcut edges so that queries traverse a much smaller graph than the raw road network, which is what makes continent-scale routing feel instant. The trade is stark and worth naming: preprocessing can take hours and must be redone when the road network changes, so it suits topology (roads) and not conditions (traffic).

A traffic layer adjusts edge weights from historical patterns and live signals. This is where the tension with the hierarchy layer lives: contraction hierarchies bake distances into shortcuts, so changing edge weights threatens to invalidate the preprocessing. The standard resolution is customizable route planning, splitting preprocessing into a slow topology-only phase and a fast weight-dependent phase that can be re-run as conditions change. Recognizing that "just recompute the shortcuts" is infeasible at continental scale is exactly the kind of constraint a senior engineer should surface unprompted.

A multi-modal layer combines driving, transit, walking, and cycling into one query over a graph with typed edges and transfer costs between modes. Be careful here, because it is not simply "Dijkstra with more edges." Transit is time-dependent (you wait for a scheduled departure, so edge cost depends on arrival time) and users typically want a Pareto set trading off time, transfers, and cost rather than one optimum. That is a multi-criteria shortest-path problem, which is genuinely harder than Dijkstra and where the naive single-cost model quietly stops answering the real question.

A staff engineer owns a layer, not an algorithm. Any design change must answer: what does it do to query latency at the tail, to route quality, and to the freshness guarantee (how stale may traffic data be before routes degrade)? Graph algorithms are the foundation, the system is the deliverable.

---
