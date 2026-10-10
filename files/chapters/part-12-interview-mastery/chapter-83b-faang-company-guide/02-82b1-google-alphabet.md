## 83B.1 Google (Alphabet)

```
┌───────────────────────────────────────────────────────────────────┐
│                    GOOGLE INTERVIEW PIPELINE                      │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  Application/Referral                                             │
│       │                                                           │
│       ▼                                                           │
│  Recruiter Screen (30 min)                                        │
│       │  - Experience overview, role alignment, timeline          │
│       ▼                                                           │
│  Technical Phone Screen (45 min)                                  │
│       │  - 1-2 coding problems on Google Docs                     │
│       ▼                                                           │
│  Virtual Onsite (4-5 rounds, 45 min each)                         │
│       │  - 2-3 Coding rounds                                      │
│       │  - 1 System Design round (L4+)                            │
│       │  - 1 Googleyness & Leadership round                       │
│       ▼                                                           │
│  Hiring Committee Review                                          │
│       │  - Independent review of interview packets                │
│       ▼                                                           │
│  Team Matching                                                    │
│       │  - 1:1 calls with potential teams                         │
│       ▼                                                           │
│  Senior VP Review (L5+)                                           │
│       │                                                           │
│       ▼                                                           │
│  Offer                                                            │
│  Timeline: 4-8 weeks typical, can extend to 12+                   │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Interview Process (2026)

Google's interview process is unique among FAANG companies because of its **hiring committee model**. Your interviewers provide structured feedback, but they do not make the hiring decision - a separate committee of senior engineers reviews all interview packets and makes an independent assessment. This has several important implications for your preparation:

1. **Written feedback matters more than rapport.** Unlike Amazon where your interviewer advocates for you, at Google your interviewer writes a packet that someone else reads. Your solutions must be clearly correct on paper, not just "the interviewer seemed happy."

2. **Consistency across rounds matters.** The hiring committee looks for consistent signal. One stellar round and one weak round is worse than four solid rounds.

3. **Team matching happens after the hire decision.** You are hired into Google, then matched to a team. This means you do not need to demonstrate domain expertise for a specific team during the interview - you need to demonstrate general engineering excellence.

The **phone screen** uses Google Docs (not an IDE) and lasts 45 minutes. Expect one medium or one medium plus one easy coding problem. The interviewer types the problem statement at the top of the doc, and you write code below. There is no syntax highlighting, no autocomplete, and no compiler. Your Go code must be correct enough to be convincing without running it.

The **onsite** consists of 4-5 rounds of 45 minutes each. For L4+ candidates, expect 2-3 coding rounds, 1 system design round, and 1 Googleyness & Leadership (G&L) round. For L3 candidates, system design may be replaced with an additional coding round. Each coding round typically has one problem with follow-ups that increase difficulty.

### What Google Tests

**Coding rounds** at Google emphasize:
- **Optimal solutions.** Google interviewers push you toward the theoretical lower bound. A correct O(n log n) solution when O(n) exists will typically receive "Lean No Hire" even if your code is perfect.
- **Clean, readable code.** Google reviews millions of lines of code internally, and readability is a core value. Messy code signals a poor code reviewer.
- **Edge case handling.** Empty inputs, single elements, integer overflow, nil pointers - Google interviewers systematically probe edge cases.
- **Testing awareness.** You may be asked to write test cases or describe how you would test your solution.

**System design rounds** at Google emphasize:
- **Scale.** Google thinks in billions of users, petabytes of data, and globally distributed systems. Your design must account for this from the start.
- **Google infrastructure awareness.** While you do not need to know internal systems, familiarity with concepts like Bigtable, Spanner, MapReduce, Borg (the predecessor to Kubernetes), and Pub/Sub demonstrates alignment.
- **Trade-off analysis.** Google values engineers who can articulate trade-offs quantitatively - "this adds 50ms P99 latency but reduces storage by 40%."

**Googleyness & Leadership** evaluates:
- **Navigating ambiguity.** Can you make progress when requirements are unclear?
- **Collaboration.** How do you handle disagreements? How do you give and receive feedback?
- **Pushing back constructively.** Google values engineers who challenge bad ideas respectfully.

### Go at Google

Go was created at Google by Robert Griesemer, Rob Pike, and Ken Thompson. Google is the spiritual home of Go, and many Google teams use Go as their primary language. When you interview at Google using Go, you are speaking the interviewer's native language on many teams.

**Key Google projects in Go:**
- **Kubernetes** - container orchestration, originally developed at Google
- **gVisor** - application kernel for container sandboxing
- **Bazel rules_go** - Go build rules for the Bazel build system
- **Internal infrastructure** - many internal services are written in Go
- **Vitess** - database clustering system for horizontal scaling of MySQL

**Go-specific questions you may encounter at Google:**

```go
// Question: Explain the Go scheduler's GMP model and how it affects
// the performance of this code.

package main

import (
	"fmt"
	"runtime"
	"sync"
)

func main() {
	runtime.GOMAXPROCS(4)
	var wg sync.WaitGroup
	results := make([]int, 1000)

	for i := 0; i < 1000; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			// CPU-bound work
			sum := 0
			for j := 0; j < 100000; j++ {
				sum += j
			}
			results[idx] = sum
		}(i)
	}

	wg.Wait()
	fmt.Println("Done, sample result:", results[0])
}

// Expected answer should cover:
// - G (goroutine), M (OS thread), P (logical processor) model
// - With GOMAXPROCS(4), there are 4 Ps, each with a local run queue
// - 1000 goroutines distributed across 4 Ps via work-stealing
// - CPU-bound work means goroutines won't yield voluntarily
// - Go 1.14+ has asynchronous preemption, so long-running goroutines
//   are preempted at safe points
// - Each results[idx] is on a separate index, so no data race
// - The slice header is read-only after creation, elements are
//   independent - this is safe without mutex
```

### Level Expectations

**L3 (Software Engineer II) - New Grad / 0-2 years:**
- Solve medium LeetCode problems optimally in 25 minutes
- Basic system design: design a URL shortener, design a rate limiter
- Demonstrate strong CS fundamentals: data structures, algorithms, complexity
- Show learning velocity and intellectual curiosity

**L4 (Software Engineer III) - 2-5 years:**
- Solve hard LeetCode problems with hints, medium problems optimally and quickly
- Moderate system design: design a chat system, design a web crawler at scale
- Show project ownership: led a feature end-to-end, made architectural decisions
- Demonstrate cross-team collaboration and mentorship

**L5 (Senior Software Engineer) - 5-10 years:**
- Solve hard LeetCode problems optimally, discuss multiple approaches and trade-offs
- Advanced system design: design Google Maps, design YouTube recommendation system
- Architecture decisions with measurable impact: "reduced latency by 40% by redesigning X"
- Cross-team influence: changed how other teams approach problems

**L6 (Staff Software Engineer) - 8-15+ years:**
- System design excellence: design at Google scale with deep understanding of distributed systems
- Organization-level impact: set technical direction for a product area
- Technical leadership: defined standards, created frameworks used by many teams
- Strategic thinking: connected technical decisions to business outcomes

### Top 20 Google Go Interview Questions with Solutions

#### Question 1: LRU Cache

*This is one of Google's most frequently asked questions. Implement a Least Recently Used cache with O(1) get and put operations.*

```go
package main

import (
	"container/list"
	"fmt"
)

// LRUCache implements a Least Recently Used cache with O(1) operations.
type LRUCache struct {
	capacity int
	items    map[int]*list.Element
	order    *list.List
}

type entry struct {
	key   int
	value int
}

// NewLRUCache creates a new LRU cache with the given capacity.
func NewLRUCache(capacity int) *LRUCache {
	return &LRUCache{
		capacity: capacity,
		items:    make(map[int]*list.Element, capacity),
		order:    list.New(),
	}
}

// Get retrieves a value from the cache. Returns -1 if not found.
func (c *LRUCache) Get(key int) int {
	elem, ok := c.items[key]
	if !ok {
		return -1
	}
	c.order.MoveToFront(elem)
	return elem.Value.(*entry).value
}

// Put adds or updates a key-value pair in the cache.
func (c *LRUCache) Put(key, value int) {
	if elem, ok := c.items[key]; ok {
		elem.Value.(*entry).value = value
		c.order.MoveToFront(elem)
		return
	}

	if c.order.Len() == c.capacity {
		oldest := c.order.Back()
		c.order.Remove(oldest)
		delete(c.items, oldest.Value.(*entry).key)
	}

	e := &entry{key: key, value: value}
	elem := c.order.PushFront(e)
	c.items[key] = elem
}

func main() {
	cache := NewLRUCache(2)
	cache.Put(1, 1)
	cache.Put(2, 2)
	fmt.Println(cache.Get(1)) // 1
	cache.Put(3, 3)           // evicts key 2
	fmt.Println(cache.Get(2)) // -1
	cache.Put(4, 4)           // evicts key 1
	fmt.Println(cache.Get(1)) // -1
	fmt.Println(cache.Get(3)) // 3
	fmt.Println(cache.Get(4)) // 4
}
```

**Google interviewer notes:** They will ask about concurrency safety. Here is the thread-safe version:

```go
package main

import (
	"container/list"
	"sync"
)

// ConcurrentLRUCache is a thread-safe LRU cache.
type ConcurrentLRUCache struct {
	mu       sync.RWMutex
	capacity int
	items    map[int]*list.Element
	order    *list.List
}

type cacheEntry struct {
	key   int
	value int
}

func NewConcurrentLRUCache(capacity int) *ConcurrentLRUCache {
	return &ConcurrentLRUCache{
		capacity: capacity,
		items:    make(map[int]*list.Element, capacity),
		order:    list.New(),
	}
}

func (c *ConcurrentLRUCache) Get(key int) (int, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	elem, ok := c.items[key]
	if !ok {
		return 0, false
	}
	c.order.MoveToFront(elem)
	return elem.Value.(*cacheEntry).value, true
}

func (c *ConcurrentLRUCache) Put(key, value int) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[key]; ok {
		elem.Value.(*cacheEntry).value = value
		c.order.MoveToFront(elem)
		return
	}

	if c.order.Len() == c.capacity {
		oldest := c.order.Back()
		c.order.Remove(oldest)
		delete(c.items, oldest.Value.(*cacheEntry).key)
	}

	e := &cacheEntry{key: key, value: value}
	elem := c.order.PushFront(e)
	c.items[key] = elem
}

// Note: We use a full Lock() even for Get() because MoveToFront
// mutates the list. A RWMutex with RLock for Get would be incorrect.
// For higher read throughput, consider sharded LRU caches.
```

#### Question 2: Word Ladder (BFS)

*Given two words and a dictionary, find the shortest transformation sequence length.*

```go
package main

import "fmt"

func ladderLength(beginWord, endWord string, wordList []string) int {
	wordSet := make(map[string]bool, len(wordList))
	for _, w := range wordList {
		wordSet[w] = true
	}
	if !wordSet[endWord] {
		return 0
	}

	// Bidirectional BFS for optimal performance
	beginSet := map[string]bool{beginWord: true}
	endSet := map[string]bool{endWord: true}
	visited := map[string]bool{beginWord: true}
	length := 1

	for len(beginSet) > 0 && len(endSet) > 0 {
		// Always expand the smaller frontier
		if len(beginSet) > len(endSet) {
			beginSet, endSet = endSet, beginSet
		}

		nextSet := make(map[string]bool)
		for word := range beginSet {
			chars := []byte(word)
			for i := 0; i < len(chars); i++ {
				original := chars[i]
				for c := byte('a'); c <= byte('z'); c++ {
					if c == original {
						continue
					}
					chars[i] = c
					candidate := string(chars)

					if endSet[candidate] {
						return length + 1
					}

					if wordSet[candidate] && !visited[candidate] {
						nextSet[candidate] = true
						visited[candidate] = true
					}
				}
				chars[i] = original
			}
		}

		beginSet = nextSet
		length++
	}

	return 0
}

func main() {
	words := []string{"hot", "dot", "dog", "lot", "log", "cog"}
	fmt.Println(ladderLength("hit", "cog", words)) // 5
}
```

#### Question 3: Median of Two Sorted Arrays

*Google frequently tests this - O(log(min(m, n))) binary search solution is expected.*

```go
package main

import (
	"fmt"
	"math"
)

func findMedianSortedArrays(nums1, nums2 []int) float64 {
	// Ensure nums1 is the shorter array
	if len(nums1) > len(nums2) {
		nums1, nums2 = nums2, nums1
	}

	m, n := len(nums1), len(nums2)
	low, high := 0, m
	halfLen := (m + n + 1) / 2

	for low <= high {
		i := (low + high) / 2
		j := halfLen - i

		var leftMax1, leftMax2 float64
		var rightMin1, rightMin2 float64

		if i == 0 {
			leftMax1 = math.Inf(-1)
		} else {
			leftMax1 = float64(nums1[i-1])
		}
		if j == 0 {
			leftMax2 = math.Inf(-1)
		} else {
			leftMax2 = float64(nums2[j-1])
		}
		if i == m {
			rightMin1 = math.Inf(1)
		} else {
			rightMin1 = float64(nums1[i])
		}
		if j == n {
			rightMin2 = math.Inf(1)
		} else {
			rightMin2 = float64(nums2[j])
		}

		if leftMax1 <= rightMin2 && leftMax2 <= rightMin1 {
			if (m+n)%2 == 1 {
				return math.Max(leftMax1, leftMax2)
			}
			return (math.Max(leftMax1, leftMax2) + math.Min(rightMin1, rightMin2)) / 2.0
		} else if leftMax1 > rightMin2 {
			high = i - 1
		} else {
			low = i + 1
		}
	}

	return 0.0
}

func main() {
	fmt.Println(findMedianSortedArrays([]int{1, 3}, []int{2}))    // 2.0
	fmt.Println(findMedianSortedArrays([]int{1, 2}, []int{3, 4})) // 2.5
}
```

#### Question 4: Design a Concurrent Rate Limiter

*Google loves this because it combines concurrency with system design thinking.*

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

// SlidingWindowRateLimiter implements a sliding window rate limiter.
type SlidingWindowRateLimiter struct {
	mu          sync.Mutex
	requests    []time.Time
	maxRequests int
	window      time.Duration
}

func NewSlidingWindowRateLimiter(maxRequests int, window time.Duration) *SlidingWindowRateLimiter {
	return &SlidingWindowRateLimiter{
		requests:    make([]time.Time, 0, maxRequests),
		maxRequests: maxRequests,
		window:      window,
	}
}

func (rl *SlidingWindowRateLimiter) Allow() bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	windowStart := now.Add(-rl.window)

	// Remove expired timestamps using binary search
	idx := 0
	for idx < len(rl.requests) && rl.requests[idx].Before(windowStart) {
		idx++
	}
	rl.requests = rl.requests[idx:]

	if len(rl.requests) >= rl.maxRequests {
		return false
	}

	rl.requests = append(rl.requests, now)
	return true
}

// TokenBucketRateLimiter implements a token bucket algorithm.
// Google interviewers often ask for this as a follow-up.
type TokenBucketRateLimiter struct {
	mu         sync.Mutex
	tokens     float64
	maxTokens  float64
	refillRate float64 // tokens per second
	lastRefill time.Time
}

func NewTokenBucketRateLimiter(maxTokens, refillRate float64) *TokenBucketRateLimiter {
	return &TokenBucketRateLimiter{
		tokens:     maxTokens,
		maxTokens:  maxTokens,
		refillRate: refillRate,
		lastRefill: time.Now(),
	}
}

func (tb *TokenBucketRateLimiter) Allow() bool {
	tb.mu.Lock()
	defer tb.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(tb.lastRefill).Seconds()
	tb.tokens += elapsed * tb.refillRate
	if tb.tokens > tb.maxTokens {
		tb.tokens = tb.maxTokens
	}
	tb.lastRefill = now

	if tb.tokens < 1 {
		return false
	}
	tb.tokens--
	return true
}

func main() {
	rl := NewSlidingWindowRateLimiter(5, time.Second)

	for i := 0; i < 10; i++ {
		fmt.Printf("Request %d: %v\n", i+1, rl.Allow())
	}

	tb := NewTokenBucketRateLimiter(5, 2)
	for i := 0; i < 10; i++ {
		fmt.Printf("Token bucket request %d: %v\n", i+1, tb.Allow())
	}
}
```

#### Question 5: Serialize and Deserialize Binary Tree

Serialization converts in-memory objects into a byte representation suitable for storage or transmission, and deserialization reconstructs the original object graph from that representation. The choice of format involves trade-offs between schema evolution, human readability, encoding size, and parse performance.
```go
package main

import (
	"fmt"
	"strconv"
	"strings"
)

type TreeNode struct {
	Val   int
	Left  *TreeNode
	Right *TreeNode
}

type Codec struct{}

func (c *Codec) Serialize(root *TreeNode) string {
	var sb strings.Builder
	c.serializeHelper(root, &sb)
	return sb.String()
}

func (c *Codec) serializeHelper(node *TreeNode, sb *strings.Builder) {
	if node == nil {
		sb.WriteString("#,")
		return
	}
	sb.WriteString(strconv.Itoa(node.Val))
	sb.WriteByte(',')
	c.serializeHelper(node.Left, sb)
	c.serializeHelper(node.Right, sb)
}

func (c *Codec) Deserialize(data string) *TreeNode {
	tokens := strings.Split(data, ",")
	idx := 0
	return c.deserializeHelper(tokens, &idx)
}

func (c *Codec) deserializeHelper(tokens []string, idx *int) *TreeNode {
	if *idx >= len(tokens) || tokens[*idx] == "#" {
		*idx++
		return nil
	}

	val, _ := strconv.Atoi(tokens[*idx])
	*idx++
	node := &TreeNode{Val: val}
	node.Left = c.deserializeHelper(tokens, idx)
	node.Right = c.deserializeHelper(tokens, idx)
	return node
}

func main() {
	root := &TreeNode{
		Val: 1,
		Left: &TreeNode{
			Val:   2,
			Left:  nil,
			Right: nil,
		},
		Right: &TreeNode{
			Val:   3,
			Left:  &TreeNode{Val: 4},
			Right: &TreeNode{Val: 5},
		},
	}

	codec := &Codec{}
	serialized := codec.Serialize(root)
	fmt.Println("Serialized:", serialized)

	deserialized := codec.Deserialize(serialized)
	fmt.Println("Root:", deserialized.Val)
	fmt.Println("Root.Right.Left:", deserialized.Right.Left.Val)
}
```

#### Question 6: Goroutine Pool with Work Stealing

*Google-specific: tests Go concurrency patterns deeply.*

```go
package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"
)

// Task represents a unit of work.
type Task func() error

// WorkerPool implements a fixed-size goroutine pool.
type WorkerPool struct {
	numWorkers  int
	taskQueue   chan Task
	wg          sync.WaitGroup
	ctx         context.Context
	cancel      context.CancelFunc
	tasksRun    atomic.Int64
	tasksFailed atomic.Int64
}

func NewWorkerPool(numWorkers, queueSize int) *WorkerPool {
	ctx, cancel := context.WithCancel(context.Background())
	return &WorkerPool{
		numWorkers: numWorkers,
		taskQueue:  make(chan Task, queueSize),
		ctx:        ctx,
		cancel:     cancel,
	}
}

func (wp *WorkerPool) Start() {
	for i := 0; i < wp.numWorkers; i++ {
		wp.wg.Add(1)
		go wp.worker(i)
	}
}

func (wp *WorkerPool) worker(id int) {
	defer wp.wg.Done()
	for {
		select {
		case <-wp.ctx.Done():
			return
		case task, ok := <-wp.taskQueue:
			if !ok {
				return
			}
			if err := task(); err != nil {
				wp.tasksFailed.Add(1)
			}
			wp.tasksRun.Add(1)
		}
	}
}

func (wp *WorkerPool) Submit(task Task) bool {
	select {
	case wp.taskQueue <- task:
		return true
	case <-wp.ctx.Done():
		return false
	}
}

func (wp *WorkerPool) Shutdown() {
	close(wp.taskQueue)
	wp.wg.Wait()
	wp.cancel()
}

func (wp *WorkerPool) Stats() (ran, failed int64) {
	return wp.tasksRun.Load(), wp.tasksFailed.Load()
}

func main() {
	pool := NewWorkerPool(4, 100)
	pool.Start()

	for i := 0; i < 50; i++ {
		taskID := i
		pool.Submit(func() error {
			duration := time.Duration(rand.IntN(100)) * time.Millisecond
			time.Sleep(duration)
			fmt.Printf("Task %d completed in %v\n", taskID, duration)
			return nil
		})
	}

	pool.Shutdown()
	ran, failed := pool.Stats()
	fmt.Printf("Tasks run: %d, failed: %d\n", ran, failed)
}
```

#### Question 7: Alien Dictionary (Topological Sort)

Structured logging outputs machine-parseable records that log aggregation systems can ingest and correlate with traces and metrics. The following example demonstrates attaching contextual fields to log entries for efficient filtering and analysis in production systems.

```go
package main

import "fmt"

func alienOrder(words []string) string {
	// Build adjacency list and in-degree map
	graph := make(map[byte]map[byte]bool)
	inDegree := make(map[byte]int)

	// Initialize all characters
	for _, word := range words {
		for i := 0; i < len(word); i++ {
			if graph[word[i]] == nil {
				graph[word[i]] = make(map[byte]bool)
			}
			inDegree[word[i]] += 0 // ensure key exists
		}
	}

	// Compare adjacent words to derive ordering
	for i := 0; i < len(words)-1; i++ {
		w1, w2 := words[i], words[i+1]
		// Check for invalid case: "abc" before "ab"
		if len(w1) > len(w2) && w1[:len(w2)] == w2 {
			return ""
		}
		for j := 0; j < len(w1) && j < len(w2); j++ {
			if w1[j] != w2[j] {
				if !graph[w1[j]][w2[j]] {
					graph[w1[j]][w2[j]] = true
					inDegree[w2[j]]++
				}
				break
			}
		}
	}

	// BFS topological sort (Kahn's algorithm)
	queue := make([]byte, 0)
	for ch, deg := range inDegree {
		if deg == 0 {
			queue = append(queue, ch)
		}
	}

	result := make([]byte, 0, len(inDegree))
	for len(queue) > 0 {
		ch := queue[0]
		queue = queue[1:]
		result = append(result, ch)
		for neighbor := range graph[ch] {
			inDegree[neighbor]--
			if inDegree[neighbor] == 0 {
				queue = append(queue, neighbor)
			}
		}
	}

	if len(result) != len(inDegree) {
		return "" // cycle detected
	}
	return string(result)
}

func main() {
	words := []string{"wrt", "wrf", "er", "ett", "rftt"}
	fmt.Println(alienOrder(words)) // "wertf"
}
```

#### Question 8: Design a Concurrent HashMap

Go's concurrency model is built on goroutines, lightweight threads managed by the Go runtime, and channels for safe communication between them. The following example demonstrates proper goroutine usage, illustrating how to launch concurrent work and coordinate results without introducing data races.

```go
package main

import (
	"fmt"
	"hash/fnv"
	"sync"
)

const defaultShardCount = 32

// ShardedMap is a concurrent hash map using shard-level locking.
type ShardedMap[K comparable, V any] struct {
	shards    []*mapShard[K, V]
	shardCount int
	hashFn     func(K) uint32
}

type mapShard[K comparable, V any] struct {
	mu    sync.RWMutex
	items map[K]V
}

func NewShardedMap[V any](hashFn func(string) uint32) *ShardedMap[string, V] {
	shards := make([]*mapShard[string, V], defaultShardCount)
	for i := range shards {
		shards[i] = &mapShard[string, V]{items: make(map[string]V)}
	}
	return &ShardedMap[string, V]{
		shards:     shards,
		shardCount: defaultShardCount,
		hashFn:     hashFn,
	}
}

func (m *ShardedMap[K, V]) getShard(key K) *mapShard[K, V] {
	hash := m.hashFn(key)
	return m.shards[hash%uint32(m.shardCount)]
}

func (m *ShardedMap[K, V]) Set(key K, value V) {
	shard := m.getShard(key)
	shard.mu.Lock()
	shard.items[key] = value
	shard.mu.Unlock()
}

func (m *ShardedMap[K, V]) Get(key K) (V, bool) {
	shard := m.getShard(key)
	shard.mu.RLock()
	val, ok := shard.items[key]
	shard.mu.RUnlock()
	return val, ok
}

func (m *ShardedMap[K, V]) Delete(key K) {
	shard := m.getShard(key)
	shard.mu.Lock()
	delete(shard.items, key)
	shard.mu.Unlock()
}

func (m *ShardedMap[K, V]) Len() int {
	total := 0
	for _, shard := range m.shards {
		shard.mu.RLock()
		total += len(shard.items)
		shard.mu.RUnlock()
	}
	return total
}

func fnvHash(key string) uint32 {
	h := fnv.New32a()
	h.Write([]byte(key))
	return h.Sum32()
}

func main() {
	m := NewShardedMap[int](fnvHash)
	m.Set("one", 1)
	m.Set("two", 2)

	if v, ok := m.Get("one"); ok {
		fmt.Println("one:", v)
	}

	m.Delete("one")
	fmt.Println("Length:", m.Len())
}
```

#### Question 9: Minimum Window Substring

Minimum Window Substring is a representative problem from this company's interview pool, testing the data structure and algorithm knowledge that the engineering team considers prerequisite for the role. The following Go solution demonstrates the optimal approach, with inline comments explaining the key insight that reduces time or space complexity relative to the brute-force alternative.

```go
package main

import (
	"fmt"
	"math"
)

func minWindow(s, t string) string {
	if len(s) == 0 || len(t) == 0 || len(s) < len(t) {
		return ""
	}

	need := make(map[byte]int)
	for i := 0; i < len(t); i++ {
		need[t[i]]++
	}

	have := make(map[byte]int)
	formed := 0
	required := len(need)

	left := 0
	minLen := math.MaxInt32
	minLeft := 0

	for right := 0; right < len(s); right++ {
		ch := s[right]
		have[ch]++
		if count, ok := need[ch]; ok && have[ch] == count {
			formed++
		}

		for formed == required {
			windowLen := right - left + 1
			if windowLen < minLen {
				minLen = windowLen
				minLeft = left
			}

			leftCh := s[left]
			have[leftCh]--
			if count, ok := need[leftCh]; ok && have[leftCh] < count {
				formed--
			}
			left++
		}
	}

	if minLen == math.MaxInt32 {
		return ""
	}
	return s[minLeft : minLeft+minLen]
}

func main() {
	fmt.Println(minWindow("ADOBECODEBANC", "ABC")) // "BANC"
	fmt.Println(minWindow("a", "a"))                // "a"
	fmt.Println(minWindow("a", "aa"))               // ""
}
```

#### Question 10: Implement a Trie with Concurrent Access

Go's concurrency model is built on goroutines, lightweight threads managed by the Go runtime, and channels for safe communication between them. The following example demonstrates proper goroutine usage, illustrating how to launch concurrent work and coordinate results without introducing data races.

```go
package main

import (
	"fmt"
	"sync"
)

type TrieNode struct {
	children [26]*TrieNode
	isEnd    bool
	mu       sync.RWMutex
}

type ConcurrentTrie struct {
	root *TrieNode
}

func NewConcurrentTrie() *ConcurrentTrie {
	return &ConcurrentTrie{root: &TrieNode{}}
}

func (t *ConcurrentTrie) Insert(word string) {
	node := t.root
	for _, ch := range word {
		idx := ch - 'a'
		node.mu.Lock()
		if node.children[idx] == nil {
			node.children[idx] = &TrieNode{}
		}
		next := node.children[idx]
		node.mu.Unlock()
		node = next
	}
	node.mu.Lock()
	node.isEnd = true
	node.mu.Unlock()
}

func (t *ConcurrentTrie) Search(word string) bool {
	node := t.root
	for _, ch := range word {
		idx := ch - 'a'
		node.mu.RLock()
		next := node.children[idx]
		node.mu.RUnlock()
		if next == nil {
			return false
		}
		node = next
	}
	node.mu.RLock()
	defer node.mu.RUnlock()
	return node.isEnd
}

func (t *ConcurrentTrie) StartsWith(prefix string) bool {
	node := t.root
	for _, ch := range prefix {
		idx := ch - 'a'
		node.mu.RLock()
		next := node.children[idx]
		node.mu.RUnlock()
		if next == nil {
			return false
		}
		node = next
	}
	return true
}

func main() {
	trie := NewConcurrentTrie()
	trie.Insert("apple")
	trie.Insert("app")
	fmt.Println(trie.Search("apple"))     // true
	fmt.Println(trie.Search("app"))       // true
	fmt.Println(trie.Search("ap"))        // false
	fmt.Println(trie.StartsWith("ap"))    // true
}
```

#### Questions 11-20: Brief Solutions

**Q11: Course Schedule II (Topological Sort)**

```go
func findOrder(numCourses int, prerequisites [][]int) []int {
	graph := make([][]int, numCourses)
	inDegree := make([]int, numCourses)

	for _, pre := range prerequisites {
		graph[pre[1]] = append(graph[pre[1]], pre[0])
		inDegree[pre[0]]++
	}

	queue := make([]int, 0)
	for i, deg := range inDegree {
		if deg == 0 {
			queue = append(queue, i)
		}
	}

	order := make([]int, 0, numCourses)
	for len(queue) > 0 {
		course := queue[0]
		queue = queue[1:]
		order = append(order, course)
		for _, next := range graph[course] {
			inDegree[next]--
			if inDegree[next] == 0 {
				queue = append(queue, next)
			}
		}
	}

	if len(order) != numCourses {
		return nil // cycle
	}
	return order
}
```

**Q12: Merge K Sorted Lists**

```go
import "container/heap"

type ListNode struct {
	Val  int
	Next *ListNode
}

type MinHeap []*ListNode

func (h MinHeap) Len() int            { return len(h) }
func (h MinHeap) Less(i, j int) bool  { return h[i].Val < h[j].Val }
func (h MinHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *MinHeap) Push(x any) { *h = append(*h, x.(*ListNode)) }
func (h *MinHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}

func mergeKLists(lists []*ListNode) *ListNode {
	h := &MinHeap{}
	for _, l := range lists {
		if l != nil {
			heap.Push(h, l)
		}
	}

	dummy := &ListNode{}
	curr := dummy
	for h.Len() > 0 {
		node := heap.Pop(h).(*ListNode)
		curr.Next = node
		curr = curr.Next
		if node.Next != nil {
			heap.Push(h, node.Next)
		}
	}
	return dummy.Next
}
```

**Q13: Number of Islands (BFS)**

```go
func numIslands(grid [][]byte) int {
	if len(grid) == 0 {
		return 0
	}
	rows, cols := len(grid), len(grid[0])
	count := 0
	dirs := [][2]int{{0, 1}, {0, -1}, {1, 0}, {-1, 0}}

	for r := 0; r < rows; r++ {
		for c := 0; c < cols; c++ {
			if grid[r][c] == '1' {
				count++
				queue := [][2]int{{r, c}}
				grid[r][c] = '0'
				for len(queue) > 0 {
					cell := queue[0]
					queue = queue[1:]
					for _, d := range dirs {
						nr, nc := cell[0]+d[0], cell[1]+d[1]
						if nr >= 0 && nr < rows && nc >= 0 && nc < cols && grid[nr][nc] == '1' {
							grid[nr][nc] = '0'
							queue = append(queue, [2]int{nr, nc})
						}
					}
				}
			}
		}
	}
	return count
}
```

**Q14: Trapping Rain Water**

```go
func trap(height []int) int {
	left, right := 0, len(height)-1
	leftMax, rightMax := 0, 0
	water := 0

	for left < right {
		if height[left] < height[right] {
			if height[left] >= leftMax {
				leftMax = height[left]
			} else {
				water += leftMax - height[left]
			}
			left++
		} else {
			if height[right] >= rightMax {
				rightMax = height[right]
			} else {
				water += rightMax - height[right]
			}
			right--
		}
	}
	return water
}
```

**Q15: Design an Iterator for Nested Integers**

```go
type NestedInteger struct {
	isInt  bool
	val    int
	list   []*NestedInteger
}

type NestedIterator struct {
	stack []int
	flat  []int
}

func NewNestedIterator(nestedList []*NestedInteger) *NestedIterator {
	ni := &NestedIterator{}
	ni.flatten(nestedList)
	return ni
}

func (ni *NestedIterator) flatten(list []*NestedInteger) {
	for _, item := range list {
		if item.isInt {
			ni.flat = append(ni.flat, item.val)
		} else {
			ni.flatten(item.list)
		}
	}
}

func (ni *NestedIterator) Next() int {
	val := ni.flat[0]
	ni.flat = ni.flat[1:]
	return val
}

func (ni *NestedIterator) HasNext() bool {
	return len(ni.flat) > 0
}
```

**Q16: Find All Anagrams in a String**

```go
func findAnagrams(s, p string) []int {
	if len(s) < len(p) {
		return nil
	}
	var pCount, sCount [26]int
	for i := 0; i < len(p); i++ {
		pCount[p[i]-'a']++
		sCount[s[i]-'a']++
	}

	var result []int
	if pCount == sCount {
		result = append(result, 0)
	}

	for i := len(p); i < len(s); i++ {
		sCount[s[i]-'a']++
		sCount[s[i-len(p)]-'a']--
		if sCount == pCount {
			result = append(result, i-len(p)+1)
		}
	}
	return result
}
```

**Q17: Longest Consecutive Sequence**

```go
func longestConsecutive(nums []int) int {
	set := make(map[int]bool, len(nums))
	for _, n := range nums {
		set[n] = true
	}

	longest := 0
	for n := range set {
		if !set[n-1] { // start of a sequence
			length := 1
			for set[n+length] {
				length++
			}
			if length > longest {
				longest = length
			}
		}
	}
	return longest
}
```

**Q18: Task Scheduler**

```go
func leastInterval(tasks []byte, n int) int {
	var freq [26]int
	maxFreq := 0
	for _, t := range tasks {
		freq[t-'A']++
		if freq[t-'A'] > maxFreq {
			maxFreq = freq[t-'A']
		}
	}

	maxCount := 0
	for _, f := range freq {
		if f == maxFreq {
			maxCount++
		}
	}

	intervals := (maxFreq-1)*(n+1) + maxCount
	if intervals < len(tasks) {
		return len(tasks)
	}
	return intervals
}
```

**Q19: Implement a Context-Aware Pipeline**

```go
package main

import (
	"context"
	"fmt"
	"time"
)

func generator(ctx context.Context, nums ...int) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out)
		for _, n := range nums {
			select {
			case out <- n:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

func square(ctx context.Context, in <-chan int) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out)
		for n := range in {
			select {
			case out <- n * n:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

func filter(ctx context.Context, in <-chan int, pred func(int) bool) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out)
		for n := range in {
			if pred(n) {
				select {
				case out <- n:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	nums := generator(ctx, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
	squared := square(ctx, nums)
	evens := filter(ctx, squared, func(n int) bool { return n%2 == 0 })

	for v := range evens {
		fmt.Println(v)
	}
}
```

**Q20: Design a Distributed ID Generator (Snowflake-like)**

```go
package main

import (
	"fmt"
	"sync"
	"time"
)

const (
	epoch         = int64(1704067200000) // 2024-01-01 00:00:00 UTC
	workerIDBits  = 10
	sequenceBits  = 12
	maxWorkerID   = (1 << workerIDBits) - 1
	maxSequence   = (1 << sequenceBits) - 1
	timeShift     = workerIDBits + sequenceBits
	workerIDShift = sequenceBits
)

type Snowflake struct {
	mu        sync.Mutex
	timestamp int64
	workerID  int64
	sequence  int64
}

func NewSnowflake(workerID int64) (*Snowflake, error) {
	if workerID < 0 || workerID > maxWorkerID {
		return nil, fmt.Errorf("worker ID must be between 0 and %d", maxWorkerID)
	}
	return &Snowflake{workerID: workerID}, nil
}

func (s *Snowflake) Generate() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().UnixMilli() - epoch

	if now == s.timestamp {
		s.sequence = (s.sequence + 1) & maxSequence
		if s.sequence == 0 {
			// Wait for next millisecond
			for now <= s.timestamp {
				now = time.Now().UnixMilli() - epoch
			}
		}
	} else {
		s.sequence = 0
	}

	s.timestamp = now
	return (now << timeShift) | (s.workerID << workerIDShift) | s.sequence
}

func main() {
	sf, _ := NewSnowflake(1)
	for i := 0; i < 5; i++ {
		id := sf.Generate()
		fmt.Printf("ID: %d (binary: %b)\n", id, id)
	}
}
```

### Preparation Timeline (8-12 weeks)

| Week | Focus | Daily Hours | Key Activities |
|------|-------|-------------|----------------|
| 1-2 | Foundations | 3-4h | Review Chapters 65-70 (arrays, strings, trees, graphs). Solve 5 medium LeetCode/day |
| 3-4 | Advanced DSA | 3-4h | Review Chapters 71-76 (DP, advanced graphs). Solve 3 hard LeetCode/day |
| 5-6 | System Design | 3-4h | Review Chapter 80. Practice 2 system design problems/week |
| 7-8 | Go Deep Dive | 2-3h | Review Parts 2-3 (concurrency, production). Practice Go-specific questions |
| 9-10 | Mock Interviews | 3-4h | 3 mock interviews/week (coding + system design). Record and review |
| 11-12 | Company Focus | 3-4h | Google-specific practice. G&L preparation. Review weak areas |


### Junior → FAANG: Preparing for Google Interviews

Google interviews are known for their emphasis on algorithmic problem-solving, system design, and the ambiguously defined Googleyness dimension. The coding bar at Google is high: medium-to-hard LeetCode questions under time pressure, with a focus on optimal solutions and clear reasoning. The system design bar at L4/L5 focuses on correctness and completeness of the high-level design. Know Google's evaluation dimensions: general cognitive ability, leadership, role-related knowledge, Googleyness. The most commonly underprepared is Googleyness, which probes for intellectual curiosity, comfort with ambiguity, and collaborative nature.

### Senior @ FAANG: Google L6 Interview: Complexity Bar and Bar-Raiser Dynamics

Google's L6 hiring bar is among the most rigorous in the industry. The bar-raiser role at Google is structural: one interviewer in the loop is designated as a bar-raiser whose vote is weighted heavily and who is specifically calibrated across many interview loops rather than just the target team. For L6 system design, the expectation is not just a correct design but a design that demonstrates scale awareness, deep knowledge of the trade-off space, and the ability to drive the conversation toward the most important technical questions. Google also uses a hiring committee review step where multiple reviewers evaluate the interview packet independently before a hire decision, which means your packet must read well in the absence of your personality. The implication is that your interview communication must be unusually clear, precise, and well-structured, because the person making the final call may not have been in the room with you.

---
