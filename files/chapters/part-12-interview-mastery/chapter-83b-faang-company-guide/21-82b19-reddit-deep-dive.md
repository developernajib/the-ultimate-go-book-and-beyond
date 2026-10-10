## 83B.19 Reddit Deep Dive

### Overview for Go Engineers

Reddit is "the front page of the internet" - a link aggregation and discussion platform with 1.2 billion monthly users across 100,000+ communities (subreddits). Go is a major language at Reddit, used in their feed serving infrastructure, voting systems, notification pipelines, and the media platform backend. Reddit's engineering challenges are centered on ranking and voting: their post ranking algorithms (Hot, Best, Top, New, Rising, Controversial) are the product. A post that ranks well surfaces to millions of users. A post that ranks poorly disappears. Other core challenges include comment tree rendering (nested threaded discussions), vote aggregation at high write throughput, and spam/bot detection. Reddit's interview process is more collaborative and less rigorous than FAANG - they value engineers who understand product tradeoffs, can discuss their ranking systems intelligently, and can build maintainable backend services. Go engineers work on the infrastructure that powers all of this, and knowledge of Reddit's actual ranking formulas (Hot score uses Wilson score for confidence intervals) is genuine preparation.

### Interview Process

Reddit's loop balances product sense with backend scale problems drawn from its own feed and voting systems:

```
┌──────────────────────────────────────────────────────────────────┐
│                   REDDIT INTERVIEW PIPELINE                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application/Referral                                            │
│       │                                                          │
│       ▼                                                          │
│  Recruiter Screen (30 min)                                       │
│       │                                                          │
│       ▼                                                          │
│  Technical Phone Screen (60 min)                                 │
│       │  - 1-2 coding problems (moderate difficulty)             │
│       ▼                                                          │
│  Virtual Onsite (4 rounds, 60 min each)                          │
│       │  - 2 Coding rounds                                       │
│       │  - 1 System Design round                                 │
│       │  - 1 Behavioral/Culture round                            │
│       ▼                                                          │
│  Offer                                                           │
│  Timeline: 2-4 weeks                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

Reddit's interviews are more relaxed than FAANG but still technically demanding. The system design round almost always involves feed ranking, voting systems, or content moderation - the core of what makes Reddit work. Demonstrating knowledge of Wilson score confidence intervals (Reddit's "Best" ranking formula) will immediately impress interviewers. The behavioral round focuses heavily on how you handle ambiguity and how you approach product decisions.

### Level Expectations

| Level | Title | Years | Base Salary | Total Comp (TC) | Interview Focus |
|-------|-------|-------|-------------|-----------------|-----------------|
| L3 | Software Engineer | 0-3 | $140K-$175K | $195K-$310K | Coding + ranking basics |
| L4 | Senior Engineer | 3-7 | $180K-$225K | $310K-$460K | System design + ranking systems |
| L5 | Staff Engineer | 7-12 | $225K-$285K | $460K-$640K | Architecture + platform scope |
| L6 | Principal Engineer | 12+ | $275K-$360K | $640K-$900K | Technical strategy |

### Representative Interview Problems

#### Problem 1: Reddit Hot Score (Easy)

*Implement Reddit's Hot ranking algorithm - balancing upvotes, downvotes, and post age.*

```go
package main

import (
	"fmt"
	"math"
	"time"
)

// RedditHotScore computes Reddit's "Hot" score.
// Based on Randall Munroe's algorithm: uses log10 of score + time decay.
// Source: github.com/reddit-archive/reddit/blob/master/r2/r2/lib/db/_sorts.pyx
func RedditHotScore(ups, downs int, created time.Time) float64 {
	score := ups - downs
	order := math.Log10(math.Max(math.Abs(float64(score)), 1))

	sign := 0.0
	switch {
	case score > 0:
		sign = 1
	case score < 0:
		sign = -1
	}

	// Seconds since Reddit's epoch (Dec 8, 2005)
	epoch := time.Date(2005, 12, 8, 7, 46, 43, 0, time.UTC)
	seconds := created.Sub(epoch).Seconds()

	return sign*order + seconds/45000
}

type Post struct {
	ID      string
	Title   string
	Ups     int
	Downs   int
	Created time.Time
}

func (p Post) HotScore() float64 {
	return RedditHotScore(p.Ups, p.Downs, p.Created)
}

func main() {
	now := time.Now()
	posts := []Post{
		{ID: "p1", Title: "Old viral post", Ups: 50000, Downs: 1000, Created: now.Add(-48 * time.Hour)},
		{ID: "p2", Title: "Recent popular post", Ups: 5000, Downs: 200, Created: now.Add(-2 * time.Hour)},
		{ID: "p3", Title: "Brand new post", Ups: 100, Downs: 5, Created: now.Add(-10 * time.Minute)},
		{ID: "p4", Title: "Controversial post", Ups: 2000, Downs: 1800, Created: now.Add(-1 * time.Hour)},
	}

	fmt.Println("Hot scores:")
	for _, p := range posts {
		fmt.Printf("  %-30s ups=%5d downs=%4d hot=%.2f\n", p.Title, p.Ups, p.Downs, p.HotScore())
	}
}
```

#### Problem 2: Wilson Score - Best Comment Ranking (Easy)

*Implement the Wilson score lower bound - Reddit's algorithm for ranking comments by confidence, not raw upvotes.*

```go
package main

import (
	"fmt"
	"math"
	"slices"
)

// WilsonScoreLowerBound computes the lower bound of a Wilson score confidence interval.
// This ranks items by the lower confidence bound of their upvote proportion.
// z = 1.96 for 95% confidence interval.
func WilsonScoreLowerBound(ups, total int, z float64) float64 {
	if total == 0 {
		return 0
	}
	n := float64(total)
	phat := float64(ups) / n
	z2 := z * z

	numerator := phat + z2/(2*n) - z*math.Sqrt((phat*(1-phat)+z2/(4*n))/n)
	denominator := 1 + z2/n
	return numerator / denominator
}

type Comment struct {
	ID   string
	Text string
	Ups  int
	Down int
}

func (c Comment) WilsonScore() float64 {
	return WilsonScoreLowerBound(c.Ups, c.Ups+c.Down, 1.96)
}

func RankComments(comments []Comment) []Comment {
	ranked := make([]Comment, len(comments))
	copy(ranked, comments)
	slices.SortFunc(ranked, func(a, b Comment) int {
		sa, sb := a.WilsonScore(), b.WilsonScore()
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
	comments := []Comment{
		{ID: "c1", Text: "Insightful comment with few votes", Ups: 8, Down: 1},
		{ID: "c2", Text: "Viral comment, some disagree", Ups: 1000, Down: 200},
		{ID: "c3", Text: "New comment, 1 upvote", Ups: 1, Down: 0},
		{ID: "c4", Text: "Highly rated comment, 95% upvoted", Ups: 950, Down: 50},
		{ID: "c5", Text: "Deeply controversial", Ups: 500, Down: 499},
	}

	ranked := RankComments(comments)
	fmt.Println("Best comment ranking (Wilson score):")
	for i, c := range ranked {
		fmt.Printf("  #%d [%.4f] %s (↑%d ↓%d)\n", i+1, c.WilsonScore(), c.Text, c.Ups, c.Down)
	}
}
```

#### Problem 3: Post Vote Aggregator (Easy)

*Aggregate votes on posts with vote deduplication - a user can only have one active vote per post.*

```go
package main

import (
	"fmt"
	"sync"
)

type Vote struct {
	UserID string
	PostID string
	Dir    int // +1 upvote, -1 downvote, 0 unvote
}

type VoteStore struct {
	mu    sync.Mutex
	votes map[string]map[string]int // postID → userID → direction
}

func NewVoteStore() *VoteStore {
	return &VoteStore{votes: make(map[string]map[string]int)}
}

func (vs *VoteStore) Cast(v Vote) (deltaUps, deltaDowns int) {
	vs.mu.Lock()
	defer vs.mu.Unlock()

	if vs.votes[v.PostID] == nil {
		vs.votes[v.PostID] = make(map[string]int)
	}

	prev := vs.votes[v.PostID][v.UserID]
	vs.votes[v.PostID][v.UserID] = v.Dir

	// Calculate deltas
	if prev == 1 && v.Dir != 1 {
		deltaUps = -1
	} else if prev != 1 && v.Dir == 1 {
		deltaUps = 1
	}
	if prev == -1 && v.Dir != -1 {
		deltaDowns = -1
	} else if prev != -1 && v.Dir == -1 {
		deltaDowns = 1
	}
	return deltaUps, deltaDowns
}

func (vs *VoteStore) Tally(postID string) (ups, downs int) {
	vs.mu.Lock()
	defer vs.mu.Unlock()
	for _, dir := range vs.votes[postID] {
		switch dir {
		case 1:
			ups++
		case -1:
			downs++
		}
	}
	return ups, downs
}

func main() {
	store := NewVoteStore()
	postID := "t3_abc123"

	actions := []Vote{
		{"alice", postID, 1},  // alice upvotes
		{"bob", postID, 1},    // bob upvotes
		{"carol", postID, -1}, // carol downvotes
		{"alice", postID, -1}, // alice changes to downvote
		{"bob", postID, 0},    // bob removes vote
	}

	for _, v := range actions {
		du, dd := store.Cast(v)
		ups, downs := store.Tally(postID)
		fmt.Printf("User %-6s voted %+d | Δups=%+d Δdowns=%+d | tally: ↑%d ↓%d score=%d\n",
			v.UserID, v.Dir, du, dd, ups, downs, ups-downs)
	}
}
```

#### Problem 4: Nested Comment Tree Renderer (Medium)

*Render a nested comment thread (tree) efficiently - supporting Reddit's multi-level nested discussions.*

```go
package main

import (
	"fmt"
	"strings"
)

type CommentNode struct {
	ID       string
	AuthorID string
	Body     string
	Score    int
	Children []*CommentNode
}

// BuildCommentTree assembles flat comment list into a tree structure.
func BuildCommentTree(flat []struct{ ID, ParentID, AuthorID, Body string; Score int }) *CommentNode {
	nodes := make(map[string]*CommentNode)
	root := &CommentNode{ID: "root"}
	nodes["root"] = root
	nodes[""] = root

	// First pass: create all nodes
	for _, c := range flat {
		nodes[c.ID] = &CommentNode{ID: c.ID, AuthorID: c.AuthorID, Body: c.Body, Score: c.Score}
	}

	// Second pass: link parent → child
	for _, c := range flat {
		parent := nodes[c.ParentID]
		if parent == nil {
			parent = root
		}
		parent.Children = append(parent.Children, nodes[c.ID])
	}

	// Sort children by score descending (Reddit's default)
	var sortChildren func(node *CommentNode)
	sortChildren = func(node *CommentNode) {
		for i := 1; i < len(node.Children); i++ {
			for j := i; j > 0 && node.Children[j].Score > node.Children[j-1].Score; j-- {
				node.Children[j], node.Children[j-1] = node.Children[j-1], node.Children[j]
			}
		}
		for _, child := range node.Children {
			sortChildren(child)
		}
	}
	sortChildren(root)
	return root
}

// RenderTree prints the comment tree with indentation.
func RenderTree(node *CommentNode, depth int, maxDepth int) {
	if depth > maxDepth || node == nil {
		return
	}
	if node.ID != "root" {
		indent := strings.Repeat("  ", depth)
		fmt.Printf("%s[%s] u/%s (score=%d): %s\n", indent, node.ID, node.AuthorID, node.Score, node.Body)
	}
	for _, child := range node.Children {
		RenderTree(child, depth+1, maxDepth)
	}
}

func main() {
	comments := []struct{ ID, ParentID, AuthorID, Body string; Score int }{
		{"c1", "", "alice", "Great post!", 150},
		{"c2", "", "bob", "Disagree strongly.", 30},
		{"c3", "c1", "carol", "Agreed, Alice!", 45},
		{"c4", "c1", "dave", "Here's more context...", 80},
		{"c5", "c2", "eve", "Can you explain?", 20},
		{"c6", "c4", "frank", "That's a good point, Dave.", 25},
	}

	tree := BuildCommentTree(comments)
	fmt.Println("Comment tree (sorted by score):")
	RenderTree(tree, 0, 5)
}
```

#### Problem 5: Subreddit Feed Aggregation with Personalization (Medium)

*Build a personalized home feed that aggregates posts from subscribed subreddits with diversity controls.*

```go
package main

import (
	"fmt"
	"slices"
	"time"
)

type SubredditPost struct {
	PostID    string
	Subreddit string
	Score     int
	CreatedAt time.Time
	HotScore  float64
}

type UserFeedConfig struct {
	UserID          string
	Subscriptions   []string
	MaxPerSubreddit int // diversity control
}

// AggregateHomeFeed merges posts from subscribed subreddits with diversity.
func AggregateHomeFeed(
	allPosts []SubredditPost,
	cfg UserFeedConfig,
	limit int,
) []SubredditPost {
	// Filter to subscribed subreddits
	subSet := make(map[string]bool)
	for _, s := range cfg.Subscriptions {
		subSet[s] = true
	}

	var eligible []SubredditPost
	for _, p := range allPosts {
		if subSet[p.Subreddit] {
			eligible = append(eligible, p)
		}
	}

	// Sort by hot score descending
	slices.SortFunc(eligible, func(a, b SubredditPost) int {
		if a.HotScore > b.HotScore { return -1 } else if a.HotScore < b.HotScore { return 1 }
		return 0
	})

	// Apply diversity: max N posts per subreddit
	subCount := make(map[string]int)
	var result []SubredditPost
	for _, p := range eligible {
		if len(result) >= limit {
			break
		}
		if subCount[p.Subreddit] >= cfg.MaxPerSubreddit {
			continue
		}
		result = append(result, p)
		subCount[p.Subreddit]++
	}
	return result
}

func main() {
	now := time.Now()
	posts := []SubredditPost{
		{PostID: "p1", Subreddit: "r/golang", Score: 5000, CreatedAt: now.Add(-2 * time.Hour), HotScore: 18.5},
		{PostID: "p2", Subreddit: "r/golang", Score: 3000, CreatedAt: now.Add(-4 * time.Hour), HotScore: 17.2},
		{PostID: "p3", Subreddit: "r/golang", Score: 1000, CreatedAt: now.Add(-1 * time.Hour), HotScore: 16.8},
		{PostID: "p4", Subreddit: "r/programming", Score: 8000, CreatedAt: now.Add(-3 * time.Hour), HotScore: 19.1},
		{PostID: "p5", Subreddit: "r/programming", Score: 600, CreatedAt: now.Add(-30 * time.Minute), HotScore: 15.9},
		{PostID: "p6", Subreddit: "r/technology", Score: 2000, CreatedAt: now.Add(-1 * time.Hour), HotScore: 17.8},
	}

	cfg := UserFeedConfig{
		UserID:          "user123",
		Subscriptions:   []string{"r/golang", "r/programming", "r/technology"},
		MaxPerSubreddit: 2,
	}

	feed := AggregateHomeFeed(posts, cfg, 5)
	fmt.Println("Personalized home feed (max 2 per subreddit):")
	for i, p := range feed {
		fmt.Printf("  #%d [hot=%.1f] %-20s %s\n", i+1, p.HotScore, p.Subreddit, p.PostID)
	}
}
```

#### Problem 6: Vote Fraud Detection (Medium)

*Detect vote manipulation (brigading, bot voting rings) using velocity and IP analysis.*

```go
package main

import (
	"fmt"
	"time"
)

type VoteEvent struct {
	UserID    string
	PostID    string
	Direction int
	Timestamp time.Time
	IP        string
}

type VoteFraudDetector struct {
	votesByPost   map[string][]VoteEvent
	votesByUser   map[string][]VoteEvent
	window        time.Duration
	maxVotesPerPost int    // max votes on one post from same subnet
}

func NewVoteFraudDetector(window time.Duration, maxVotesPerPost int) *VoteFraudDetector {
	return &VoteFraudDetector{
		votesByPost:     make(map[string][]VoteEvent),
		votesByUser:     make(map[string][]VoteEvent),
		window:          window,
		maxVotesPerPost: maxVotesPerPost,
	}
}

type FraudSignal struct {
	Reason string
	Score  int
}

func ipSubnet(ip string) string {
	// Simplified: use first 3 octets as /24 subnet
	for i := len(ip) - 1; i >= 0; i-- {
		if ip[i] == '.' {
			return ip[:i]
		}
	}
	return ip
}

func (fd *VoteFraudDetector) Evaluate(ev VoteEvent) []FraudSignal {
	now := ev.Timestamp
	cutoff := now.Add(-fd.window)
	var signals []FraudSignal

	// Record event
	fd.votesByPost[ev.PostID] = append(fd.votesByPost[ev.PostID], ev)
	fd.votesByUser[ev.UserID] = append(fd.votesByUser[ev.UserID], ev)

	// Check 1: Many votes on same post from same /24 subnet
	subnet := ipSubnet(ev.IP)
	sameSubnetCount := 0
	for _, v := range fd.votesByPost[ev.PostID] {
		if v.Timestamp.After(cutoff) && ipSubnet(v.IP) == subnet {
			sameSubnetCount++
		}
	}
	if sameSubnetCount > fd.maxVotesPerPost {
		signals = append(signals, FraudSignal{
			Reason: fmt.Sprintf("brigading: %d votes from subnet %s.0/24 in %v", sameSubnetCount, subnet, fd.window),
			Score:  70,
		})
	}

	// Check 2: Single user voting on many posts rapidly (bot behavior)
	recentUserVotes := 0
	for _, v := range fd.votesByUser[ev.UserID] {
		if v.Timestamp.After(cutoff) {
			recentUserVotes++
		}
	}
	if recentUserVotes > 50 {
		signals = append(signals, FraudSignal{
			Reason: fmt.Sprintf("high vote velocity: %d votes in %v", recentUserVotes, fd.window),
			Score:  60,
		})
	}

	return signals
}

func main() {
	detector := NewVoteFraudDetector(10*time.Minute, 5)
	now := time.Now()
	postID := "t3_xyz789"

	// Simulate brigading: 8 votes from same /24 subnet
	for i := range 8 {
		ev := VoteEvent{
			UserID:    fmt.Sprintf("bot_%d", i),
			PostID:    postID,
			Direction: 1,
			Timestamp: now.Add(time.Duration(i) * time.Second),
			IP:        fmt.Sprintf("192.168.1.%d", 100+i),
		}
		signals := detector.Evaluate(ev)
		if len(signals) > 0 {
			fmt.Printf("Vote %d from %s: FRAUD SIGNALS:\n", i+1, ev.IP)
			for _, s := range signals {
				fmt.Printf("  [score=%d] %s\n", s.Score, s.Reason)
			}
		}
	}
}
```

#### Problem 7: Subreddit Moderator Action Log (Medium)

*Build an immutable audit log for moderator actions - required for transparency and appeals.*

```go
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

type ModAction struct {
	ID          string
	Subreddit   string
	ModID       string
	ActionType  string // "remove_post", "ban_user", "approve_comment"
	TargetID    string
	Reason      string
	Timestamp   time.Time
	PrevHash    string // links to previous entry (chain)
}

func (a ModAction) Hash() string {
	data := fmt.Sprintf("%s|%s|%s|%s|%s|%s|%s|%s",
		a.ID, a.Subreddit, a.ModID, a.ActionType, a.TargetID, a.Reason,
		a.Timestamp.Format(time.RFC3339Nano), a.PrevHash)
	h := sha256.Sum256([]byte(data))
	return hex.EncodeToString(h[:])
}

type ModActionLog struct {
	entries  []ModAction
	lastHash string
	nextID   int
}

func (l *ModActionLog) Append(subreddit, modID, actionType, targetID, reason string) ModAction {
	l.nextID++
	action := ModAction{
		ID:         fmt.Sprintf("mod_%06d", l.nextID),
		Subreddit:  subreddit,
		ModID:      modID,
		ActionType: actionType,
		TargetID:   targetID,
		Reason:     reason,
		Timestamp:  time.Now(),
		PrevHash:   l.lastHash,
	}
	l.lastHash = action.Hash()
	l.entries = append(l.entries, action)
	return action
}

func (l *ModActionLog) Verify() bool {
	prevHash := ""
	for _, e := range l.entries {
		if e.PrevHash != prevHash {
			return false
		}
		prevHash = e.Hash()
	}
	return true
}

func main() {
	log := &ModActionLog{}

	a1 := log.Append("r/golang", "mod_alice", "remove_post", "t3_abc123", "spam")
	a2 := log.Append("r/golang", "mod_alice", "ban_user", "spammer123", "repeated spam")
	a3 := log.Append("r/golang", "mod_bob", "approve_comment", "t1_def456", "false positive")

	fmt.Printf("Log entries: %d\n", len(log.entries))
	for _, a := range []ModAction{a1, a2, a3} {
		fmt.Printf("  [%s] %s by %s: %s → %s\n", a.ID, a.ActionType, a.ModID, a.TargetID, a.Reason)
	}
	fmt.Printf("Log integrity: %v\n", log.Verify())

	// Tamper with the log
	log.entries[0].Reason = "TAMPERED"
	fmt.Printf("Tampered integrity: %v\n", log.Verify())
}
```

#### Problem 8: Cross-Subreddit Content Deduplication (Hard)

*Detect duplicate or near-duplicate posts being spammed across multiple subreddits using MinHash.*

```go
package main

import (
	"fmt"
	"hash/fnv"
	"math"
	"strings"
)

// MinHashSignature generates a minhash signature for near-duplicate detection.
type MinHashSignature struct {
	signatures []uint32
	numHashes  int
}

func NewMinHashSignature(text string, numHashes int) *MinHashSignature {
	// Create k-shingles (3-word n-grams)
	words := strings.Fields(strings.ToLower(text))
	shingles := make(map[string]bool)
	for i := 0; i+2 < len(words); i++ {
		shingles[words[i]+" "+words[i+1]+" "+words[i+2]] = true
	}
	if len(shingles) == 0 && len(words) > 0 {
		shingles[strings.Join(words, " ")] = true
	}

	sigs := make([]uint32, numHashes)
	for i := range sigs {
		sigs[i] = math.MaxUint32
	}

	for shingle := range shingles {
		for seed := range numHashes {
			h := fnv.New32a()
			_, _ = h.Write([]byte(fmt.Sprintf("%d:%s", seed, shingle)))
			hv := h.Sum32()
			if hv < sigs[seed] {
				sigs[seed] = hv
			}
		}
	}
	return &MinHashSignature{sigs, numHashes}
}

// JaccardEstimate estimates Jaccard similarity between two MinHash signatures.
func JaccardEstimate(a, b *MinHashSignature) float64 {
	if len(a.signatures) != len(b.signatures) {
		return 0
	}
	matches := 0
	for i := range a.signatures {
		if a.signatures[i] == b.signatures[i] {
			matches++
		}
	}
	return float64(matches) / float64(len(a.signatures))
}

type DuplicateDetector struct {
	posts map[string]*MinHashSignature
	threshold float64
}

func NewDuplicateDetector(threshold float64) *DuplicateDetector {
	return &DuplicateDetector{
		posts:     make(map[string]*MinHashSignature),
		threshold: threshold,
	}
}

type DupCheckResult struct {
	IsDuplicate bool
	SimilarTo   string
	Similarity  float64
}

func (dd *DuplicateDetector) Check(postID, text string) DupCheckResult {
	sig := NewMinHashSignature(text, 128)

	for existingID, existingSig := range dd.posts {
		sim := JaccardEstimate(sig, existingSig)
		if sim >= dd.threshold {
			return DupCheckResult{true, existingID, sim}
		}
	}
	dd.posts[postID] = sig
	return DupCheckResult{false, "", 0}
}

func main() {
	detector := NewDuplicateDetector(0.7)

	posts := []struct{ id, text string }{
		{"p1", "Breaking: Scientists discover new species of bird in Amazon rainforest with unique blue feathers"},
		{"p2", "Scientists have discovered a new species of bird in the Amazon rainforest featuring unique blue feathers"},
		{"p3", "My cat just knocked over my coffee and now my keyboard is ruined. Monday morning be like"},
		{"p4", "Amazon rainforest discovery: Scientists find new bird species with distinctive blue feathers"},
	}

	for _, p := range posts {
		result := detector.Check(p.id, p.text)
		if result.IsDuplicate {
			fmt.Printf("DUPLICATE: %s is %.0f%% similar to %s\n", p.id, result.Similarity*100, result.SimilarTo)
		} else {
			fmt.Printf("UNIQUE:    %s stored\n", p.id)
		}
	}
}
```

#### Problem 9: Reddit Awards and Karma System (Hard)

*Implement Reddit's karma and awards system with anti-inflation controls.*

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

type Award struct {
	Type         string
	KarmaBonus   int
	CoinCost     int
	CoinToAuthor int
}

var awards = map[string]Award{
	"helpful":  {"helpful", 10, 100, 50},
	"gold":     {"gold", 100, 500, 250},
	"platinum": {"platinum", 500, 1800, 900},
}

type UserAccount struct {
	UserID       string
	PostKarma    int
	CommentKarma int
	Coins        int
}

type Post struct {
	PostID string
	AuthorID string
	Karma    int
}

type KarmaSystem struct {
	mu      sync.Mutex
	users   map[string]*UserAccount
	posts   map[string]*Post
	events  []string // audit log
}

func NewKarmaSystem() *KarmaSystem {
	return &KarmaSystem{
		users: make(map[string]*UserAccount),
		posts: make(map[string]*Post),
	}
}

func (ks *KarmaSystem) RegisterUser(userID string, startCoins int) {
	ks.mu.Lock()
	defer ks.mu.Unlock()
	ks.users[userID] = &UserAccount{UserID: userID, Coins: startCoins}
}

func (ks *KarmaSystem) CreatePost(postID, authorID string) {
	ks.mu.Lock()
	defer ks.mu.Unlock()
	ks.posts[postID] = &Post{PostID: postID, AuthorID: authorID}
}

func (ks *KarmaSystem) Upvote(voterID, postID string) error {
	ks.mu.Lock()
	defer ks.mu.Unlock()
	post, ok := ks.posts[postID]
	if !ok {
		return fmt.Errorf("post not found: %s", postID)
	}
	post.Karma++
	author := ks.users[post.AuthorID]
	if author != nil {
		author.PostKarma++
	}
	ks.events = append(ks.events, fmt.Sprintf("[%s] %s upvoted %s", time.Now().Format("15:04:05"), voterID, postID))
	return nil
}

func (ks *KarmaSystem) GiveAward(giverID, recipientID, postID, awardType string) error {
	ks.mu.Lock()
	defer ks.mu.Unlock()

	award, ok := awards[awardType]
	if !ok {
		return fmt.Errorf("unknown award: %s", awardType)
	}
	giver := ks.users[giverID]
	if giver == nil {
		return fmt.Errorf("giver not found: %s", giverID)
	}
	if giver.Coins < award.CoinCost {
		return fmt.Errorf("insufficient coins: have %d need %d", giver.Coins, award.CoinCost)
	}

	giver.Coins -= award.CoinCost
	recipient := ks.users[recipientID]
	if recipient != nil {
		recipient.PostKarma += award.KarmaBonus
		recipient.Coins += award.CoinToAuthor
	}

	// 50% of coin cost to Reddit, 50% to author - standard model
	ks.events = append(ks.events, fmt.Sprintf("[award] %s gave %s to %s on %s", giverID, awardType, recipientID, postID))
	return nil
}

func (ks *KarmaSystem) Stats(userID string) string {
	ks.mu.Lock()
	defer ks.mu.Unlock()
	u := ks.users[userID]
	if u == nil {
		return "user not found"
	}
	return fmt.Sprintf("u/%s: post_karma=%d comment_karma=%d coins=%d", userID, u.PostKarma, u.CommentKarma, u.Coins)
}

func main() {
	ks := NewKarmaSystem()
	ks.RegisterUser("alice", 1000)
	ks.RegisterUser("bob", 2000)
	ks.CreatePost("p1", "alice")

	_ = ks.Upvote("bob", "p1")
	_ = ks.Upvote("carol", "p1")
	fmt.Println(ks.Stats("alice"))

	err := ks.GiveAward("bob", "alice", "p1", "gold")
	fmt.Printf("Give gold: err=%v\n", err)
	fmt.Println(ks.Stats("alice"))
	fmt.Println(ks.Stats("bob"))
}
```

#### Problem 10: Community Health Score (Hard)

*Compute a community health score for subreddits based on engagement, moderation activity, and toxicity signals.*

```go
package main

import (
	"fmt"
	"math"
)

type SubredditMetrics struct {
	Name              string
	ActiveUsers7d     int
	PostsPerDay       float64
	CommentsPerPost   float64
	UpvoteRatio       float64  // 0-1
	ModActionsPerDay  float64
	RemovalRate       float64  // % posts removed by mods
	ReportRate        float64  // % posts reported by users
	RetentionRate     float64  // % users who return in 30 days
}

type HealthScore struct {
	Subreddit   string
	Overall     float64 // 0-100
	Engagement  float64
	Quality     float64
	Safety      float64
	Retention   float64
	Grade       string
}

func ComputeHealthScore(m SubredditMetrics) HealthScore {
	// Engagement score: active users + posting/commenting frequency
	engagementRaw := math.Log1p(float64(m.ActiveUsers7d)/1000)*20 +
		math.Min(m.PostsPerDay/10, 1)*30 +
		math.Min(m.CommentsPerPost/20, 1)*50
	engagement := math.Min(engagementRaw, 100)

	// Quality score: high upvote ratio, low removal rate
	quality := m.UpvoteRatio*60 + math.Max(0, 1-m.RemovalRate)*40

	// Safety score: low report rate, appropriate mod action level
	// Very low mod action = unmoderated - very high = over-moderated
	modBalance := 1 - math.Abs(m.ModActionsPerDay-2)/10 // optimal ~2/day per 1000 users
	safety := math.Max(0, 1-m.ReportRate)*70 + math.Max(0, modBalance)*30

	// Retention score
	retention := m.RetentionRate * 100

	overall := engagement*0.25 + quality*0.30 + safety*0.25 + retention*0.20

	grade := "F"
	switch {
	case overall >= 90: grade = "A+"
	case overall >= 80: grade = "A"
	case overall >= 70: grade = "B"
	case overall >= 60: grade = "C"
	case overall >= 50: grade = "D"
	}

	return HealthScore{
		Subreddit:  m.Name,
		Overall:    overall,
		Engagement: engagement,
		Quality:    quality,
		Safety:     safety,
		Retention:  retention,
		Grade:      grade,
	}
}

func main() {
	subreddits := []SubredditMetrics{
		{Name: "r/golang", ActiveUsers7d: 50000, PostsPerDay: 15, CommentsPerPost: 12, UpvoteRatio: 0.92, ModActionsPerDay: 2, RemovalRate: 0.05, ReportRate: 0.02, RetentionRate: 0.65},
		{Name: "r/toxic_debate", ActiveUsers7d: 20000, PostsPerDay: 50, CommentsPerPost: 30, UpvoteRatio: 0.55, ModActionsPerDay: 0.1, RemovalRate: 0.01, ReportRate: 0.25, RetentionRate: 0.30},
		{Name: "r/dead_sub", ActiveUsers7d: 100, PostsPerDay: 0.2, CommentsPerPost: 1, UpvoteRatio: 0.85, ModActionsPerDay: 0, RemovalRate: 0.01, ReportRate: 0.01, RetentionRate: 0.20},
	}

	for _, s := range subreddits {
		h := ComputeHealthScore(s)
		fmt.Printf("%-20s grade=%-3s overall=%.1f engagement=%.1f quality=%.1f safety=%.1f retention=%.1f\n",
			h.Subreddit, h.Grade, h.Overall, h.Engagement, h.Quality, h.Safety, h.Retention)
	}
}
```

---

### System Design Topics

**Top 5 Reddit System Design Questions:**

1. **Design Reddit's Home Feed** - Aggregate and rank posts from 100K+ subscribed subreddits for 500M users. Topics: hot/best/top/new/rising algorithm selection, per-user personalization vs. community-based ranking, cache invalidation on vote changes, precomputed feeds vs. real-time assembly.

2. **Design the Reddit Voting System** - Handle 100M+ votes per day with fraud detection. Topics: vote deduplication (one vote per user per post), optimistic vote counting, eventual consistency for karma, anti-vote-manipulation (brigading, bot rings), karma score aggregation.

3. **Design Reddit Search** - Full-text search across 16 billion posts and comments. Topics: inverted index with timeliness scoring, subreddit-scoped search, distributed Elasticsearch, real-time indexing pipeline, query suggestion, safe search filtering.

4. **Design the Comment System** - Nested threaded comments with Wilson score ranking and lazy loading. Topics: tree storage (adjacency list vs. nested sets vs. closure table), comment collapse/expand, pagination for deep threads, real-time new comment notifications.

5. **Design Content Moderation Pipeline** - Detect and remove policy-violating content at scale. Topics: ML classifier pipeline, rule-based filters, hash matching (PhotoDNA for CSAM), modqueue management, appeals system, transparency reports.

---

### Behavioral Focus

Reddit's culture values **"Empowering Community," product curiosity, and pragmatic engineering.** Behavioral themes:

- **Product empathy:** "Tell me about a feature or product decision you pushed back on technically, and how you handled that conversation."
- **Community thinking:** "How do you approach building systems that need to serve millions of different communities with different norms?"
- **Trade-off reasoning:** "Describe a time you had to choose between technical elegance and shipping something that worked."
- **Anti-spam / trust & safety:** "How would you approach building a system to detect coordinated inauthentic behavior?"
- **Ownership:** "Tell me about a time you inherited a system that was poorly maintained. What did you do?"

---

### Insider Tips

**Common Mistakes:**
- Not knowing Reddit's actual ranking algorithms (Hot score, Wilson score for Best). Interviewers find it impressive when candidates know these - and obvious when they don't.
- Comment tree design: using a naive recursive tree that loads all comments at once on a post with 10,000 comments.
- Vote counting: not discussing eventual consistency or vote fraud detection.
- Not addressing the celebrity problem in feed aggregation (a post in r/AskReddit with 50K upvotes vs. a post in r/golang with 5K upvotes - how do you compare them?).

**Strong Hire Signals:**
- Mentioning Wilson score for comment ranking without prompting.
- Discussing the Hot algorithm's logarithmic time decay behavior.
- MinHash for near-duplicate post detection.
- Hybrid hot + personalization score in feed ranking.

**Red Flags:**
- Designing comment trees with eager loading (load all comments on every page load).
- Pure chronological vote counting without fraud detection.
- Not discussing eventual consistency for karma (vote counts don't need to be transactionally consistent).

---

### 8-Week Preparation Timeline

```
Week 1: Ranking Algorithm Foundations
  Mon-Tue: Reddit Hot score formula, Wilson score confidence intervals
  Wed-Thu: Decay functions (exponential, logarithmic), Bayesian ranking
  Fri:     Content-based vs. collaborative filtering for personalization
  Weekend: Implement all Reddit ranking algorithms (Hot, Best, Top, Rising)

Week 2: Voting & Community Systems
  Mon-Tue: Vote deduplication, eventual consistency in vote counting
  Wed-Thu: Vote fraud detection (brigading, bot rings, velocity)
  Fri:     Karma aggregation, anti-inflation controls
  Weekend: Build vote store + fraud detector in Go

Week 3: Algorithms - Trees & Graph Processing
  Mon-Fri: 2 problems/day - tree traversal, graph BFS/DFS, sliding window
  Weekend: Nested comment tree builder + Wilson score ranker

Week 4: System Design - Reddit Systems
  Mon-Tue: Design Reddit home feed (whiteboard)
  Wed-Thu: Design the voting system
  Fri:     Design the comment system
  Weekend: Mock system design interview

Week 5: Search & Content Moderation
  Mon-Tue: Inverted index, TF-IDF for post search
  Wed-Thu: Content moderation pipeline, ML classifier serving
  Fri:     MinHash for near-duplicate detection
  Weekend: Design Reddit search + moderation pipeline

Week 6: Go for Community Platforms
  Mon-Tue: Concurrent vote processing, optimistic locking
  Wed-Thu: Comment tree pagination, cursor-based pagination
  Fri:     Bloom filters for seen-content filtering
  Weekend: Build subreddit feed aggregator in Go

Week 7: Behavioral Prep
  Mon-Tue: 5 STAR stories - product empathy, community, trade-offs, anti-spam, ownership
  Wed:     Research Reddit's engineering blog
  Thu:     Mock behavioral interview
  Fri:     Practice explaining Reddit's ranking algorithms out loud
  Weekend: Full mock onsite

Week 8: Final Prep
  Mon-Tue: Review ranking algorithm edge cases
  Wed:     Full mock onsite (all rounds)
  Thu:     Rest, logistics
  Fri:     Light review only
```

---


### Junior → FAANG: Reddit Interview Preparation Basics

Reddit's engineering challenges center on its community-driven content platform: voting, ranking algorithms, subreddit-level moderation, and a massive volume of user-generated content. Key technical areas: the hot and best ranking algorithms (Wilson score interval for comments, time-decay scoring for posts), content delivery (serving media at scale with varying virality), and moderation tooling (automated and human-in-the-loop content review at scale). Reddit moved from Python monolith to Go-based microservices, making Go experience particularly relevant.

### Senior @ FAANG: Reddit Senior Engineer: Community Platform Scale and Ranking System Design

At the senior level, Reddit's ranking algorithm is a domain-specific engineering challenge: the score of a post or comment is a function of upvotes, downvotes, time since posting, and subreddit-specific parameters, and it must be recomputed in near-real-time as votes come in. The computational challenge is that a trending post can receive millions of votes in a few hours, and the ranking must update quickly enough to reflect current popularity without becoming a write bottleneck. Senior candidates should be able to discuss: approximate counters for high-write-rate vote tallying, lazy recomputation versus continuous recomputation trade-offs, and the subreddit isolation requirement (a viral post in one subreddit should not degrade performance for other subreddits). Reddit's content moderation platform is also a staff-level engineering domain: automated classifiers must run at ingest time on millions of posts per day, and the human review queue must be prioritized by risk level, which requires a robust scoring and routing system.

---
