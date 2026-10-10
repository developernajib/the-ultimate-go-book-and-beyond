## 83B.3 Amazon

```
┌──────────────────────────────────────────────────────────────────┐
│                   AMAZON INTERVIEW PIPELINE                      │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Application/Referral                                            │
│       │                                                          │
│       ▼                                                          │
│  Online Assessment (2 problems, 90 min)                          │
│       │  - Coding problems + work simulation                     │
│       ▼                                                          │
│  Phone Screen (60 min)                                           │
│       │  - 1 coding problem + LP behavioral questions            │
│       ▼                                                          │
│  Onsite "Loop" (4-5 rounds, 60 min each)                         │
│       │  - 2 Coding rounds (each with LP questions)              │
│       │  - 1 System Design round (with LP questions)             │
│       │  - 1 Bar Raiser round (LP-focused + technical)           │
│       │  - 1 Hiring Manager round (LP + team fit)                │
│       ▼                                                          │
│  Debrief (interviewers + bar raiser)                             │
│       │  - Bar raiser has veto power                             │
│       ▼                                                          │
│  Offer                                                           │
│  Timeline: 2-4 weeks                                             │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Interview Process (2026)

Amazon's interview process is unique because of two elements: **Leadership Principles (LPs)** and the **Bar Raiser**. Every single round - including coding and system design - includes behavioral questions aligned to Amazon's 16 Leadership Principles. The Bar Raiser is a specially trained interviewer from outside the hiring team whose sole purpose is to ensure the hiring bar is maintained. The Bar Raiser has **veto power** - if they say no, you do not get an offer regardless of how well you did in other rounds.

Each round is 60 minutes (longer than Google or Meta), typically split as 35-40 minutes technical and 20-25 minutes behavioral. You cannot succeed at Amazon by being technically excellent but weak on behavioral stories. You need 8-12 well-prepared STAR stories mapped to specific LPs.

### Amazon's Leadership Principles

The 16 Leadership Principles (2026) and how they map to interview questions:

1. **Customer Obsession** - "Tell me about a time you went above and beyond for a customer/user"
2. **Ownership** - "Describe a time you took on something outside your area of responsibility"
3. **Invent and Simplify** - "Tell me about an innovative solution you proposed"
4. **Are Right, A Lot** - "Describe a time you had to make a decision with incomplete data"
5. **Learn and Be Curious** - "Tell me about a time you taught yourself something new for a project"
6. **Hire and Develop the Best** - "How have you mentored someone on your team?"
7. **Insist on the Highest Standards** - "Tell me about a time you refused to compromise on quality"
8. **Think Big** - "Describe a time you proposed a bold or ambitious solution"
9. **Bias for Action** - "Tell me about a time you made a decision without all the information"
10. **Frugality** - "How did you accomplish a goal with limited resources?"
11. **Earn Trust** - "Describe a time you had to deliver uncomfortable feedback"
12. **Dive Deep** - "Tell me about a time you found a root cause that others missed"
13. **Have Backbone. Disagree and Commit** - "Describe a time you disagreed with your manager"
14. **Deliver Results** - "Tell me about a time you delivered a project under tight deadlines"
15. **Strive to be Earth's Best Employer** - "How do you support the wellbeing of your team?"
16. **Success and Scale Bring Broad Responsibility** - "How do you consider broader impact?"

### What Amazon Tests

**Coding: Practical and working.**
- One problem per 35-minute window
- Amazon values code that compiles and handles edge cases
- Common patterns: arrays, strings, trees, graphs, BFS/DFS
- Less emphasis on algorithmic elegance, more on correctness

**System Design: AWS-aware.**
- Design an e-commerce platform, delivery routing system, recommendation engine
- Knowledge of AWS services (S3, DynamoDB, SQS, Lambda, Kinesis) is a significant advantage
- Focus on scalability, cost optimization, and operational excellence
- Expect questions about microservice communication patterns

**Behavioral (LP): The differentiator.**
- 20-25 minutes of every round is LP behavioral questions
- Use STAR format: Situation, Task, Action, Result
- Quantify results whenever possible ("reduced latency by 40%", "saved $200K/year")
- Prepare 2-3 stories per LP, with different stories for different LPs

### Go at Amazon

Go is widely used across Amazon's infrastructure:
- **AWS Lambda** - Go runtime is a first-class citizen
- **AWS CDK** - Go constructs for infrastructure as code
- **Container services** - ECS, EKS tooling
- **Internal microservices** - many teams have adopted Go for new services
- **Firecracker** - while written in Rust, surrounding tooling includes Go components

### Level Expectations

**SDE I (L4) - 0-2 years:**
- Solve medium problems consistently, handle edge cases
- Basic system design: design a parking lot, design a library system
- 3-4 LP stories, demonstrate Customer Obsession and Ownership

**SDE II (L5) - 2-5 years:**
- Solve medium-hard problems with optimal approaches
- Design distributed systems: design a notification service, design order processing
- 6-8 LP stories covering diverse principles
- Demonstrate leading a feature or component

**SDE III / Senior (L6) - 5-10 years:**
- Solve hard problems and discuss multiple approaches
- Design complex systems at AWS scale
- 10-12 LP stories with quantified impact
- Demonstrate org-level technical influence

**Principal Engineer (L7) - 10+ years:**
- System design at planetary scale
- Technical vision and strategy
- Cross-organizational impact

### Top 20 Amazon Interview Questions with Solutions

#### Question 1: Two Sum (Amazon's Most Asked)

Two Sum (Amazon's Most Asked) is a representative problem from this company's interview pool, testing the data structure and algorithm knowledge that the engineering team considers prerequisite for the role. The following Go solution demonstrates the optimal approach, with inline comments explaining the key insight that reduces time or space complexity relative to the brute-force alternative.

```go
func twoSum(nums []int, target int) []int {
	seen := make(map[int]int) // value -> index
	for i, n := range nums {
		complement := target - n
		if j, ok := seen[complement]; ok {
			return []int{j, i}
		}
		seen[n] = i
	}
	return nil
}
```

#### Question 2: Design an LRU Cache with TTL (Amazon Variant)

Caching trades memory for reduced latency on repeated computations or lookups, and is one of the highest-value optimizations available. The LRU+TTL variant uses a `container/list` for O(1) move-to-front and a `map` for O(1) key lookup, while each entry records an `expiresAt` timestamp so that a `Get` that finds an expired entry treats it as a miss and evicts it, combining recency-based eviction with bounded staleness in a single data structure.

```go
package main

import (
	"container/list"
	"sync"
	"time"
)

type TTLEntry struct {
	key       string
	value     any
	expiresAt time.Time
}

type TTLLRUCache struct {
	mu       sync.Mutex
	capacity int
	ttl      time.Duration
	items    map[string]*list.Element
	order    *list.List
}

func NewTTLLRUCache(capacity int, ttl time.Duration) *TTLLRUCache {
	cache := &TTLLRUCache{
		capacity: capacity,
		ttl:      ttl,
		items:    make(map[string]*list.Element, capacity),
		order:    list.New(),
	}
	go cache.cleanupLoop()
	return cache
}

func (c *TTLLRUCache) Get(key string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	elem, ok := c.items[key]
	if !ok {
		return nil, false
	}

	entry := elem.Value.(*TTLEntry)
	if time.Now().After(entry.expiresAt) {
		c.removeElement(elem)
		return nil, false
	}

	c.order.MoveToFront(elem)
	return entry.value, true
}

func (c *TTLLRUCache) Put(key string, value any) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[key]; ok {
		entry := elem.Value.(*TTLEntry)
		entry.value = value
		entry.expiresAt = time.Now().Add(c.ttl)
		c.order.MoveToFront(elem)
		return
	}

	if c.order.Len() >= c.capacity {
		oldest := c.order.Back()
		c.removeElement(oldest)
	}

	entry := &TTLEntry{
		key:       key,
		value:     value,
		expiresAt: time.Now().Add(c.ttl),
	}
	elem := c.order.PushFront(entry)
	c.items[key] = elem
}

func (c *TTLLRUCache) removeElement(elem *list.Element) {
	entry := elem.Value.(*TTLEntry)
	delete(c.items, entry.key)
	c.order.Remove(elem)
}

func (c *TTLLRUCache) cleanupLoop() {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		c.mu.Lock()
		now := time.Now()
		for elem := c.order.Back(); elem != nil; {
			entry := elem.Value.(*TTLEntry)
			if now.After(entry.expiresAt) {
				prev := elem.Prev()
				c.removeElement(elem)
				elem = prev
			} else {
				break
			}
		}
		c.mu.Unlock()
	}
}
```

#### Question 3: Number of Connected Components (Union-Find)

Number of Connected Components (Union-Find) is a representative problem from this company's interview pool, testing the data structure and algorithm knowledge that the engineering team considers prerequisite for the role. The following Go solution demonstrates the optimal approach, with inline comments explaining the key insight that reduces time or space complexity relative to the brute-force alternative.

```go
type UnionFind struct {
	parent []int
	rank   []int
	count  int
}

func NewUnionFind(n int) *UnionFind {
	parent := make([]int, n)
	rank := make([]int, n)
	for i := range parent {
		parent[i] = i
	}
	return &UnionFind{parent: parent, rank: rank, count: n}
}

func (uf *UnionFind) Find(x int) int {
	if uf.parent[x] != x {
		uf.parent[x] = uf.Find(uf.parent[x]) // path compression
	}
	return uf.parent[x]
}

func (uf *UnionFind) Union(x, y int) {
	rx, ry := uf.Find(x), uf.Find(y)
	if rx == ry {
		return
	}
	if uf.rank[rx] < uf.rank[ry] {
		rx, ry = ry, rx
	}
	uf.parent[ry] = rx
	if uf.rank[rx] == uf.rank[ry] {
		uf.rank[rx]++
	}
	uf.count--
}

func countComponents(n int, edges [][]int) int {
	uf := NewUnionFind(n)
	for _, e := range edges {
		uf.Union(e[0], e[1])
	}
	return uf.count
}
```

#### Question 4: Design a Priority Queue for Task Scheduling (AWS Lambda Style)

Design a Priority Queue for Task Scheduling (AWS Lambda Style) is a representative problem from this company's interview pool, testing the data structure and algorithm knowledge that the engineering team considers prerequisite for the role. The following Go solution demonstrates the optimal approach, with inline comments explaining the key insight that reduces time or space complexity relative to the brute-force alternative.

```go
package main

import (
	"container/heap"
	"fmt"
	"time"
)

type ScheduledTask struct {
	ID        string
	Priority  int
	ExecuteAt time.Time
	Handler   func() error
	Retries   int
	MaxRetry  int
}

type TaskQueue []*ScheduledTask

func (tq TaskQueue) Len() int { return len(tq) }
func (tq TaskQueue) Less(i, j int) bool {
	if tq[i].ExecuteAt.Equal(tq[j].ExecuteAt) {
		return tq[i].Priority > tq[j].Priority // higher priority first
	}
	return tq[i].ExecuteAt.Before(tq[j].ExecuteAt)
}
func (tq TaskQueue) Swap(i, j int)       { tq[i], tq[j] = tq[j], tq[i] }
func (tq *TaskQueue) Push(x any) { *tq = append(*tq, x.(*ScheduledTask)) }
func (tq *TaskQueue) Pop() any {
	old := *tq
	n := len(old)
	task := old[n-1]
	old[n-1] = nil
	*tq = old[:n-1]
	return task
}

type Scheduler struct {
	queue *TaskQueue
}

func NewScheduler() *Scheduler {
	tq := &TaskQueue{}
	heap.Init(tq)
	return &Scheduler{queue: tq}
}

func (s *Scheduler) Schedule(task *ScheduledTask) {
	heap.Push(s.queue, task)
}

func (s *Scheduler) ProcessNext() (*ScheduledTask, error) {
	if s.queue.Len() == 0 {
		return nil, fmt.Errorf("no tasks in queue")
	}

	task := heap.Pop(s.queue).(*ScheduledTask)
	now := time.Now()
	if task.ExecuteAt.After(now) {
		// Not ready yet, push back
		heap.Push(s.queue, task)
		return nil, fmt.Errorf("next task not ready until %v", task.ExecuteAt)
	}

	if err := task.Handler(); err != nil {
		task.Retries++
		if task.Retries < task.MaxRetry {
			task.ExecuteAt = time.Now().Add(time.Duration(task.Retries) * time.Second)
			heap.Push(s.queue, task)
			return task, fmt.Errorf("task %s failed (retry %d/%d): %w",
				task.ID, task.Retries, task.MaxRetry, err)
		}
		return task, fmt.Errorf("task %s exhausted retries: %w", task.ID, err)
	}
	return task, nil
}

func main() {
	scheduler := NewScheduler()
	scheduler.Schedule(&ScheduledTask{
		ID:       "task-1",
		Priority: 10,
		ExecuteAt: time.Now(),
		Handler:  func() error { fmt.Println("Executing task 1"); return nil },
		MaxRetry: 3,
	})

	task, err := scheduler.ProcessNext()
	if err != nil {
		fmt.Println("Error:", err)
	} else {
		fmt.Println("Completed:", task.ID)
	}
}
```

#### Question 5: Rotting Oranges (BFS - Amazon Classic)

Rotting Oranges (BFS - Amazon Classic) is a representative problem from this company's interview pool, testing the data structure and algorithm knowledge that the engineering team considers prerequisite for the role. The following Go solution demonstrates the optimal approach, with inline comments explaining the key insight that reduces time or space complexity relative to the brute-force alternative.

```go
func orangesRotting(grid [][]int) int {
	rows, cols := len(grid), len(grid[0])
	queue := make([][2]int, 0)
	fresh := 0

	for r := 0; r < rows; r++ {
		for c := 0; c < cols; c++ {
			if grid[r][c] == 2 {
				queue = append(queue, [2]int{r, c})
			} else if grid[r][c] == 1 {
				fresh++
			}
		}
	}

	if fresh == 0 {
		return 0
	}

	dirs := [][2]int{{0, 1}, {0, -1}, {1, 0}, {-1, 0}}
	minutes := 0

	for len(queue) > 0 {
		size := len(queue)
		for i := 0; i < size; i++ {
			cell := queue[i]
			for _, d := range dirs {
				nr, nc := cell[0]+d[0], cell[1]+d[1]
				if nr >= 0 && nr < rows && nc >= 0 && nc < cols && grid[nr][nc] == 1 {
					grid[nr][nc] = 2
					fresh--
					queue = append(queue, [2]int{nr, nc})
				}
			}
		}
		queue = queue[size:]
		minutes++
	}

	if fresh > 0 {
		return -1
	}
	return minutes - 1
}
```

#### Questions 6-20: Amazon Favorites

**Q6: Meeting Rooms II**

```go
import "slices"

func minMeetingRooms(intervals [][]int) int {
	starts := make([]int, len(intervals))
	ends := make([]int, len(intervals))
	for i, iv := range intervals {
		starts[i] = iv[0]
		ends[i] = iv[1]
	}
	slices.Sort(starts)
	slices.Sort(ends)

	rooms, endPtr := 0, 0
	for i := 0; i < len(starts); i++ {
		if starts[i] < ends[endPtr] {
			rooms++
		} else {
			endPtr++
		}
	}
	return rooms
}
```

**Q7: Word Search**

```go
func exist(board [][]byte, word string) bool {
	rows, cols := len(board), len(board[0])

	var dfs func(r, c, idx int) bool
	dfs = func(r, c, idx int) bool {
		if idx == len(word) {
			return true
		}
		if r < 0 || r >= rows || c < 0 || c >= cols || board[r][c] != word[idx] {
			return false
		}
		tmp := board[r][c]
		board[r][c] = '#'
		found := dfs(r+1, c, idx+1) || dfs(r-1, c, idx+1) ||
			dfs(r, c+1, idx+1) || dfs(r, c-1, idx+1)
		board[r][c] = tmp
		return found
	}

	for r := 0; r < rows; r++ {
		for c := 0; c < cols; c++ {
			if dfs(r, c, 0) {
				return true
			}
		}
	}
	return false
}
```

**Q8: Maximal Square**

```go
func maximalSquare(matrix [][]byte) int {
	if len(matrix) == 0 {
		return 0
	}
	rows, cols := len(matrix), len(matrix[0])
	dp := make([][]int, rows+1)
	for i := range dp {
		dp[i] = make([]int, cols+1)
	}
	maxSide := 0

	for r := 1; r <= rows; r++ {
		for c := 1; c <= cols; c++ {
			if matrix[r-1][c-1] == '1' {
				dp[r][c] = min(dp[r-1][c], min(dp[r][c-1], dp[r-1][c-1])) + 1
				if dp[r][c] > maxSide {
					maxSide = dp[r][c]
				}
			}
		}
	}
	return maxSide * maxSide
}
```

**Q9: Min Cost to Connect All Points (Prim's)**

```go
import "container/heap"

type Edge struct {
	cost, node int
}
type EdgeHeap []Edge

func (h EdgeHeap) Len() int            { return len(h) }
func (h EdgeHeap) Less(i, j int) bool  { return h[i].cost < h[j].cost }
func (h EdgeHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *EdgeHeap) Push(x any) { *h = append(*h, x.(Edge)) }
func (h *EdgeHeap) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}

func minCostConnectPoints(points [][]int) int {
	n := len(points)
	visited := make([]bool, n)
	h := &EdgeHeap{{0, 0}}
	heap.Init(h)
	totalCost, connected := 0, 0

	for connected < n {
		e := heap.Pop(h).(Edge)
		if visited[e.node] {
			continue
		}
		visited[e.node] = true
		totalCost += e.cost
		connected++

		for j := 0; j < n; j++ {
			if !visited[j] {
				dist := abs(points[e.node][0]-points[j][0]) + abs(points[e.node][1]-points[j][1])
				heap.Push(h, Edge{dist, j})
			}
		}
	}
	return totalCost
}

func abs(x int) int { if x < 0 { return -x }; return x }
```

**Q10: Reorder Data in Log Files**

```go
import (
	"cmp"
	"slices"
	"strings"
)

func reorderLogFiles(logs []string) []string {
	var letterLogs, digitLogs []string

	for _, log := range logs {
		idx := strings.IndexByte(log, ' ')
		if log[idx+1] >= '0' && log[idx+1] <= '9' {
			digitLogs = append(digitLogs, log)
		} else {
			letterLogs = append(letterLogs, log)
		}
	}

	slices.SortStableFunc(letterLogs, func(a, b string) int {
		sa := strings.SplitN(a, " ", 2)
		sb := strings.SplitN(b, " ", 2)
		if c := cmp.Compare(sa[1], sb[1]); c != 0 {
			return c
		}
		return cmp.Compare(sa[0], sb[0])
	})

	return append(letterLogs, digitLogs...)
}
```

**Q11: Design a File System (Amazon favorite)**

```go
type FileSystem struct {
	children map[string]*FileSystem
	value    int
	isPath   bool
}

func NewFileSystem() *FileSystem {
	return &FileSystem{children: make(map[string]*FileSystem)}
}

func (fs *FileSystem) CreatePath(path string, value int) bool {
	parts := strings.Split(path, "/")[1:] // skip empty first element
	node := fs

	for i, part := range parts {
		if child, ok := node.children[part]; ok {
			if i == len(parts)-1 {
				return false // path already exists
			}
			node = child
		} else {
			if i < len(parts)-1 {
				return false // parent doesn't exist
			}
			node.children[part] = &FileSystem{
				children: make(map[string]*FileSystem),
				value:    value,
				isPath:   true,
			}
		}
	}
	return true
}

func (fs *FileSystem) Get(path string) int {
	parts := strings.Split(path, "/")[1:]
	node := fs
	for _, part := range parts {
		child, ok := node.children[part]
		if !ok {
			return -1
		}
		node = child
	}
	if !node.isPath {
		return -1
	}
	return node.value
}
```

**Q12-Q20: Additional Amazon Problems (Brief)**

```go
// Q12: Partition Labels
func partitionLabels(s string) []int {
	last := make(map[byte]int)
	for i := 0; i < len(s); i++ {
		last[s[i]] = i
	}
	var result []int
	start, end := 0, 0
	for i := 0; i < len(s); i++ {
		if last[s[i]] > end {
			end = last[s[i]]
		}
		if i == end {
			result = append(result, end-start+1)
			start = end + 1
		}
	}
	return result
}

// Q13: Top K Frequent Words
func topKFrequent(words []string, k int) []string {
	freq := make(map[string]int)
	for _, w := range words {
		freq[w]++
	}
	unique := make([]string, 0, len(freq))
	for w := range freq {
		unique = append(unique, w)
	}
	sort.Slice(unique, func(i, j int) bool {
		if freq[unique[i]] == freq[unique[j]] {
			return unique[i] < unique[j]
		}
		return freq[unique[i]] > freq[unique[j]]
	})
	return unique[:k]
}

// Q14: Maximum Units on a Truck
func maximumUnits(boxTypes [][]int, truckSize int) int {
	sort.Slice(boxTypes, func(i, j int) bool {
		return boxTypes[i][1] > boxTypes[j][1]
	})
	units := 0
	for _, box := range boxTypes {
		count := min(box[0], truckSize)
		units += count * box[1]
		truckSize -= count
		if truckSize == 0 {
			break
		}
	}
	return units
}

// Q15: Flood Fill
func floodFill(image [][]int, sr, sc, color int) [][]int {
	original := image[sr][sc]
	if original == color {
		return image
	}
	var fill func(r, c int)
	fill = func(r, c int) {
		if r < 0 || r >= len(image) || c < 0 || c >= len(image[0]) || image[r][c] != original {
			return
		}
		image[r][c] = color
		fill(r+1, c); fill(r-1, c); fill(r, c+1); fill(r, c-1)
	}
	fill(sr, sc)
	return image
}

// Q16: Search Suggestions System
func suggestedProducts(products []string, searchWord string) [][]string {
	slices.Sort(products)
	var result [][]string
	prefix := ""
	for _, ch := range searchWord {
		prefix += string(ch)
		idx := sort.SearchStrings(products, prefix)
		var suggestions []string
		for i := idx; i < len(products) && i < idx+3; i++ {
			if strings.HasPrefix(products[i], prefix) {
				suggestions = append(suggestions, products[i])
			} else {
				break
			}
		}
		result = append(result, suggestions)
	}
	return result
}

// Q17: Longest Palindromic Substring
func longestPalindrome(s string) string {
	start, maxLen := 0, 1
	expand := func(l, r int) {
		for l >= 0 && r < len(s) && s[l] == s[r] {
			if r-l+1 > maxLen {
				start = l
				maxLen = r - l + 1
			}
			l--
			r++
		}
	}
	for i := 0; i < len(s); i++ {
		expand(i, i)
		expand(i, i+1)
	}
	return s[start : start+maxLen]
}

// Q18: Minimum Difficulty of a Job Schedule
func minDifficulty(jobDifficulty []int, d int) int {
	n := len(jobDifficulty)
	if n < d {
		return -1
	}
	dp := make([][]int, d+1)
	for i := range dp {
		dp[i] = make([]int, n)
		for j := range dp[i] {
			dp[i][j] = math.MaxInt32
		}
	}
	dp[1][0] = jobDifficulty[0]
	for j := 1; j < n; j++ {
		dp[1][j] = max(dp[1][j-1], jobDifficulty[j])
	}
	for day := 2; day <= d; day++ {
		for j := day - 1; j < n; j++ {
			maxD := 0
			for k := j; k >= day-1; k-- {
				maxD = max(maxD, jobDifficulty[k])
				if dp[day-1][k-1] != math.MaxInt32 {
					dp[day][j] = min(dp[day][j], dp[day-1][k-1]+maxD)
				}
			}
		}
	}
	return dp[d][n-1]
}

// Q19: Subtree of Another Tree
func isSubtree(root, subRoot *TreeNode) bool {
	if root == nil {
		return false
	}
	if isSameTree(root, subRoot) {
		return true
	}
	return isSubtree(root.Left, subRoot) || isSubtree(root.Right, subRoot)
}

func isSameTree(p, q *TreeNode) bool {
	if p == nil && q == nil {
		return true
	}
	if p == nil || q == nil || p.Val != q.Val {
		return false
	}
	return isSameTree(p.Left, q.Left) && isSameTree(p.Right, q.Right)
}

// Q20: Design Browser History
type BrowserHistory struct {
	history []string
	current int
}

func NewBrowserHistory(homepage string) *BrowserHistory {
	return &BrowserHistory{history: []string{homepage}, current: 0}
}

func (bh *BrowserHistory) Visit(url string) {
	bh.history = bh.history[:bh.current+1]
	bh.history = append(bh.history, url)
	bh.current++
}

func (bh *BrowserHistory) Back(steps int) string {
	bh.current = max(0, bh.current-steps)
	return bh.history[bh.current]
}

func (bh *BrowserHistory) Forward(steps int) string {
	bh.current = min(len(bh.history)-1, bh.current+steps)
	return bh.history[bh.current]
}
```

### Preparation Timeline (8-10 weeks)

| Week | Focus | Daily Hours | Key Activities |
|------|-------|-------------|----------------|
| 1-2 | LP Stories | 2h | Write 12 STAR stories mapped to LPs. Practice delivery |
| 3-4 | Coding | 3-4h | Amazon's top 50 problems. Focus on BFS/DFS, arrays, strings |
| 5-6 | System Design | 3h | AWS-aware system design. Review Chapter 80 |
| 7-8 | Integration | 3-4h | Combined coding + LP rounds. Mock interviews |
| 9-10 | Polish | 2-3h | Weak areas. Final mock interviews with LP integration |


### Junior → FAANG: Preparing for Amazon Interviews

Amazon's interview process is the most explicitly principle-driven of the major FAANG companies. Every behavioral question maps to one or more of the 16 Leadership Principles, and interviewers score each LP dimension independently. The minimum bar for an Amazon behavioral interview is a strong story for every LP that is commonly probed: Customer Obsession, Ownership, Invent and Simplify, Are Right a Lot, Earn Trust, Dive Deep, Have Backbone Disagree and Commit, Deliver Results. Prepare a story bank organized by LP before starting the Amazon process.

### Senior @ FAANG: Amazon SDE-III and Principal Engineer: LP Depth and Technical Bar

At the SDE-III and Principal Engineer levels at Amazon, the behavioral assessment is as important as the technical assessment, and a weak LP score can result in a rejection even with strong technical performance. Amazon explicitly levels candidates on LP depth: SDE-III stories should reflect team-level impact and direct contributions to business metrics. Principal stories should reflect org-level impact, technology vision, and influence across multiple teams. The 'Dive Deep' LP is particularly probed at the Principal level: you should be able to go from a product-level discussion to the implementation details of any component you claim to have owned, in either direction, without warning. This requires genuine depth rather than surface-level familiarity. The 'Have Backbone' LP is probed for candidates who can demonstrate genuine disagreement with a senior stakeholder followed by full commitment after the decision: stories where you disagreed with a peer are weaker than stories where you disagreed with your VP or the product direction.

---
