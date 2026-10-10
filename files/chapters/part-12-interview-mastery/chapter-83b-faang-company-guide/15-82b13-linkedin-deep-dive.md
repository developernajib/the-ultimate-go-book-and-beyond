## 83B.13 LinkedIn Deep Dive

### Overview for Go Engineers

LinkedIn is Microsoft's professional network subsidiary with 1 billion+ members. Go has grown significantly in LinkedIn's infrastructure - powering real-time messaging, feed serving, search indexing pipelines, and member data APIs. LinkedIn's engineering challenges are dominated by graph problems (social connections), feed ranking (personalization at scale), search (people/jobs/content), and messaging systems. The interview process is methodical and Microsoft-influenced (LinkedIn was acquired in 2016): expect rigorous behavioral questions alongside technical rounds. LinkedIn values engineers who can operate on extremely high-fan-out systems - a single "share" can propagate to millions of followers. Go engineers work on the infrastructure side, particularly on high-throughput, low-latency systems that serve the member graph and feed.

### Interview Process

LinkedIn's loop is methodical and rubric-driven, with a strong culture-and-craftsmanship component:

```
┌──────────────────────────────────────────────────────────────────┐
│                  LINKEDIN INTERVIEW PIPELINE                     │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application/Referral                                            │
│       │                                                          │
│       ▼                                                          │
│  Recruiter Screen (30 min)                                       │
│       │  - Experience, motivation, LinkedIn mission alignment    │
│       ▼                                                          │
│  Technical Phone Screen (60 min)                                 │
│       │  - 1-2 coding problems (data structures / graphs)        │
│       ▼                                                          │
│  Virtual Onsite (5 rounds, 45-60 min each)                       │
│       │  - 2 Coding rounds (algorithms + data structures)        │
│       │  - 1 System Design round                                 │
│       │  - 1 Architecture/Distributed Systems round              │
│       │  - 1 Behavioral/Leadership round                         │
│       ▼                                                          │
│  Hiring Committee Review                                         │
│  Timeline: 3-5 weeks                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

LinkedIn's coding rounds frequently feature graph problems (BFS/DFS on social networks), sliding window algorithms for feed ranking, and string/search problems. The Architecture round is distinctly about distributed systems: partitioning strategies, eventual consistency, and latency budgets - not product features. Behavioral questions closely mirror Microsoft's Growth Mindset framework.

### Level Expectations

| Level | Title | Years | Base Salary | Total Comp (TC) | Interview Focus |
|-------|-------|-------|-------------|-----------------|-----------------|
| SWE II | Software Engineer | 0-3 | $155K-$190K | $220K-$340K | Coding + basic system design |
| SWE III | Senior Engineer | 3-6 | $195K-$240K | $340K-$500K | Full system + graph algorithms |
| Staff SWE | Staff Engineer | 6-10 | $240K-$300K | $500K-$700K | Architecture + technical leadership |
| Principal | Principal Engineer | 10-15 | $290K-$360K | $700K-$950K | Cross-org systems + strategy |
| Distinguished | Distinguished Engineer | 15+ | $350K-$430K | $900K-$1.3M+ | Industry-level technical vision |

### Representative Interview Problems

#### Problem 1: Degrees of Separation (Easy)

*Find the shortest connection path between two LinkedIn members using BFS on the social graph.*

```go
package main

import "fmt"

// BFS to find shortest path between two members in a social graph.
func DegreesOfSeparation(graph map[string][]string, from, to string) (int, []string) {
	if from == to {
		return 0, []string{from}
	}

	visited := map[string]bool{from: true}
	prev := map[string]string{}
	queue := []string{from}

	for len(queue) > 0 {
		curr := queue[0]
		queue = queue[1:]

		for _, neighbor := range graph[curr] {
			if visited[neighbor] {
				continue
			}
			visited[neighbor] = true
			prev[neighbor] = curr

			if neighbor == to {
				// Reconstruct path
				path := []string{to}
				for n := to; n != from; n = prev[n] {
					path = append([]string{prev[n]}, path...)
				}
				return len(path) - 1, path
			}
			queue = append(queue, neighbor)
		}
	}
	return -1, nil // not connected
}

func main() {
	graph := map[string][]string{
		"Alice": {"Bob", "Carol"},
		"Bob":   {"Alice", "Dave", "Eve"},
		"Carol": {"Alice", "Frank"},
		"Dave":  {"Bob"},
		"Eve":   {"Bob", "Grace"},
		"Frank": {"Carol", "Grace"},
		"Grace": {"Eve", "Frank"},
	}

	pairs := [][2]string{{"Alice", "Grace"}, {"Alice", "Dave"}, {"Alice", "Alice"}}
	for _, p := range pairs {
		deg, path := DegreesOfSeparation(graph, p[0], p[1])
		fmt.Printf("%s → %s: %d degrees, path=%v\n", p[0], p[1], deg, path)
	}
}
```

#### Problem 2: People You May Know (Easy)

*Suggest connections by finding mutual friends - common neighbors in the social graph.*

```go
package main

import (
	"fmt"
	"slices"
)

type Suggestion struct {
	Member  string
	Mutuals int
}

// PeopleYouMayKnow returns non-connected members sorted by mutual connection count.
func PeopleYouMayKnow(graph map[string][]string, member string, topK int) []Suggestion {
	connections := make(map[string]bool)
	for _, c := range graph[member] {
		connections[c] = true
	}
	connections[member] = true // exclude self

	mutualCount := make(map[string]int)
	for _, direct := range graph[member] {
		for _, secondDeg := range graph[direct] {
			if !connections[secondDeg] {
				mutualCount[secondDeg]++
			}
		}
	}

	suggestions := make([]Suggestion, 0, len(mutualCount))
	for m, count := range mutualCount {
		suggestions = append(suggestions, Suggestion{m, count})
	}

	slices.SortFunc(suggestions, func(a, b Suggestion) int {
		if b.Mutuals != a.Mutuals {
			return b.Mutuals - a.Mutuals
		}
		if a.Member < b.Member {
			return -1
		}
		return 1
	})

	return suggestions[:min(topK, len(suggestions))]
}

func main() {
	graph := map[string][]string{
		"Alice": {"Bob", "Carol", "Dave"},
		"Bob":   {"Alice", "Eve", "Frank"},
		"Carol": {"Alice", "Eve", "Grace"},
		"Dave":  {"Alice", "Grace", "Henry"},
		"Eve":   {"Bob", "Carol"},
		"Frank": {"Bob"},
		"Grace": {"Carol", "Dave"},
		"Henry": {"Dave"},
	}

	suggestions := PeopleYouMayKnow(graph, "Alice", 5)
	fmt.Println("People Alice may know:")
	for _, s := range suggestions {
		fmt.Printf("  %s (%d mutual connections)\n", s.Member, s.Mutuals)
	}
}
```

#### Problem 3: Feed Post Ranking (Easy)

*Rank feed posts using a weighted scoring formula incorporating recency, engagement, and connection strength.*

```go
package main

import (
	"fmt"
	"math"
	"slices"
	"time"
)

type Post struct {
	ID               string
	AuthorID         string
	CreatedAt        time.Time
	Likes            int
	Comments         int
	Shares           int
	ConnectionDegree int // 1=direct, 2=2nd degree, 3=3rd+
}

// FeedScore computes a ranking score for a post.
// Higher = show earlier in feed.
func FeedScore(p Post, viewerID string) float64 {
	// Recency decay: half-life of 6 hours
	ageHours := time.Since(p.CreatedAt).Hours()
	recency := math.Exp(-0.693 * ageHours / 6)

	// Engagement signal
	engagement := float64(p.Likes) + float64(p.Comments)*3 + float64(p.Shares)*5

	// Connection strength multiplier
	connectionWeight := map[int]float64{1: 1.0, 2: 0.6, 3: 0.3}
	connMult := connectionWeight[p.ConnectionDegree]
	if connMult == 0 {
		connMult = 0.1
	}

	return recency * (1 + math.Log1p(engagement)) * connMult
}

func RankFeed(posts []Post, viewerID string) []Post {
	ranked := make([]Post, len(posts))
	copy(ranked, posts)
	slices.SortFunc(ranked, func(a, b Post) int {
		sa, sb := FeedScore(a, viewerID), FeedScore(b, viewerID)
		if sa > sb {
			return -1
		} else if sa < sb {
			return 1
		}
		return 0
	})
	return ranked
}

func main() {
	now := time.Now()
	posts := []Post{
		{ID: "p1", CreatedAt: now.Add(-1 * time.Hour), Likes: 5, Comments: 2, ConnectionDegree: 1},
		{ID: "p2", CreatedAt: now.Add(-12 * time.Hour), Likes: 500, Comments: 80, Shares: 30, ConnectionDegree: 2},
		{ID: "p3", CreatedAt: now.Add(-30 * time.Minute), Likes: 2, Comments: 0, ConnectionDegree: 1},
		{ID: "p4", CreatedAt: now.Add(-2 * time.Hour), Likes: 50, Comments: 10, ConnectionDegree: 1},
	}

	ranked := RankFeed(posts, "viewer1")
	fmt.Println("Feed ranking:")
	for i, p := range ranked {
		fmt.Printf("  #%d %s (score=%.3f)\n", i+1, p.ID, FeedScore(p, "viewer1"))
	}
}
```

#### Problem 4: Job Recommendation Engine (Medium)

*Score job listings for a member based on skill match, location preference, and seniority alignment.*

```go
package main

import (
	"fmt"
	"slices"
	"strings"
)

type MemberProfile struct {
	ID          string
	Skills      []string
	Location    string
	YearsExp    int
	DesiredRoles []string
}

type JobListing struct {
	ID           string
	Title        string
	Location     string
	RequiredSkills []string
	YearsExpMin  int
	YearsExpMax  int
	Remote       bool
}

type JobScore struct {
	Job   JobListing
	Score float64
}

func ScoreJob(member MemberProfile, job JobListing) float64 {
	score := 0.0

	// Skill match (40% weight)
	skillSet := make(map[string]bool)
	for _, s := range member.Skills {
		skillSet[strings.ToLower(s)] = true
	}
	matched := 0
	for _, req := range job.RequiredSkills {
		if skillSet[strings.ToLower(req)] {
			matched++
		}
	}
	if len(job.RequiredSkills) > 0 {
		score += 0.40 * float64(matched) / float64(len(job.RequiredSkills))
	}

	// Location match (30% weight)
	if job.Remote || strings.EqualFold(member.Location, job.Location) {
		score += 0.30
	}

	// Experience alignment (30% weight)
	if member.YearsExp >= job.YearsExpMin && member.YearsExp <= job.YearsExpMax {
		score += 0.30
	} else if member.YearsExp < job.YearsExpMin {
		// slightly under-qualified
		gap := float64(job.YearsExpMin - member.YearsExp)
		score += 0.30 * max(0, 1-gap*0.15)
	}

	return score
}

func RecommendJobs(member MemberProfile, jobs []JobListing, topK int) []JobScore {
	scored := make([]JobScore, len(jobs))
	for i, j := range jobs {
		scored[i] = JobScore{j, ScoreJob(member, j)}
	}
	slices.SortFunc(scored, func(a, b JobScore) int {
		if a.Score > b.Score {
			return -1
		} else if a.Score < b.Score {
			return 1
		}
		return 0
	})
	return scored[:min(topK, len(scored))]
}

func main() {
	member := MemberProfile{
		Skills:   []string{"Go", "Kubernetes", "gRPC", "PostgreSQL"},
		Location: "San Francisco",
		YearsExp: 5,
	}

	jobs := []JobListing{
		{ID: "j1", Title: "Senior Go Engineer", Location: "San Francisco", RequiredSkills: []string{"Go", "Kubernetes", "gRPC"}, YearsExpMin: 4, YearsExpMax: 8},
		{ID: "j2", Title: "Backend Engineer", Location: "New York", RequiredSkills: []string{"Go", "PostgreSQL"}, YearsExpMin: 3, YearsExpMax: 7, Remote: true},
		{ID: "j3", Title: "Staff Engineer", Location: "San Francisco", RequiredSkills: []string{"Go", "Kafka", "gRPC", "Kubernetes"}, YearsExpMin: 8, YearsExpMax: 15},
		{ID: "j4", Title: "Python Engineer", Location: "Austin", RequiredSkills: []string{"Python", "Django", "Redis"}, YearsExpMin: 2, YearsExpMax: 6},
	}

	recs := RecommendJobs(member, jobs, 3)
	fmt.Println("Top job recommendations:")
	for i, r := range recs {
		fmt.Printf("  #%d %s - score=%.2f\n", i+1, r.Job.Title, r.Score)
	}
}
```

#### Problem 5: Viral Post Detection - K-Core Decomposition (Medium)

*Identify highly connected "influencer clusters" in a network using k-core decomposition - who drives viral content spread.*

```go
package main

import "fmt"

// KCore returns the coreness of each node - the max k such that the node
// belongs to a subgraph where every node has degree >= k.
func KCore(graph map[int][]int) map[int]int {
	degree := make(map[int]int)
	adj := make(map[int]map[int]bool)

	for node, neighbors := range graph {
		adj[node] = make(map[int]bool)
		for _, nb := range neighbors {
			adj[node][nb] = true
		}
		degree[node] = len(neighbors)
	}

	coreness := make(map[int]int)
	// Process nodes in order of degree (peeling algorithm)
	k := 1
	for len(degree) > 0 {
		changed := true
		for changed {
			changed = false
			for node, deg := range degree {
				if deg < k {
					coreness[node] = k - 1
					delete(degree, node)
					// Reduce neighbors' degrees
					for nb := range adj[node] {
						if _, alive := degree[nb]; alive {
							degree[nb]--
						}
						delete(adj[nb], node)
					}
					changed = true
				}
			}
		}
		if len(degree) > 0 {
			k++
		}
	}
	// Remaining nodes have coreness k
	for node := range degree {
		coreness[node] = k
	}
	return coreness
}

func main() {
	// LinkedIn member graph
	graph := map[int][]int{
		1: {2, 3, 4},
		2: {1, 3, 4, 5},
		3: {1, 2, 4},
		4: {1, 2, 3, 5},
		5: {2, 4, 6},
		6: {5, 7},
		7: {6},
	}

	coreness := KCore(graph)
	fmt.Println("Node coreness (higher = more central/influential):")
	for node, core := range coreness {
		role := "peripheral"
		if core >= 3 {
			role = "influencer cluster"
		} else if core == 2 {
			role = "bridge"
		}
		fmt.Printf("  Member %d: k-core=%d (%s)\n", node, core, role)
	}
}
```

#### Problem 6: LinkedIn Search - Ranked Member Results (Medium)

*Implement a search index with TF-IDF-style ranking for member profiles.*

```go
package main

import (
	"fmt"
	"math"
	"slices"
	"strings"
)

type Profile struct {
	ID       string
	Name     string
	Headline string
	Skills   []string
}

type SearchIndex struct {
	profiles []Profile
	termFreq map[string]map[string]float64 // term → profileID → tf
	docFreq  map[string]int                 // term → # profiles containing term
}

func NewSearchIndex() *SearchIndex {
	return &SearchIndex{
		termFreq: make(map[string]map[string]float64),
		docFreq:  make(map[string]int),
	}
}

func tokenize(text string) []string {
	return strings.Fields(strings.ToLower(text))
}

func (si *SearchIndex) Add(p Profile) {
	si.profiles = append(si.profiles, p)

	text := p.Name + " " + p.Headline + " " + strings.Join(p.Skills, " ")
	tokens := tokenize(text)
	tf := make(map[string]int)
	for _, t := range tokens {
		tf[t]++
	}
	seen := make(map[string]bool)
	for term, count := range tf {
		if si.termFreq[term] == nil {
			si.termFreq[term] = make(map[string]float64)
		}
		si.termFreq[term][p.ID] = float64(count) / float64(len(tokens))
		if !seen[term] {
			si.docFreq[term]++
			seen[term] = true
		}
	}
}

func (si *SearchIndex) Search(query string, topK int) []Profile {
	N := float64(len(si.profiles))
	scores := make(map[string]float64)

	for _, term := range tokenize(query) {
		idf := math.Log(N / float64(si.docFreq[term]+1))
		for profileID, tf := range si.termFreq[term] {
			scores[profileID] += tf * idf
		}
	}

	type result struct {
		profile Profile
		score   float64
	}
	var results []result
	for _, p := range si.profiles {
		if s := scores[p.ID]; s > 0 {
			results = append(results, result{p, s})
		}
	}
	slices.SortFunc(results, func(a, b result) int {
		if a.score > b.score {
			return -1
		}
		return 1
	})
	out := make([]Profile, 0, min(topK, len(results)))
	for _, r := range results[:min(topK, len(results))] {
		out = append(out, r.profile)
	}
	return out
}

func main() {
	idx := NewSearchIndex()
	idx.Add(Profile{ID: "1", Name: "Alice Chen", Headline: "Senior Go Engineer at Google", Skills: []string{"Go", "Kubernetes", "gRPC"}})
	idx.Add(Profile{ID: "2", Name: "Bob Singh", Headline: "Staff Engineer distributed systems", Skills: []string{"Go", "Kafka", "distributed systems"}})
	idx.Add(Profile{ID: "3", Name: "Carol Lee", Headline: "Python backend engineer", Skills: []string{"Python", "Django"}})
	idx.Add(Profile{ID: "4", Name: "Dave Wu", Headline: "Go engineer infrastructure Kubernetes", Skills: []string{"Go", "Kubernetes", "Terraform"}})

	results := idx.Search("go engineer kubernetes", 3)
	fmt.Println("Search results for 'go engineer kubernetes':")
	for i, p := range results {
		fmt.Printf("  #%d %s - %s\n", i+1, p.Name, p.Headline)
	}
}
```

#### Problem 7: Connection Invitation Spam Filter (Medium)

*Detect and filter spam invitation campaigns using frequency analysis and behavioral signals.*

```go
package main

import (
	"fmt"
	"time"
)

type InviteEvent struct {
	SenderID    string
	ReceiverID  string
	SentAt      time.Time
	MessageLen  int
	HasPersonal bool // personalized message?
}

type SpamDecision struct {
	IsSpam   bool
	Reason   string
	Score    int
}

type SpamFilter struct {
	recentByUser map[string][]InviteEvent
	windowDur    time.Duration
	rateLimit    int // max invites per window
}

func NewSpamFilter(windowDur time.Duration, rateLimit int) *SpamFilter {
	return &SpamFilter{
		recentByUser: make(map[string][]InviteEvent),
		windowDur:    windowDur,
		rateLimit:    rateLimit,
	}
}

func (sf *SpamFilter) Evaluate(ev InviteEvent) SpamDecision {
	now := ev.SentAt
	cutoff := now.Add(-sf.windowDur)

	// Evict old events
	recent := sf.recentByUser[ev.SenderID]
	start := 0
	for start < len(recent) && recent[start].SentAt.Before(cutoff) {
		start++
	}
	recent = recent[start:]
	recent = append(recent, ev)
	sf.recentByUser[ev.SenderID] = recent

	score := 0

	// Rule 1: High volume
	if len(recent) > sf.rateLimit {
		score += 50
	}

	// Rule 2: Short/empty messages (bulk invites)
	if ev.MessageLen < 10 {
		score += 20
	}

	// Rule 3: No personalization in high-volume sender
	if !ev.HasPersonal && len(recent) > sf.rateLimit/2 {
		score += 20
	}

	// Rule 4: Extremely high rate
	if len(recent) > sf.rateLimit*3 {
		score += 40
	}

	reason := "ok"
	if score >= 50 {
		reason = fmt.Sprintf("spam signals: rate=%d/%v, msgLen=%d, personal=%v",
			len(recent), sf.windowDur, ev.MessageLen, ev.HasPersonal)
	}

	return SpamDecision{IsSpam: score >= 50, Reason: reason, Score: score}
}

func main() {
	filter := NewSpamFilter(24*time.Hour, 20)
	now := time.Now()

	// Legitimate user - 3 personalized invites
	for i := range 3 {
		ev := InviteEvent{SenderID: "legit1", SentAt: now.Add(time.Duration(i) * time.Minute), MessageLen: 80, HasPersonal: true}
		d := filter.Evaluate(ev)
		fmt.Printf("legit1 invite %d: spam=%v score=%d\n", i+1, d.IsSpam, d.Score)
	}

	// Spammer - 25 blank invites
	fmt.Println()
	for i := range 25 {
		ev := InviteEvent{SenderID: "spammer1", SentAt: now.Add(time.Duration(i) * time.Minute), MessageLen: 0}
		d := filter.Evaluate(ev)
		if i == 0 || i == 19 || i == 24 {
			fmt.Printf("spammer1 invite %d: spam=%v score=%d reason=%s\n", i+1, d.IsSpam, d.Score, d.Reason)
		}
	}
}
```

#### Problem 8: Trending Topics using Count-Min Sketch (Hard)

*Identify trending topics from a high-volume stream of posts using a Count-Min Sketch (memory-efficient frequency estimation).*

```go
package main

import (
	"fmt"
	"hash/fnv"
	"slices"
)

// CountMinSketch is a probabilistic data structure for frequency estimation.
type CountMinSketch struct {
	table  [][]uint32
	width  int
	depth  int
	hashes int
}

func NewCountMinSketch(width, depth int) *CountMinSketch {
	table := make([][]uint32, depth)
	for i := range table {
		table[i] = make([]uint32, width)
	}
	return &CountMinSketch{table: table, width: width, depth: depth, hashes: depth}
}

func (cms *CountMinSketch) hash(item string, seed int) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(fmt.Sprintf("%d:%s", seed, item)))
	return int(h.Sum32()) % cms.width
}

func (cms *CountMinSketch) Add(item string) {
	for i := range cms.depth {
		cms.table[i][cms.hash(item, i)]++
	}
}

func (cms *CountMinSketch) Estimate(item string) uint32 {
	var min uint32 = ^uint32(0)
	for i := range cms.depth {
		v := cms.table[i][cms.hash(item, i)]
		if v < min {
			min = v
		}
	}
	return min
}

type TopicCount struct {
	Topic string
	Count uint32
}

func TrendingTopics(stream []string, topK int) []TopicCount {
	cms := NewCountMinSketch(1024, 5)
	seen := make(map[string]bool)

	for _, topic := range stream {
		cms.Add(topic)
		seen[topic] = true
	}

	topics := make([]TopicCount, 0, len(seen))
	for t := range seen {
		topics = append(topics, TopicCount{t, cms.Estimate(t)})
	}
	slices.SortFunc(topics, func(a, b TopicCount) int {
		if a.Count > b.Count {
			return -1
		} else if a.Count < b.Count {
			return 1
		}
		return 0
	})
	return topics[:min(topK, len(topics))]
}

func main() {
	// Simulate post tags stream
	stream := []string{
		"AI", "Go", "AI", "Kubernetes", "AI", "Go", "AI",
		"leadership", "AI", "Go", "Kubernetes", "career",
		"AI", "career", "leadership", "Go", "AI", "AI",
	}

	trending := TrendingTopics(stream, 5)
	fmt.Println("Trending topics:")
	for i, t := range trending {
		fmt.Printf("  #%d %s - ~%d mentions\n", i+1, t.Topic, t.Count)
	}
}
```

#### Problem 9: Member Graph Partitioning for Distributed Storage (Hard)

*Partition a social graph across database shards to minimize cross-shard edges (co-locate connected members).*

```go
package main

import "fmt"

// GraphPartitioner assigns members to shards using a greedy approach:
// assign each member to the shard containing the most of their connections.
type GraphPartitioner struct {
	shards     int
	assignment map[string]int
	shardSizes map[int]int
	maxPerShard int
}

func NewGraphPartitioner(shards, maxPerShard int) *GraphPartitioner {
	return &GraphPartitioner{
		shards:      shards,
		assignment:  make(map[string]int),
		shardSizes:  make(map[int]int),
		maxPerShard: maxPerShard,
	}
}

func (gp *GraphPartitioner) Assign(member string, connections []string) int {
	if shard, ok := gp.assignment[member]; ok {
		return shard
	}

	// Count how many connections are already in each shard
	shardScore := make(map[int]int)
	for _, c := range connections {
		if shard, ok := gp.assignment[c]; ok {
			shardScore[shard]++
		}
	}

	// Pick shard with most connections that isn't full
	best, bestScore := 0, -1
	for s := range gp.shards {
		if gp.shardSizes[s] >= gp.maxPerShard {
			continue
		}
		if shardScore[s] > bestScore {
			best, bestScore = s, shardScore[s]
		}
	}

	gp.assignment[member] = best
	gp.shardSizes[best]++
	return best
}

func CrossShardEdges(graph map[string][]string, assignment map[string]int) int {
	count := 0
	for member, neighbors := range graph {
		for _, nb := range neighbors {
			if assignment[member] != assignment[nb] {
				count++
			}
		}
	}
	return count / 2 // each edge counted twice
}

func main() {
	graph := map[string][]string{
		"A": {"B", "C", "D"},
		"B": {"A", "C"},
		"C": {"A", "B", "E"},
		"D": {"A", "F"},
		"E": {"C", "F"},
		"F": {"D", "E"},
	}

	partitioner := NewGraphPartitioner(2, 3) // 2 shards, max 3 members each

	// Assign in order
	order := []string{"A", "B", "C", "D", "E", "F"}
	for _, m := range order {
		shard := partitioner.Assign(m, graph[m])
		fmt.Printf("Member %s → Shard %d\n", m, shard)
	}

	crossEdges := CrossShardEdges(graph, partitioner.assignment)
	fmt.Printf("\nCross-shard edges: %d out of %d total\n", crossEdges, 6)
}
```

#### Problem 10: Feed Write Fanout with Backpressure (Hard)

*Implement a fan-out system for feed updates that handles high-follower accounts with backpressure to prevent pipeline overload.*

```go
package main

import (
	"fmt"
	"sync"
	"sync/atomic"
)

type FeedUpdate struct {
	PostID   string
	AuthorID string
}

type FanoutWorker struct {
	id       int
	queue    chan FeedUpdate
	processed atomic.Int64
}

func (w *FanoutWorker) Start(wg *sync.WaitGroup) {
	wg.Add(1)
	go func() {
		defer wg.Done()
		for update := range w.queue {
			// Simulate writing to follower's feed store
			_ = update
			w.processed.Add(1)
		}
	}()
}

type FanoutService struct {
	workers    []*FanoutWorker
	workerCount int
}

func NewFanoutService(workerCount, queueSize int) *FanoutService {
	workers := make([]*FanoutWorker, workerCount)
	for i := range workers {
		workers[i] = &FanoutWorker{
			id:    i,
			queue: make(chan FeedUpdate, queueSize),
		}
	}
	return &FanoutService{workers: workers, workerCount: workerCount}
}

func (fs *FanoutService) Start(wg *sync.WaitGroup) {
	for _, w := range fs.workers {
		w.Start(wg)
	}
}

func (fs *FanoutService) Stop() {
	for _, w := range fs.workers {
		close(w.queue)
	}
}

// Fanout distributes an update to all followers' feed workers.
// Uses modulo sharding on followerID to pick worker (same follower → same worker → ordered delivery).
// Returns number of followers that could NOT be enqueued (backpressure applied).
func (fs *FanoutService) Fanout(update FeedUpdate, followers []string) int {
	dropped := 0
	for i, follower := range followers {
		workerIdx := i % fs.workerCount
		select {
		case fs.workers[workerIdx].queue <- update:
		default:
			// Queue full - apply backpressure: drop or queue to DLQ in production
			dropped++
			_ = follower
		}
	}
	return dropped
}

func (fs *FanoutService) TotalProcessed() int64 {
	var total int64
	for _, w := range fs.workers {
		total += w.processed.Load()
	}
	return total
}

func main() {
	var wg sync.WaitGroup
	svc := NewFanoutService(4, 100)
	svc.Start(&wg)

	// Celebrity post with 1000 followers
	followers := make([]string, 1000)
	for i := range followers {
		followers[i] = fmt.Sprintf("user_%d", i)
	}

	update := FeedUpdate{PostID: "post_viral_123", AuthorID: "celebrity_1"}
	dropped := svc.Fanout(update, followers)
	fmt.Printf("Fanout to %d followers: dropped=%d (backpressure)\n", len(followers), dropped)

	svc.Stop()
	wg.Wait()
	fmt.Printf("Total feed writes processed: %d\n", svc.TotalProcessed())
}
```

---

### System Design Topics

**Top 5 LinkedIn System Design Questions:**

1. **Design LinkedIn's News Feed** - Personalized feed for 1 billion members with mix of connections, sponsored content, and algorithmic posts. Topics: push vs. pull fan-out models, hybrid approach for celebrities, feed assembly service, ranking pipeline, A/B experimentation.

2. **Design "People You May Know"** - Generate connection suggestions in real time. Topics: graph processing (Spark/Flink), 2nd-degree neighbor computation, feature engineering (school, company, location), batch vs. real-time generation, personalization.

3. **Design LinkedIn Search** - Search across 1B+ profiles, 15M+ jobs, and content. Topics: Elasticsearch/Lucene, inverted index, real-time vs. batch indexing, personalized ranking, query understanding (NLP), distributed retrieval.

4. **Design LinkedIn Messaging** - Real-time 1:1 and group messaging with read receipts, typing indicators, and message history. Topics: WebSocket vs. long polling, message ordering, presence service, storage partitioning by sender, offline delivery.

5. **Design Job Recommendation System** - Match 900M members to 15M+ active jobs. Topics: two-tower neural models, candidate retrieval (ANN search), ranking pipeline, click/apply feedback loops, explainability ("Why was this job recommended?").

---

### Behavioral Focus

LinkedIn's culture emphasizes **"Members First," "Relationships Matter,"** and professional growth. Behavioral themes mirror Microsoft's Growth Mindset:

- **Transformation:** "Tell me about a time you fundamentally changed the way a team worked."
- **Relationships:** "Describe a complex stakeholder relationship you navigated to achieve a technical goal."
- **Data-driven impact:** "How have you used data to change a product decision or technical direction?"
- **Inclusion:** "Tell me about a time you brought a diverse set of perspectives into a technical decision."
- **Career development:** "How do you invest in the growth of engineers around you?"

LinkedIn specifically values answers that tie engineering decisions back to member value and professional growth - the company's core mission.

---

### Insider Tips

**Common Mistakes:**
- Graph problems: using DFS when BFS is needed for shortest path, or forgetting to handle disconnected components.
- Feed design: designing pure push (fan-out on write) without accounting for celebrity problem - accounts with 100M+ followers need pull or hybrid.
- Search design: treating search as a simple keyword match rather than a ranking problem with multiple signals.
- Behavioral: giving generic "I built a system" stories instead of showing impact on people (fitting for LinkedIn's mission).

**Strong Hire Signals:**
- Mentioning graph algorithm complexity trade-offs (DFS vs. BFS vs. bidirectional BFS for LinkedIn graph scale).
- Hybrid fan-out model in feed design without prompting.
- Discussing cache warming strategies for cold-start members.
- Count-Min Sketch or HyperLogLog for trending/popularity at scale.

**Red Flags:**
- O(V²) or O(V³) graph algorithms on billion-node graphs.
- Full graph traversal for connection suggestions (should use pre-computed 2nd-degree neighborhoods).
- Not discussing eventual consistency in feed reads.

---

### 8-Week Preparation Timeline

```
Week 1: Graph Algorithms Foundations
  Mon-Tue: BFS/DFS, connected components, shortest path (Dijkstra, Bellman-Ford)
  Wed-Thu: 2-degree graph expansion, cycle detection, topological sort
  Fri:     Bidirectional BFS for large graphs
  Weekend: Implement "degrees of separation" and "PYMK" from scratch

Week 2: Ranking & Recommendation Systems
  Mon-Tue: TF-IDF, BM25, collaborative filtering concepts
  Wed-Thu: Feed scoring algorithms, recency decay, engagement signals
  Fri:     Two-tower recommendation model concepts (no ML impl needed)
  Weekend: Build a ranked feed and job recommendation system

Week 3: Algorithms - Sliding Window & Frequency
  Mon-Fri: 2 problems/day - sliding window, frequency counting, heap
  Weekend: Count-Min Sketch, HyperLogLog implementations

Week 4: System Design - Feed & Graph
  Mon-Tue: Design LinkedIn News Feed (whiteboard)
  Wed-Thu: Design People You May Know
  Fri:     Design LinkedIn Search
  Weekend: Mock system design interview

Week 5: Distributed Systems
  Mon-Tue: Graph partitioning, distributed graph processing
  Wed-Thu: Fan-out patterns, celebrity problem solutions
  Fri:     Message queue patterns, ordering guarantees
  Weekend: Design LinkedIn Messaging system

Week 6: Go Concurrency for Distributed Systems
  Mon-Tue: Worker pools, goroutine pipelines
  Wed-Thu: Rate limiting, backpressure patterns
  Fri:     Atomic operations, lock-free data structures
  Weekend: Build concurrent fan-out pipeline in Go

Week 7: Behavioral Preparation
  Mon-Tue: 5 STAR stories - relationships, data impact, growth, inclusion, transformation
  Wed:     Research LinkedIn's current products and engineering challenges
  Thu:     Mock behavioral interview
  Fri:     Review LinkedIn engineering blog (3-4 posts)
  Weekend: Full mock onsite

Week 8: Final Prep
  Mon-Tue: Review graph algorithm edge cases
  Wed:     Full mock onsite (all rounds)
  Thu:     Rest and logistics
  Fri:     Light review only
```

---


### Junior → FAANG: LinkedIn Interview Preparation Basics

LinkedIn's engineering culture is shaped by its dual-sided marketplace (job seekers and recruiters) and its social graph. System design interviews at LinkedIn often involve graph traversal problems (degrees of connection, feed ranking, search) and data pipeline challenges (member activity events, feed generation). Behavioral interviews emphasize impact and collaboration, similar to other FAANG companies. Know LinkedIn's core products: the social feed, job recommendations, LinkedIn Premium, and Sales Navigator.

### Senior @ FAANG: LinkedIn Senior and Staff: Graph Scale and Ecosystem Engineering

LinkedIn's engineering challenges at the staff level involve one of the largest professional social graphs in existence. Senior candidates should be prepared to discuss graph traversal at billions-of-edge scale, which requires techniques like BFS with hop-count limits, distributed graph storage (LinkedIn uses their open-source Voldemort and later Espresso key-value stores), and approximate graph algorithms for features like 'People You May Know'. The data pipeline scale is also significant: LinkedIn processes billions of member activity events per day for feed ranking and recommendation models. Staff candidates should demonstrate understanding of the streaming versus batch trade-off for these pipelines and the operational challenges of maintaining SLOs on pipeline latency when upstream data volume spikes.

---
